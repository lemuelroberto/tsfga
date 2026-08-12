import {
  type ASTNode,
  Environment,
  type ParseResult,
} from "@marcbachmann/cel-js";
import {
  ConditionCompileError,
  ConditionEvaluationError,
  ConditionNotFoundError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type {
  ConditionParameterScalarType,
  ConditionParameterType,
  Tuple,
} from "./types.ts";

/**
 * The one CEL environment every expression is parsed in.
 *
 * `unlistedVariablesAreDyn` reproduces cel-js's module-level
 * `parse()` exactly — that is the single option its global
 * environment is built with — so introducing an environment of our
 * own changes nothing on its own. What it buys is
 * `registerFunction`, which is the only way to reach the overloads
 * cel-js does not ship and the only way to route an expression at
 * a tsfga-owned implementation.
 *
 * cel-js refuses to *replace* a built-in overload: registering
 * `string.matches(string): bool` or `int(double): int` raises
 * "overlaps with existing overload", and there is no option that
 * disables one. So the overloads registered here fall in two
 * groups:
 *
 * - **absent upstream of us** — `string(duration)` and
 *   `string(timestamp)` occupy no existing signature and simply
 *   register (issue 021).
 * - **tsfga-owned names** — `tsfga_int`, `tsfga_double` and
 *   `string.tsfga_re2_matches` cannot be written in a condition,
 *   because `compileCondition` is what puts them there: it parses
 *   the author's expression, rewrites `int(…)`, `double(…)` and
 *   `x.matches(…)` onto these names, and parses the result. See
 *   `rewriteCalls`.
 */
const env = new Environment({ unlistedVariablesAreDyn: true });

/**
 * Format a duration the way cel-go's `string(duration)` does:
 * total seconds with an `s` suffix, trailing fractional zeros
 * trimmed — `3600s`, `1.5s`, `-90s`.
 *
 * cel-go spells this `FormatFloat(d.Seconds(), 'f', -1, 64)`,
 * which is a float64 round trip. This works on the exact
 * nanosecond count instead, which agrees with it everywhere a
 * duration is representable and does not fall into JavaScript's
 * exponential notation, where Go's `'f'` never does.
 */
function formatCelDuration(totalNanos: bigint): string {
  const negative = totalNanos < 0n;
  const magnitude = negative ? -totalNanos : totalNanos;
  const whole = magnitude / 1_000_000_000n;
  const fraction = magnitude % 1_000_000_000n;
  let text = whole.toString();
  if (fraction !== 0n) {
    text += `.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
  }
  return `${negative ? "-" : ""}${text}s`;
}

/**
 * Format a timestamp the way cel-go's `string(timestamp)` does:
 * `time.RFC3339Nano`, which is RFC 3339 in UTC with the trailing
 * zeros of the fractional second removed and the point dropped
 * with them.
 *
 * A JS `Date` carries milliseconds, so agreement holds only at
 * millisecond resolution — the same boundary the sub-millisecond
 * timestamp divergence already draws.
 */
function formatCelTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/\.(\d*?)0*Z$/, (_match, digits: string) =>
      digits.length > 0 ? `.${digits}Z` : "Z",
    );
}

/**
 * A `bigint` field of a cel-js carrier object.
 *
 * Neither `UnsignedInt` nor `Duration` is exported from the
 * package root, so neither class is in reach for an `instanceof`.
 * What guarantees the shape is the overload signature — a handler
 * registered for `uint` is only ever called with a `uint` — so
 * this reads the field and refuses rather than asserting.
 */
function carriedField(value: unknown, field: string): bigint {
  if (typeof value === "object" && value !== null) {
    const read: unknown = Reflect.get(value, field);
    if (typeof read === "bigint") return read;
    if (typeof read === "number" && Number.isInteger(read)) return BigInt(read);
  }
  throw new Error(`expected a value carrying '${field}'`);
}

env.registerFunction(
  "string(google.protobuf.Duration): string",
  (value: unknown) =>
    formatCelDuration(
      carriedField(value, "seconds") * 1_000_000_000n +
        carriedField(value, "nanos"),
    ),
);
env.registerFunction(
  "string(google.protobuf.Timestamp): string",
  (value: Date) => formatCelTimestamp(value),
);

/**
 * `int()`, with the range checks cel-go applies and cel-js does
 * not (issue 023), plus the `int(uint)` overload cel-js has never
 * had — which the `uint` carrier below makes load-bearing (issue
 * 024).
 *
 * The `int(string)` and `int(int)` rows reproduce cel-js's own
 * behaviour rather than improving on it: this replaces the
 * function wholesale, so anything not restated here would be lost.
 */
env.registerFunction("tsfga_int(int): int", (value: bigint) => value);
env.registerFunction("tsfga_int(uint): int", (value: unknown) => {
  const parsed = carriedField(value, "value");
  if (parsed > INT64_MAX) {
    throw new Error("int() type error: integer overflow");
  }
  return parsed;
});
env.registerFunction("tsfga_int(double): int", (value: number) => {
  if (!Number.isFinite(value)) {
    throw new Error("int() type error: integer overflow");
  }
  const truncated = BigInt(Math.trunc(value));
  if (truncated < INT64_MIN || truncated > INT64_MAX) {
    throw new Error("int() type error: integer overflow");
  }
  return truncated;
});
env.registerFunction("tsfga_int(string): int", (value: string) => {
  if (value !== value.trim() || value.length > 20 || value.includes("0x")) {
    throw new Error("int() type error: cannot convert to int");
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error("int() type error: cannot convert to int");
  }
  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    throw new Error("int() type error: cannot convert to int");
  }
  return parsed;
});

/** A string Go's `ParseFloat` reads as a zero rather than as an
 *  underflow. Anything else that lands on zero left the float64
 *  range from below, which upstream reports as a range error. */
const DOUBLE_ZERO = /^[+-]?0*\.?0*([eE][+-]?\d+)?$/;

/**
 * `double()`, with the range check cel-go applies (issue 023).
 *
 * Go's `strconv.ParseFloat` returns `ErrRange` for a magnitude
 * outside float64 — in both directions — where `Number()` answers
 * `Infinity` and `0`. It does read the named infinities, so those
 * stay.
 */
env.registerFunction("tsfga_double(double): double", (value: number) => value);
env.registerFunction("tsfga_double(int): double", (value: bigint) =>
  Number(value),
);
env.registerFunction("tsfga_double(uint): double", (value: unknown) =>
  Number(carriedField(value, "value")),
);
env.registerFunction("tsfga_double(string): double", (value: string) => {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error("double() type error: cannot convert to double");
  }
  switch (value.toLowerCase()) {
    case "inf":
    case "+inf":
    case "infinity":
    case "+infinity":
      return Number.POSITIVE_INFINITY;
    case "-inf":
    case "-infinity":
      return Number.NEGATIVE_INFINITY;
    case "nan":
      return Number.NaN;
    default:
      break;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error("double() type error: cannot convert to double");
  }
  if (!Number.isFinite(parsed) || (parsed === 0 && !DOUBLE_ZERO.test(value))) {
    throw new Error("double() type error: value out of range");
  }
  return parsed;
});

env.registerFunction(
  "string.tsfga_re2_matches(string): bool",
  (value: string, pattern: string) => compileRe2(pattern).test(value),
);

/**
 * What a POSIX bracket class stands for, as RE2 defines it.
 *
 * A JavaScript `RegExp` reads `[[:alpha:]]` as a class of the
 * characters `[:alph`, which matches nothing an author meant and
 * errors nowhere — the silent half of issue 020.
 */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  ascii: "\\x00-\\x7F",
  blank: " \\t",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "\\x21-\\x7E",
  lower: "a-z",
  print: "\\x20-\\x7E",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\t\\n\\v\\f\\r ",
  upper: "A-Z",
  word: "0-9A-Za-z_",
  xdigit: "0-9A-Fa-f",
};

/** Leading inline flag groups: `(?i)`, `(?is)`, `(?U)`. */
const LEADING_FLAGS = /^\(\?([imsU]+)\)/;

/** `{2}`, `{2,}`, `{2,5}` — a repetition rather than a literal. */
const REPETITION = /^\{\d+(,\d*)?\}/;

/** `[:alpha:]` and its negated form, inside a bracket expression. */
const POSIX_CLASS = /^\[:(\^?)([a-z]+):\]/;

function refusePattern(pattern: string, reason: string): never {
  throw new Error(`error parsing regexp: ${reason}: \`${pattern}\``);
}

interface TranslatedPattern {
  source: string;
  flags: string;
  /** Whether the translation depends on the `u` flag's meaning. */
  needsUnicode: boolean;
}

/**
 * Rewrite an RE2 pattern as the nearest JavaScript one, or refuse.
 *
 * The two dialects are not a superset of one another, so this runs
 * in both directions:
 *
 * - RE2 spellings JavaScript cannot compile — the inline flags
 *   `(?i)` `(?s)` `(?m)` `(?U)` and the `(?P<name>` group — become
 *   flags and `(?<name>`. `(?U)` inverts every quantifier's
 *   greediness, which is what the flag means.
 * - spellings both compile and read differently — the POSIX
 *   classes, and `\pL` / `\p{L}`, which a `RegExp` without the `u`
 *   flag reads as a literal `p` — become their JavaScript
 *   equivalents. The expansion and the `u` flag land together
 *   because neither is right on its own.
 * - spellings JavaScript accepts and RE2 refuses — lookahead,
 *   lookbehind and backreferences — are refused here, turning what
 *   was a silent grant into the refusal upstream gives.
 *
 * Everything else passes through untouched.
 */
function translateRe2Pattern(pattern: string): TranslatedPattern {
  let flags = "";
  let ungreedy = false;
  let index = 0;

  for (;;) {
    const leading = LEADING_FLAGS.exec(pattern.slice(index));
    if (!leading) break;
    for (const flag of leading[1] ?? "") {
      if (flag === "U") ungreedy = true;
      else if (!flags.includes(flag)) flags += flag;
    }
    index += leading[0].length;
  }

  let source = "";
  let needsUnicode = false;

  /** Flip the quantifier just emitted, for `(?U)`. */
  const flipGreediness = () => {
    if (!ungreedy) return;
    if (pattern[index] === "?") index += 1;
    else source += "?";
  };

  /** A `\x` escape, in or out of a bracket expression. */
  const takeEscape = (inClass: boolean) => {
    const next = pattern[index + 1];
    if (next === undefined) refusePattern(pattern, "trailing backslash");
    if (!inClass && next >= "1" && next <= "9") {
      refusePattern(pattern, "invalid or unsupported Perl syntax");
    }
    if (next === "p" || next === "P") {
      needsUnicode = true;
      const after = pattern[index + 2];
      if (after !== undefined && after !== "{") {
        // `\pL` is RE2's one-letter spelling of `\p{L}`.
        source += `\\${next}{${after}}`;
        index += 3;
        return;
      }
    }
    source += pattern.slice(index, index + 2);
    index += 2;
  };

  const takeClass = () => {
    source += "[";
    index += 1;
    if (pattern[index] === "^") {
      source += "^";
      index += 1;
    }
    if (pattern[index] === "]") {
      source += "\\]";
      index += 1;
    }
    while (index < pattern.length && pattern[index] !== "]") {
      const char = pattern[index];
      if (char === "\\") {
        takeEscape(true);
      } else if (char === "[") {
        const posix = POSIX_CLASS.exec(pattern.slice(index));
        if (!posix) {
          // A bare `[` is a literal inside a class in RE2 and an
          // error under the `u` flag, so it is escaped.
          source += "\\[";
          index += 1;
          continue;
        }
        if (posix[1] === "^") {
          refusePattern(pattern, "unsupported negated POSIX class");
        }
        const expansion = POSIX_CLASSES[posix[2] ?? ""];
        if (expansion === undefined) {
          refusePattern(pattern, "invalid character class range");
        }
        source += expansion;
        index += posix[0].length;
      } else {
        source += char;
        index += 1;
      }
    }
    if (index >= pattern.length) {
      refusePattern(pattern, "missing closing ]");
    }
    source += "]";
    index += 1;
    flipGreediness();
  };

  const takeGroup = () => {
    if (!pattern.startsWith("(?", index)) {
      source += "(";
      index += 1;
      return;
    }
    if (pattern.startsWith("(?P<", index)) {
      source += "(?<";
      index += 4;
      return;
    }
    if (pattern.startsWith("(?:", index)) {
      source += "(?:";
      index += 3;
      return;
    }
    if (
      pattern.startsWith("(?=", index) ||
      pattern.startsWith("(?!", index) ||
      pattern.startsWith("(?<=", index) ||
      pattern.startsWith("(?<!", index) ||
      pattern.startsWith("(?P=", index)
    ) {
      // Valid JavaScript, invalid RE2. Refusing is what upstream
      // answers, and is the whole point of the granting direction.
      refusePattern(pattern, "invalid or unsupported Perl syntax");
    }
    if (pattern.startsWith("(?<", index)) {
      source += "(?<";
      index += 3;
      return;
    }
    // A flag group that is not at the very start applies to the
    // rest of its own group in RE2 and to the whole pattern in
    // JavaScript, and a scoped `(?i:…)` has no portable spelling.
    // Refusing is loud; translating would be quietly wrong.
    refusePattern(pattern, "unsupported inline group");
  };

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      takeEscape(false);
      flipGreediness();
      continue;
    }
    if (char === "[") {
      takeClass();
      continue;
    }
    if (char === "(") {
      takeGroup();
      continue;
    }
    if (char === "*" || char === "+" || char === "?") {
      source += char;
      index += 1;
      flipGreediness();
      continue;
    }
    if (char === "{") {
      const repetition = REPETITION.exec(pattern.slice(index));
      if (repetition) {
        source += repetition[0];
        index += repetition[0].length;
        flipGreediness();
        continue;
      }
    }
    source += char;
    index += 1;
    if (char === ")") flipGreediness();
  }

  return { source, flags, needsUnicode };
}

/**
 * Compiled patterns, keyed by the RE2 source the author wrote.
 *
 * Bounded for the same reason `exprCache` is: the pattern usually
 * arrives in the request context, so nothing about a caller's
 * lifetime releases it.
 */
const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_MAX_ENTRIES = 1000;

function compileRe2(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) {
    regexCache.delete(pattern);
    regexCache.set(pattern, cached);
    return cached;
  }

  const translated = translateRe2Pattern(pattern);
  let compiled: RegExp;
  try {
    compiled = new RegExp(translated.source, `${translated.flags}u`);
  } catch (error) {
    // The `u` flag is stricter than RE2 in a few places a pattern
    // may legitimately land in. Retrying without it is safe only
    // when the translation did not depend on what `u` means — a
    // `\p{L}` compiled without `u` is a literal `p`, which is the
    // silent wrong answer this whole path exists to close.
    if (translated.needsUnicode) {
      throw new Error(`error parsing regexp: \`${pattern}\``, { cause: error });
    }
    try {
      compiled = new RegExp(translated.source, translated.flags);
    } catch (fallbackError) {
      throw new Error(`error parsing regexp: \`${pattern}\``, {
        cause: fallbackError,
      });
    }
  }

  if (regexCache.size >= REGEX_CACHE_MAX_ENTRIES) {
    const oldest = regexCache.keys().next();
    if (!oldest.done) regexCache.delete(oldest.value);
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

/** Calls whose name is replaced, and what it is replaced with. */
const CALL_REWRITES: ReadonlyMap<string, string> = new Map([
  ["int", "tsfga_int"],
  ["double", "tsfga_double"],
]);

/** Receiver calls — `s.matches(r)` — under the same rule. */
const RECEIVER_REWRITES: ReadonlyMap<string, string> = new Map([
  ["matches", "tsfga_re2_matches"],
]);

/** One name replaced, as a half-open range of the source text. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Find every call this module owns an implementation for.
 *
 * The rewrite is a **source-text splice**, not an AST edit: only
 * the function's name moves, every other byte of the author's
 * expression survives untouched, and nothing depends on cel-js's
 * serializer round-tripping a literal the way it was written.
 */
function collectSplices(node: ASTNode, source: string, out: Splice[]): void {
  switch (node.op) {
    case "value":
    case "id":
      return;

    case ".":
    case ".?":
      collectSplices(node.args[0], source, out);
      return;

    case "!_":
    case "-_":
      collectSplices(node.args, source, out);
      return;

    case "[]":
    case "[?]":
    case "||":
    case "&&":
    case "==":
    case "!=":
    case "in":
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "<":
    case "<=":
    case ">":
    case ">=":
      collectSplices(node.args[0], source, out);
      collectSplices(node.args[1], source, out);
      return;

    case "?:":
      collectSplices(node.args[0], source, out);
      collectSplices(node.args[1], source, out);
      collectSplices(node.args[2], source, out);
      return;

    case "list":
      for (const item of node.args) collectSplices(item, source, out);
      return;

    case "map":
      for (const [key, value] of node.args) {
        collectSplices(key, source, out);
        collectSplices(value, source, out);
      }
      return;

    case "call": {
      const [name, args] = node.args;
      const replacement = CALL_REWRITES.get(name);
      // A `call` node starts at its own name, so the name is the
      // first `name.length` bytes of the node.
      if (
        replacement !== undefined &&
        args.length === 1 &&
        source.startsWith(name, node.range.start)
      ) {
        out.push({
          start: node.range.start,
          end: node.range.start + name.length,
          text: replacement,
        });
      }
      for (const argument of args) collectSplices(argument, source, out);
      return;
    }

    case "rcall": {
      const [name, receiver, args] = node.args;
      const replacement = RECEIVER_REWRITES.get(name);
      if (replacement !== undefined && args.length === 1) {
        // An `rcall` node starts at its receiver, so the name is
        // found after it — behind a `.` and nothing else. Anything
        // in between that is not whitespace means the source is
        // not shaped the way this assumes, and the call is left
        // alone rather than spliced blind.
        const start = source.indexOf(name, receiver.range.end);
        if (start !== -1) {
          const between = source.slice(receiver.range.end, start);
          if (/^\s*\.\s*$/.test(between)) {
            out.push({ start, end: start + name.length, text: replacement });
          }
        }
      }
      collectSplices(receiver, source, out);
      for (const argument of args) collectSplices(argument, source, out);
      return;
    }

    default:
      return;
  }
}

/**
 * The author's expression with every rewritten call renamed, or
 * the expression itself when there is nothing to rename.
 */
function rewriteCalls(expression: string, ast: ASTNode): string {
  const splices: Splice[] = [];
  collectSplices(ast, expression, splices);
  if (splices.length === 0) return expression;

  splices.sort((a, b) => b.start - a.start);
  let rewritten = expression;
  for (const splice of splices) {
    rewritten =
      rewritten.slice(0, splice.start) +
      splice.text +
      rewritten.slice(splice.end);
  }
  return rewritten;
}

/**
 * Cache compiled CEL expressions keyed by the expression source
 * text. Content keying makes staleness impossible: redefining a
 * condition with a new expression parses (and caches) the new
 * source, while identical expressions share one compiled entry —
 * even across condition names and stores.
 */
const exprCache = new Map<string, ParseResult>();

/**
 * How many compiled expressions the cache holds.
 *
 * The cache is process-wide and keyed by source text, so nothing
 * about a caller's lifetime releases it: a caller that writes many
 * condition definitions, or rewrites one repeatedly — each new
 * source text being a new key — grows it forever. Bounding it
 * costs nothing a model of ordinary size would notice, since a
 * model has one expression per condition and this holds a
 * thousand.
 *
 * Exported so a test can state the bound rather than hard-code it.
 */
export const EXPR_CACHE_MAX_ENTRIES = 1000;

/** Whether an expression is currently compiled. For tests. */
export function hasCompiledExpression(expression: string): boolean {
  return exprCache.has(expression);
}

/**
 * Compile an expression, or raise `ConditionCompileError`.
 *
 * The one place `parse` is called on a stored expression, so that
 * a parse failure has exactly one error class wherever it is
 * discovered. It used to be called outside the `try` that wraps
 * evaluation, which let cel-js's own `ParseError` — not a
 * `TsfgaError` — escape `check()`.
 */
export function compileCondition(
  conditionName: string,
  expression: string,
): ParseResult {
  const cached = exprCache.get(expression);
  if (cached) {
    // Re-insert so the iteration order is least-recently-used
    // first. Eviction by insertion order alone would drop the
    // hottest expression in a workload that cycles through more
    // than the bound, which is the case the bound exists for.
    exprCache.delete(expression);
    exprCache.set(expression, cached);
    return cached;
  }
  let compiled: ParseResult;
  try {
    compiled = env.parse(expression);
    const rewritten = rewriteCalls(expression, compiled.ast);
    if (rewritten !== expression) compiled = env.parse(rewritten);
  } catch (error) {
    throw new ConditionCompileError(conditionName, error);
  }
  if (exprCache.size >= EXPR_CACHE_MAX_ENTRIES) {
    const oldest = exprCache.keys().next();
    if (!oldest.done) exprCache.delete(oldest.value);
  }
  exprCache.set(expression, compiled);
  return compiled;
}

/** Pre-compiled coercion helper for duration strings */
const coerceDuration = env.parse("duration(val)");

/**
 * Pre-compiled carrier for `uint` context values.
 *
 * cel-js's `UnsignedInt` is not exported from the package root, so
 * `uint()` is how an instance is reached. Carrying a `uint` as
 * CEL's `int` instead — which is what this file used to do — made
 * its arithmetic overflow at int64 rather than uint64, made
 * `type(n) == uint` false, and left a bare `u`-suffixed literal
 * with no matching overload.
 */
const coerceUint = env.parse("uint(val)");

/**
 * Read a context value as its declared parameter type, or say why
 * it cannot be.
 *
 * A port of OpenFGA's `internal/condition/types/converters.go`,
 * because a `typeof` check diverges from it on six of the cases
 * probed against v1.18.2:
 *
 * | value | declared | verdict |
 * |---|---|---|
 * | `42`, `"42"` | int | accepted |
 * | `4.5`, `"abc"`, `true` | int | refused |
 * | `-1`, `"-1"` | uint | refused |
 * | `"7"` | uint | accepted |
 * | `"1.5"`, `1.5` | double | accepted |
 * | `"2026-01-01T00:00:00Z"` | timestamp | accepted |
 * | `1700000000`, `"not a date"` | timestamp | refused |
 * | `"1h"`, `"1.5h"`, `"2h45m"` | duration | accepted |
 * | `"1d"`, `3600` | duration | refused |
 * | `"true"` | bool | refused |
 * | `1` | string | refused |
 * | `[1]` | list&lt;string&gt; | refused |
 *
 * The shape of it: the **numeric** types accept numeric strings,
 * because JSON has no integer type and upstream parses rather than
 * asserts — but the grammar is Go's, so it is neither `Number`'s
 * nor `BigInt`'s. `duration` and `timestamp` accept **only**
 * strings. A container coerces every element as its declared
 * element type. Everything else is exact.
 *
 * Refusing rather than answering `false` is the point. On the
 * subtract side of an `excludedBy` a `false` condition means the
 * exclusion does not fire, so a mistyped context value would
 * *grant*. That is the same hazard this file already documents for
 * *missing* parameters, which was closed while ill-typed ones were
 * left open.
 *
 * Throws a plain `Error`; callers wrap it in whichever of
 * `ConditionEvaluationError` or `InvalidConditionalTupleError`
 * fits their path.
 */

/** Go's `time.ParseDuration` grammar: `-1.5h`, `2h45m`, `300ms`. */
const DURATION =
  /^[+-]?(\d+(\.\d*)?|\.\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)([+-]?(\d+(\.\d*)?|\.\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h))*$/;

/**
 * The one unitless duration Go accepts.
 *
 * `time.ParseDuration` special-cases a bare zero before it looks
 * for a unit, so `"0"`, `"+0"` and `"-0"` parse while `"00"` and
 * `"1"` do not.
 */
const DURATION_ZERO = /^[+-]?0$/;

/**
 * RFC 3339, as `time.Parse(time.RFC3339, …)` accepts it.
 *
 * The designators are uppercase because Go's RFC3339 layout spells
 * them that way and its parser is exact about it: upstream refuses
 * `2026-01-01t00:00:00z` in all three combinations of case, where
 * this regex used to admit them and answer.
 *
 * The fractional part is unbounded on purpose. Upstream accepts 3,
 * 9, 12 and 30 digits alike — it keeps nanoseconds and discards the
 * rest — so the digits are not what this has to gate.
 */
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The range CEL gives a timestamp: year 1 through year 9999.
 *
 * cel-js applies the same bounds inside `timestamp()`; they are
 * restated here because the coercion no longer goes through it.
 */
const TIMESTAMP_MIN = -62135596800000;
const TIMESTAMP_MAX = 253402300799999;

/**
 * A context value as text, for a refusal message.
 *
 * `JSON.stringify` throws on a `bigint`, and a caller may hand one
 * straight through -- so the obvious spelling turns a refusal that
 * should be a `TsfgaError` into a raw `TypeError` escaping the
 * check.
 */
function describeValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  return JSON.stringify(value) ?? typeof value;
}

/**
 * The numeric string grammar, which is Go's and not JavaScript's.
 *
 * Every numeric type — `int`, `uint` and `double` alike — reaches
 * upstream through `big.ParseFloat(value, 10, 64, 0)`. Base 10 is
 * given explicitly, so none of the prefixed literal forms
 * `Number()` accepts are: `0x10`, `0o10`, `0b10` and `1_000` are
 * all refused, as is any surrounding whitespace and the empty
 * string. What it does accept is a decimal mantissa with an
 * optional exponent — `1e3`, `1E3`, `1e+3`, `1000e-3`, `.5` and
 * `5.` all parse — where `Number()` and `BigInt()` between them
 * agree on none of the boundary.
 *
 * `p` is Go's binary exponent: `1p3` is 8.
 */
const GO_NUMERIC =
  /^([+-])?(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+)|[pP]([+-]?\d+))?$/;

/**
 * The infinities, which `big.Float.Parse` special-cases before it
 * scans anything: exactly `Inf` or `inf`, optionally signed.
 * `INF`, `Infinity` and `NaN` are refused, upstream and here.
 */
const GO_INFINITY = /^([+-])?(?:Inf|inf)$/;

/** Go's int64, which is what upstream stores an `int` in. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * How far the exponents are followed exactly.
 *
 * Past this the value is many orders of magnitude outside both
 * `float64` and `int64`, and the only cost of following it would
 * be raising 5 to an attacker-chosen power. Refusing matches the
 * behaviour these spellings already had.
 */
const MAX_EXPONENT_10 = 4000;
const MAX_EXPONENT_2 = 16000;

/** A parsed numeric string: `digits × 10^exp10 × 2^exp2`. */
interface ParsedNumber {
  negative: boolean;
  digits: bigint;
  exp10: number;
  exp2: number;
}

function parseGoNumeric(value: string): ParsedNumber | null {
  const match = GO_NUMERIC.exec(value);
  if (!match) return null;
  const [, sign, mantissa, decimalExponent, binaryExponent] = match;
  if (mantissa === undefined) return null;

  const point = mantissa.indexOf(".");
  const digits =
    point === -1
      ? mantissa
      : mantissa.slice(0, point) + mantissa.slice(point + 1);
  const fraction = point === -1 ? 0 : mantissa.length - point - 1;

  return {
    negative: sign === "-",
    digits: BigInt(digits),
    exp10: Number(decimalExponent ?? 0) - fraction,
    exp2: Number(binaryExponent ?? 0),
  };
}

/**
 * The same value written as `significand × 2^exp2` with an odd
 * significand, or `null` when it cannot be — `0.1` is a decimal
 * fraction with no finite binary form, and no rounding here would
 * make it one.
 *
 * That is the whole of upstream's precision rule. It parses at
 * 64-bit precision and then converts, refusing when the conversion
 * is inexact, so a `double` given `"0.1"` or
 * `"1.0000000000000000001"` is an error rather than the nearest
 * `float64`.
 */
function toDyadic(
  parsed: ParsedNumber,
): { significand: bigint; exp2: number } | null {
  if (parsed.digits === 0n) return { significand: 0n, exp2: 0 };
  if (Math.abs(parsed.exp10) > MAX_EXPONENT_10) return null;
  if (Math.abs(parsed.exp2) > MAX_EXPONENT_2) return null;

  // 10^n is 2^n·5^n, so the power of ten splits into a power of
  // two the binary exponent absorbs and a power of five that must
  // divide the digits exactly or the value is not dyadic.
  let significand = parsed.digits;
  let exp2 = parsed.exp2 + parsed.exp10;
  if (parsed.exp10 > 0) {
    significand *= 5n ** BigInt(parsed.exp10);
  } else if (parsed.exp10 < 0) {
    const fifths = 5n ** BigInt(-parsed.exp10);
    if (significand % fifths !== 0n) return null;
    significand /= fifths;
  }

  while (significand % 2n === 0n) {
    significand >>= 1n;
    exp2 += 1;
  }
  return { significand, exp2 };
}

/** How many bits the significand needs. */
function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * An integer context value as a `bigint`, or `null`.
 *
 * `bigint` rather than `number` because cel-js maps a JS `number`
 * onto CEL's `double`, so every arithmetic operator against an
 * `int` literal failed to find an overload, and any magnitude past
 * 2^53 compared wrong without erroring. The value usually arrives
 * as a string, so it is parsed directly: routing it through
 * `Number` first loses the precision before a `BigInt` could
 * preserve it.
 *
 * A string is an integer when its dyadic form has no negative
 * exponent left, which is how `"4.0"` and `"1e3"` are integers and
 * `"4.5"` and `".5"` are not — upstream asks `bigFloat.IsInt()`
 * and draws the line in the same place.
 */
function asBigInt(value: unknown, allowNegative: boolean): bigint | null {
  // Deliberate: upstream's type assertion refuses `true` for an
  // int, where a bare `Number(true)` would happily produce `1`.
  if (typeof value === "boolean") return null;
  if (typeof value === "bigint") {
    return allowNegative || value >= 0n ? value : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    const parsed = BigInt(value);
    return allowNegative || parsed >= 0n ? parsed : null;
  }
  if (typeof value !== "string") return null;

  const parsed = parseGoNumeric(value);
  if (!parsed) return null;
  const dyadic = toDyadic(parsed);
  if (!dyadic || dyadic.exp2 < 0) return null;

  const magnitude = dyadic.significand << BigInt(dyadic.exp2);
  const signed = parsed.negative ? -magnitude : magnitude;
  return allowNegative || signed >= 0n ? signed : null;
}

/**
 * Saturate to the range the declared type can hold.
 *
 * Upstream converts through `bigFloat.Int64()`, which clamps
 * rather than failing, and then answers on the clamped value. An
 * exact `BigInt` would answer the opposite boolean for a magnitude
 * outside the range, so the clamp is part of matching it.
 *
 * A `uint` clamps at the **int64** ceiling, not the uint64 one:
 * upstream reads every numeric string through the same
 * `bigFloat.Int64()` and only then rejects a negative, so
 * `n == 9223372036854775807u` holds for a value far past it and
 * `n == 18446744073709551615u` does not.
 */
function saturate(value: bigint, min: bigint): bigint {
  if (value < min) return min;
  if (value > INT64_MAX) return INT64_MAX;
  return value;
}

/**
 * A double context value as a `number`, or `null`.
 *
 * A JSON number is taken as it stands — it is already a `float64`
 * and upstream asserts rather than parses it. A string goes
 * through Go's grammar and Go's precision rule, so the ways
 * `Number()` is laxer than `big.ParseFloat` are all closed: the
 * prefixed literal forms, surrounding whitespace, an inexact
 * decimal, and a magnitude that overflows or underflows the type.
 * The infinities go the other way — upstream reads `Inf` and
 * `Number()` does not.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const infinite = GO_INFINITY.exec(value);
  if (infinite) {
    return infinite[1] === "-"
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }

  const parsed = parseGoNumeric(value);
  if (!parsed) return null;
  const dyadic = toDyadic(parsed);
  if (!dyadic) return null;
  if (dyadic.significand === 0n) return parsed.negative ? -0 : 0;

  // The exponent range of a float64: the largest is just under
  // 2^1024 and the smallest subnormal is 2^-1074.
  const exponent = dyadic.exp2 + bitLength(dyadic.significand) - 1;
  if (bitLength(dyadic.significand) > 53) return null;
  if (exponent > 1023 || dyadic.exp2 < -1074) return null;

  const magnitude = Number(dyadic.significand) * 2 ** dyadic.exp2;
  return parsed.negative ? -magnitude : magnitude;
}

/**
 * A timestamp string as a `Date`, or `null`.
 *
 * Built here rather than through cel-js's `timestamp()`, which
 * refuses any spelling longer than 30 characters — ten fractional
 * digits are enough — where upstream keeps nanoseconds and
 * discards the rest of whatever it is given. The bounds and the
 * `Date` itself are what cel-js would have produced.
 */
function asTimestamp(value: string): Date | null {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  if (time < TIMESTAMP_MIN || time > TIMESTAMP_MAX) return null;
  return date;
}

const SCALAR_PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "string",
  "int",
  "uint",
  "bool",
  "double",
  "duration",
  "timestamp",
  "any",
]);

function isScalarParameterType(
  value: string,
): value is ConditionParameterScalarType {
  return SCALAR_PARAMETER_TYPES.has(value);
}

const CONTAINER_PARAMETER_TYPE = /^(list|map)<(.+)>$/;

/**
 * A declared `list<…>` or `map<…>` taken apart, or `null` for a
 * type that holds nothing.
 */
function containerOf(
  paramType: ConditionParameterType,
): { kind: "list" | "map"; element: ConditionParameterScalarType } | null {
  const match = CONTAINER_PARAMETER_TYPE.exec(paramType);
  if (!match) return null;
  const [, kind, element] = match;
  if (element === undefined || !isScalarParameterType(element)) return null;
  return { kind: kind === "map" ? "map" : "list", element };
}

function coerceValue(
  parameter: string,
  value: unknown,
  paramType: ConditionParameterType,
): unknown {
  // Explicitly typed so TypeScript treats it as never-returning
  // and narrows after each call.
  const refuse: (expected: string) => never = (expected) => {
    throw new Error(
      `parameter '${parameter}' expected ${expected}, but found ` +
        `${describeValue(value)}`,
    );
  };

  // Containers first, because their element type decides the rest
  // and the scalar switch has nothing to say about them. Every
  // element is coerced as its declared type, which is what makes
  // `list<string>` given `[1]` an error rather than a list CEL
  // will happily compare a number out of.
  const container = containerOf(paramType);
  if (container) {
    if (container.kind === "list") {
      if (!Array.isArray(value)) refuse("a list");
      return value.map((item, index) =>
        coerceValue(`${parameter}[${index}]`, item, container.element),
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      refuse("a map");
    }
    const coerced: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      coerced[key] = coerceValue(
        `${parameter}['${key}']`,
        item,
        container.element,
      );
    }
    return coerced;
  }

  switch (paramType) {
    case "any":
      return value;

    case "bool":
      if (typeof value !== "boolean") refuse("a bool");
      return value;

    case "string":
      if (typeof value !== "string") refuse("a string");
      return value;

    case "int":
    case "uint": {
      const signed = paramType === "int";
      const parsed = asBigInt(value, signed);
      if (parsed === null) {
        // A negative given for a uint is worth saying plainly; it
        // is the one rejection a caller is likely to have meant.
        if (paramType === "uint" && asBigInt(value, true) !== null) {
          refuse("a uint value, but found a negative");
        }
        refuse(`an ${paramType} value`);
      }
      const saturated = saturate(parsed, signed ? INT64_MIN : 0n);
      return signed ? saturated : coerceUint({ val: saturated });
    }

    case "double": {
      const numeric = asNumber(value);
      if (numeric === null) refuse("a double value");
      return numeric;
    }

    case "duration": {
      // String only. `3600` is refused rather than read as
      // seconds — upstream asserts the string before parsing.
      if (typeof value !== "string") refuse("a duration string");
      // Go's parser takes a bare zero and nothing else unitless,
      // and cel-js's `duration()` takes no such thing, so the one
      // spelling it declines is written out.
      if (DURATION_ZERO.test(value)) return coerceDuration({ val: "0s" });
      if (!DURATION.test(value)) refuse("a valid duration string");
      return coerceDuration({ val: value });
    }

    case "timestamp": {
      if (typeof value !== "string") refuse("an RFC 3339 timestamp string");
      if (!RFC3339.test(value)) refuse("a valid RFC 3339 timestamp string");
      const timestamp = asTimestamp(value);
      if (timestamp === null) refuse("a valid RFC 3339 timestamp string");
      return timestamp;
    }

    default:
      // A parameter type with no rule of its own must not reach
      // CEL. This branch returned `paramType` — substituting the
      // type's own name for the caller's value, silently — which
      // is the shape a new union member would have fallen into.
      refuse("a value of a declared parameter type");
  }
}

/**
 * Coerce every declared parameter present in `context`, and report
 * the ones that are absent.
 *
 * Only the keys actually present are read. A context key the
 * condition does not declare is *not* an error here — probed
 * against v1.18.2, a check carrying a stray key is accepted. That
 * refusal belongs to the write path.
 *
 * Shared with `validateTupleWrite` so a tuple cannot be writable
 * but unevaluable: if the two used different rules, a value the
 * write path accepted could raise at every check that read it.
 */
export function coerceContext(
  parameters: Record<string, ConditionParameterType> | null,
  context: Record<string, unknown>,
): { coerced: Record<string, unknown>; missing: string[] } {
  const coerced = { ...context };
  const missing: string[] = [];
  if (!parameters) return { coerced, missing };

  for (const [key, paramType] of Object.entries(parameters)) {
    if (key in coerced) {
      coerced[key] = coerceValue(key, coerced[key], paramType);
    } else {
      missing.push(key);
    }
  }
  return { coerced, missing };
}

/**
 * Evaluate a tuple's condition. Returns true if:
 * - The tuple has no condition (unconditional access)
 * - The condition evaluates to true
 * Returns false if the condition evaluates to false.
 * Throws ConditionNotFoundError if conditionName references a missing definition.
 * Throws ConditionEvaluationError if a declared parameter is
 * absent from the merged context, if a present one cannot be read
 * as its declared type, or if CEL evaluation fails — matching
 * OpenFGA's check path, where all three are evaluation errors
 * rather than an unmet condition.
 */
export async function evaluateTupleCondition(
  store: TupleStore,
  tuple: Tuple,
  requestContext?: Record<string, unknown>,
): Promise<boolean> {
  if (!tuple.conditionName) {
    return true;
  }

  const condDef = await store.findConditionDefinition(tuple.conditionName);
  if (!condDef) {
    throw new ConditionNotFoundError(tuple.conditionName);
  }

  // Merge contexts: tuple context wins over request context
  const merged = { ...requestContext, ...tuple.conditionContext };

  // Every declared parameter must be present in the merged
  // context, and every present one must be readable as its
  // declared type. OpenFGA treats both as evaluation errors rather
  // than as an unmet condition — an unmet condition would fail
  // open through an exclusion branch ("not excluded" grants).
  let context: Record<string, unknown>;
  let missing: string[];
  try {
    ({ coerced: context, missing } = coerceContext(condDef.parameters, merged));
  } catch (error) {
    throw new ConditionEvaluationError(condDef.name, error);
  }
  if (missing.length > 0) {
    throw new ConditionEvaluationError(
      condDef.name,
      new Error(`missing context parameters: ${missing.join(", ")}`),
    );
  }

  const compiled = compileCondition(condDef.name, condDef.expression);

  try {
    const result = compiled(context);
    return result === true;
  } catch (error) {
    throw new ConditionEvaluationError(condDef.name, error);
  }
}
