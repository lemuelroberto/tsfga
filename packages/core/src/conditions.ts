import {
  type ASTNode,
  Environment,
  type ParseResult,
} from "@marcbachmann/cel-js";
import {
  ConditionCompileError,
  ConditionEvaluationError,
  ConditionNotFoundError,
  TsfgaError,
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
 *   `tsfga_re2_matches` cannot be written in a condition, because
 *   `compileCondition` is what puts them there: it parses the
 *   author's expression, rewrites `int(…)`, `double(…)`,
 *   `matches(…)` and `x.matches(…)` onto these names, and parses
 *   the result. See `rewriteCalls`.
 *
 * `homogeneousAggregateLiterals` is cel-js's own default (`true`)
 * turned **off**, because cel-go's is off and OpenFGA never turns
 * it on: `internal/condition/condition.go` builds the base
 * environment from the custom parameter types, `IPAddressEnvOption`
 * and `EagerlyValidateDeclarations` alone. On cel-js's default a
 * list literal takes its type from its first element and every
 * later element of another type is an evaluation error, so
 * `["x", s]` — a string beside a `dyn` variable — refuses where
 * upstream answers. CEL's list literal is `list(dyn)` (issue 322).
 */
const env = new Environment({
  unlistedVariablesAreDyn: true,
  homogeneousAggregateLiterals: false,
});

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
/**
 * `int(duration)` is the duration's **nanoseconds** and
 * `int(timestamp)` is its **epoch seconds**, which is how cel-go
 * reads them (`common/stdlib/standard.go`, the `IntToInt` function
 * block's `DurationToInt` and `TimestampToInt` overloads). Neither
 * exists in cel-js, and they are how a condition spells "how long"
 * and "when" as a number — the arithmetic an expiry rule is
 * written in (issue 382).
 *
 * A timestamp arrives as a JS `Date`, so seconds are read from
 * milliseconds and floored, which is coarser than the
 * sub-millisecond resolution the coercion boundary already loses.
 */
env.registerFunction(
  "tsfga_int(google.protobuf.Duration): int",
  (value: unknown) =>
    carriedField(value, "seconds") * 1_000_000_000n +
    carriedField(value, "nanos"),
);
env.registerFunction(
  "tsfga_int(google.protobuf.Timestamp): int",
  (value: Date) => BigInt(Math.floor(value.getTime() / 1000)),
);
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

/**
 * The RE2 matcher, in **both** spellings CEL declares it in.
 *
 * cel-go's standard library declares `matches` twice in one
 * `function(overloads.Matches, …)` block — a global
 * `matches(string, string): bool` and the member overload
 * `<string>.matches(string): bool` — bound to the same matcher, so
 * the two spellings are the same function and must reach the same
 * implementation here (issues 320 / 380).
 */
function re2Matches(value: string, pattern: string): boolean {
  return compileRe2(pattern).test(value);
}

env.registerFunction("string.tsfga_re2_matches(string): bool", re2Matches);
env.registerFunction("tsfga_re2_matches(string, string): bool", re2Matches);

/** A closed range of code points, low first. */
type CodePointRange = readonly [number, number];

/**
 * What a POSIX bracket class stands for, as RE2 defines it.
 *
 * A JavaScript `RegExp` reads `[[:alpha:]]` as a class of the
 * characters `[:alph`, which matches nothing an author meant and
 * errors nowhere — the silent half of issue 020.
 *
 * Held as code point ranges rather than as class source text
 * because RE2's negated form (`[[:^alpha:]]`) is the complement of
 * the class over the **whole** code point space, which is a set
 * operation and not a string one. Each list is ascending and
 * disjoint, which is what `complementRanges` assumes.
 */
const POSIX_CLASSES: Readonly<Record<string, readonly CodePointRange[]>> = {
  alnum: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  alpha: [
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  ascii: [[0x00, 0x7f]],
  blank: [
    [0x09, 0x09],
    [0x20, 0x20],
  ],
  cntrl: [
    [0x00, 0x1f],
    [0x7f, 0x7f],
  ],
  digit: [[0x30, 0x39]],
  graph: [[0x21, 0x7e]],
  lower: [[0x61, 0x7a]],
  print: [[0x20, 0x7e]],
  punct: [
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e],
  ],
  space: [
    [0x09, 0x0d],
    [0x20, 0x20],
  ],
  upper: [[0x41, 0x5a]],
  word: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x5f, 0x5f],
    [0x61, 0x7a],
  ],
  xdigit: [
    [0x30, 0x39],
    [0x41, 0x46],
    [0x61, 0x66],
  ],
};

/** The last code point, which is where a negated class ends. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * A code point as a class member.
 *
 * `\uXXXX` is read the same way with and without the `u` flag, so
 * an ordinary expansion does not drag the flag in with it. Only a
 * code point past the BMP needs `\u{…}`, and only a negated class
 * produces one.
 */
function escapeCodePoint(code: number): string {
  if (code > 0xffff) return `\\u{${code.toString(16).toUpperCase()}}`;
  return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatRanges(ranges: readonly CodePointRange[]): string {
  let out = "";
  for (const [low, high] of ranges) {
    out +=
      low === high
        ? escapeCodePoint(low)
        : `${escapeCodePoint(low)}-${escapeCodePoint(high)}`;
  }
  return out;
}

/**
 * The gaps between the ranges, over the whole code point space.
 *
 * That is what RE2 means by `[:^alpha:]`: Go's
 * `regexp/syntax.appendNegatedClass` complements the table against
 * the full rune range, not against ASCII, so a letter outside ASCII
 * is a member of the negated class.
 */
function complementRanges(ranges: readonly CodePointRange[]): CodePointRange[] {
  const out: CodePointRange[] = [];
  let next = 0;
  for (const [low, high] of ranges) {
    if (low > next) out.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT]);
  return out;
}

/** Leading inline flag groups: `(?i)`, `(?is)`, `(?U)`. */
const LEADING_FLAGS = /^\(\?([imsU]+)\)/;

/** `{2}`, `{2,}`, `{2,5}` — a repetition rather than a literal. */
const REPETITION = /^\{(\d+)(?:,(\d*))?\}/;

/**
 * The largest repetition count `regexp/syntax` accepts.
 *
 * Go names the constant `maxRepeat = 1000` and the bound is
 * **inclusive**: `parse.go` refuses on `min < 0 || min > 1000 ||
 * max > 1000 || max >= 0 && min > max`, so `a{1000}`, `a{1000,}`
 * and `a{2,1000}` are all valid RE2 and only a count *above* 1000
 * is refused.
 *
 * This comment used to say the opposite — "measured against the
 * container, 1000 is already over the line" — and the measurement
 * behind it was confounded. The probe matched `a{1000}` against a
 * **1000-character subject**, and it was the subject's length that
 * made upstream refuse: cel-go charges a regex match by the code
 * points of subject plus pattern and bounds the whole evaluation
 * at a cost of 100. The pattern was never the reason (issue 400).
 *
 * The ceiling exists because a repetition count is the cheapest way
 * to make a pattern expensive, and in tsfga's shapes the pattern
 * usually arrives in the request context — which is to say from
 * whoever is asking. Bounding one repetition is not the whole rule:
 * see `takeRepetition`, which also carries Go's `repeatIsValid`
 * product over *nested* repetitions.
 */
const MAX_REPEAT = 1000;

/** `[:alpha:]` and its negated form, inside a bracket expression. */
const POSIX_CLASS = /^\[:(\^?)([a-z]+):\]/;

/** A flag group RE2 accepts — scoped `(?i:…)` or bare `(?i)`. */
const FLAG_GROUP = /^\(\?([imsU]*)(?:-([imsU]+))?[:)]/;

/** `\a` and the four `\f\n\r\t\v` JavaScript shares with RE2. */
const CONTROL_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/**
 * RE2's `\s`, spelled out.
 *
 * Go's `\s` is the five ASCII characters `[\t\n\f\r ]`. JavaScript's
 * is a Unicode set that also holds `\v`, every `Zs` space, the line
 * and paragraph separators and the BOM — so passing `\s` through
 * silently widens the class, which is the same failure mode as the
 * POSIX classes and is invisible in exactly the same way.
 */
const RE2_SPACE = "\\t\\n\\f\\r\\u0020";

/**
 * Unicode general category names, which RE2 and JavaScript spell
 * identically. Every other name RE2 takes in `\p{…}` is a script,
 * which JavaScript spells `\p{Script=…}`.
 *
 * Transcribed from Go's `unicode.Categories`, which is what
 * `regexp/syntax` looks a name up in before `unicode.Scripts`.
 */
const UNICODE_CATEGORIES: ReadonlySet<string> = new Set([
  "C",
  "Cc",
  "Cf",
  "Co",
  "Cs",
  "L",
  "Ll",
  "Lm",
  "Lo",
  "Lt",
  "Lu",
  "M",
  "Mc",
  "Me",
  "Mn",
  "N",
  "Nd",
  "Nl",
  "No",
  "P",
  "Pc",
  "Pd",
  "Pe",
  "Pf",
  "Pi",
  "Po",
  "Ps",
  "S",
  "Sc",
  "Sk",
  "Sm",
  "So",
  "Z",
  "Zl",
  "Zp",
  "Zs",
]);

/** Whether a code point is one RE2 refuses to read as an escaped
 *  literal — it takes `\!` and `\-`, and refuses `\y` and `\8`. */
function isAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/** Every code point of `text`, as an escape a `RegExp` reads back
 *  as that literal character — what `\Q…\E` means. */
function quoteLiteral(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined) out += escapeCodePoint(code);
  }
  return out;
}

/**
 * Why a pattern did not become a `RegExp`.
 *
 * - `invalid` — RE2 refuses it too. Upstream refuses the *model*
 *   that carries such a pattern as a constant, so tsfga refuses the
 *   write (issue 241).
 * - `untranslatable` — RE2 accepts it and no faithful JavaScript
 *   spelling exists, so the pattern is refused where it is met.
 *   Refusing the write instead would refuse a model upstream
 *   accepts, which would trade one divergence for a worse one.
 *
 * The distinction only exists because the refusal now has two
 * audiences: a check, which must refuse either way, and
 * `writeConditionDefinition`, which must refuse only what upstream
 * refuses.
 */
type Re2RefusalKind = "invalid" | "untranslatable";

class Re2PatternError extends Error {
  readonly kind: Re2RefusalKind;

  constructor(message: string, kind: Re2RefusalKind, options?: ErrorOptions) {
    super(message, options);
    this.name = "Re2PatternError";
    this.kind = kind;
  }
}

function refusePattern(
  pattern: string,
  reason: string,
  kind: Re2RefusalKind,
): never {
  throw new Re2PatternError(
    `error parsing regexp: ${reason}: \`${pattern}\``,
    kind,
  );
}

interface TranslatedPattern {
  source: string;
  flags: string;
}

/**
 * One member of a bracket expression, as JavaScript spells it.
 *
 * `code` is the member's code point when it is a single character
 * and `null` when it is a class — which is what decides whether it
 * may be a range endpoint. RE2 refuses a range whose endpoint is a
 * class (issue 385) where JavaScript's Annex B fallback accepts
 * one, so the distinction has to be carried rather than inferred.
 */
interface ClassItem {
  readonly code: number | null;
  readonly source: string;
}

/**
 * Rewrite an RE2 pattern as the nearest JavaScript one, or refuse.
 *
 * The two dialects are not a superset of one another, so this runs
 * in both directions:
 *
 * - RE2 spellings JavaScript cannot compile — the leading inline
 *   flags `(?i)` `(?s)` `(?m)` `(?U)`, the `(?P<name>` group, `\A`,
 *   `\z`, `\Q…\E`, `\x{…}`, an octal escape, a script name — become
 *   flags, `(?<name>`, `^`, `$` and explicit code points. `(?U)`
 *   inverts every quantifier's greediness, which is what the flag
 *   means.
 * - spellings both compile and read differently — the POSIX
 *   classes, `\pL` / `\p{L}`, and `\s`, whose RE2 meaning is five
 *   ASCII characters — become their JavaScript equivalents. A
 *   negated POSIX class (`[[:^alpha:]]`) expands to the class's
 *   complement over the whole code point space, which is what RE2
 *   computes.
 * - spellings JavaScript accepts and RE2 refuses — lookahead,
 *   lookbehind, backreferences, `\b` inside a bracket expression, a
 *   range whose endpoint is a class, a repetition of 1000 or more,
 *   `\C` — are refused here, turning what was a silent grant into
 *   the refusal upstream gives.
 *
 * **Nothing else passes through.** A construct this function does
 * not recognise is refused rather than handed to `new RegExp`,
 * because the outcome of handing it over is not "an error": it is a
 * JavaScript regular expression that compiles and means something
 * else, with no signal anywhere. `\Aabc` used to reach `new RegExp`
 * verbatim, fail under the `u` flag, recompile without it, and mean
 * *the literal letter A* under Annex B web compatibility (issue
 * 383). Refusing by default closes that whole category, including
 * for constructs nobody has enumerated.
 *
 * Ordinary characters are the one exception, and are not an
 * exception to the rule: a literal is a literal in both dialects.
 * The ones JavaScript would read as syntax under the `u` flag are
 * escaped on the way out.
 *
 * Everything this function emits compiles under the `u` flag, which
 * is why `compileRe2` no longer has a non-`u` retry: the retry was
 * the mechanism behind three of the bugs this pass closes.
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
  /** Open groups, so an unbalanced paren is named rather than left
   *  for `new RegExp` — which cannot say which dialect refused. */
  let depth = 0;
  /** Group names already emitted. RE2 allows a name twice and
   *  JavaScript does not, so the later one is renamed. */
  const groupNames = new Set<string>();

  /**
   * Go's `repeatIsValid`, carried through a scanner that has no
   * tree (issue 401).
   *
   * `parse.go` does not bound one repetition; after building a
   * repeat node it walks the node dividing a budget of 1000 down
   * through every nested repetition, so `(a{100}){100}` — ten
   * thousand copies — is refused where each `{100}` alone is fine.
   * The equivalent bottom-up quantity is, for a subtree, the
   * smallest budget under which it is valid: 0 for anything
   * carrying no repetition, `max(m, m × need(child))` for a
   * repetition of `m`, and the maximum over the parts of a
   * concatenation or an alternation (those recurse on the *same*
   * budget). A repetition is refused when its own need passes
   * 1000, which is exactly Go's test since `n / m >= k` and
   * `n >= k × m` are the same statement in integers.
   *
   * `atomNeed` is the need of the item a quantifier would apply
   * to; `groupNeed` the maximum over the items already completed
   * in the group being scanned; `openNeeds` the enclosing ones.
   */
  let atomNeed = 0;
  let groupNeed = 0;
  const openNeeds: number[] = [];

  /** Close off the item just scanned and begin another. */
  const startAtom = () => {
    if (atomNeed > groupNeed) groupNeed = atomNeed;
    atomNeed = 0;
  };

  /** Flip the quantifier just emitted, for `(?U)`. */
  const flipGreediness = () => {
    if (!ungreedy) return;
    if (pattern[index] === "?") index += 1;
    else source += "?";
  };

  /** Annotated rather than inferred: control-flow narrowing only
   *  reads `never` off a function expression's declared type. */
  const refuseEscape: () => never = () =>
    refusePattern(pattern, "invalid escape sequence", "invalid");

  /** `\p{…}`, `\pL`, and their negations, in or out of a class. */
  const takeUnicodeClass = (inClass: boolean): ClassItem => {
    let negated = pattern[index + 1] === "P";
    const after = pattern[index + 2];
    let name: string;
    if (after === "{") {
      const close = pattern.indexOf("}", index + 3);
      if (close === -1) refuseEscape();
      name = pattern.slice(index + 3, close);
      index = close + 1;
    } else if (after !== undefined) {
      // `\pL` is RE2's one-letter spelling of `\p{L}`.
      name = after;
      index += 3;
    } else {
      return refuseEscape();
    }
    if (name.startsWith("^")) {
      // RE2 negates inside the braces; JavaScript negates the `p`.
      negated = !negated;
      name = name.slice(1);
    }
    if (name.length === 0) refuseEscape();
    if (name === "Any") {
      // RE2's every-rune class, which JavaScript has no name for.
      if (negated) return { code: null, source: inClass ? "" : "[^\\s\\S]" };
      return { code: null, source: inClass ? "\\s\\S" : "[\\s\\S]" };
    }
    const spelled = UNICODE_CATEGORIES.has(name) ? name : `Script=${name}`;
    return { code: null, source: `\\${negated ? "P" : "p"}{${spelled}}` };
  };

  /** A `\x` escape, in or out of a bracket expression. */
  const takeEscape = (inClass: boolean): ClassItem => {
    const next = pattern[index + 1];
    if (next === undefined) {
      refusePattern(pattern, "trailing backslash", "invalid");
    }

    if (next === "A" || next === "z") {
      // RE2's text anchors. `^` and `$` are the same two assertions
      // only while `m` is absent, and JavaScript has no other
      // spelling of them that RE2 would also accept.
      if (inClass) refuseEscape();
      if (flags.includes("m")) {
        refusePattern(
          pattern,
          "unsupported anchor under (?m)",
          "untranslatable",
        );
      }
      index += 2;
      return { code: null, source: next === "A" ? "^" : "$" };
    }
    if (next === "b" || next === "B") {
      // A word boundary outside a class; inside one, RE2 has no
      // `\b` at all and JavaScript reads it as a backspace.
      if (inClass) refuseEscape();
      index += 2;
      return { code: null, source: `\\${next}` };
    }
    if (next === "C") {
      // RE2's any-byte escape, which `regexp` itself refuses.
      refuseEscape();
    }
    if (next === "d" || next === "D" || next === "w" || next === "W") {
      // Identical in both dialects, ASCII in both.
      index += 2;
      return { code: null, source: `\\${next}` };
    }
    if (next === "s" || next === "S") {
      index += 2;
      if (next === "s") {
        return { code: null, source: inClass ? RE2_SPACE : `[${RE2_SPACE}]` };
      }
      if (inClass) {
        // A negated class cannot be a member of another class
        // without set subtraction, which no supported runtime has.
        refusePattern(
          pattern,
          "unsupported negated class in a bracket expression",
          "untranslatable",
        );
      }
      return { code: null, source: `[^${RE2_SPACE}]` };
    }
    if (next === "p" || next === "P") return takeUnicodeClass(inClass);
    if (next === "Q") {
      // `\Q…\E` quotes its contents. An unterminated `\Q` runs to
      // the end of the pattern, which is what RE2 does. RE2 has no
      // `\Q` inside a bracket expression.
      if (inClass) refuseEscape();
      const end = pattern.indexOf("\\E", index + 2);
      const body =
        end === -1 ? pattern.slice(index + 2) : pattern.slice(index + 2, end);
      index = end === -1 ? pattern.length : end + 2;
      return { code: null, source: quoteLiteral(body) };
    }
    const control = CONTROL_ESCAPES[next];
    if (control !== undefined) {
      index += 2;
      return { code: control, source: escapeCodePoint(control) };
    }
    if (next === "x") {
      if (pattern[index + 2] === "{") {
        const close = pattern.indexOf("}", index + 3);
        if (close === -1) refuseEscape();
        const digits = pattern.slice(index + 3, close);
        if (!/^[0-9a-fA-F]+$/.test(digits)) refuseEscape();
        const code = Number.parseInt(digits, 16);
        if (code > MAX_CODE_POINT) refuseEscape();
        index = close + 1;
        return { code, source: escapeCodePoint(code) };
      }
      const digits = pattern.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) refuseEscape();
      const code = Number.parseInt(digits, 16);
      index += 4;
      return { code, source: escapeCodePoint(code) };
    }
    if (next >= "0" && next <= "7") {
      // RE2 reads `\0` and a `\1`-`\7` followed by another octal
      // digit as an octal escape of up to three digits. A lone
      // `\1`-`\9` is a backreference, which RE2 does not have.
      const second = pattern[index + 2];
      const octal =
        next === "0" ||
        (second !== undefined && second >= "0" && second <= "7");
      if (!octal) refuseEscape();
      let code = next.charCodeAt(0) - 0x30;
      let taken = 1;
      while (taken < 3) {
        const digit = pattern[index + 1 + taken];
        if (digit === undefined || digit < "0" || digit > "7") break;
        code = code * 8 + (digit.charCodeAt(0) - 0x30);
        taken += 1;
      }
      index += 1 + taken;
      return { code, source: escapeCodePoint(code) };
    }
    const code = pattern.codePointAt(index + 1);
    if (code === undefined || code >= 0x80 || isAlphanumeric(code)) {
      // Go takes `\` before any ASCII punctuation as that literal
      // character and refuses everything else — an unknown letter,
      // a digit that is not octal, an escaped non-ASCII rune.
      refuseEscape();
    }
    index += 2;
    return { code, source: escapeCodePoint(code) };
  };

  /** One member of a bracket expression, range aside. */
  const takeClassItem = (): ClassItem => {
    if (pattern[index] === "\\") return takeEscape(true);
    if (pattern[index] === "[") {
      const posix = POSIX_CLASS.exec(pattern.slice(index));
      if (posix) {
        const expansion = POSIX_CLASSES[posix[2] ?? ""];
        if (expansion === undefined) {
          refusePattern(pattern, "invalid character class range", "invalid");
        }
        index += posix[0].length;
        // RE2 negates against the whole code point space, not
        // against ASCII, so a letter outside ASCII is a member of
        // `[[:^alpha:]]`.
        const ranges =
          posix[1] === "^" ? complementRanges(expansion) : expansion;
        return { code: null, source: formatRanges(ranges) };
      }
    }
    const code = pattern.codePointAt(index);
    if (code === undefined)
      refusePattern(pattern, "missing closing ]", "invalid");
    index += String.fromCodePoint(code).length;
    return { code, source: escapeCodePoint(code) };
  };

  const takeClass = () => {
    source += "[";
    index += 1;
    if (pattern[index] === "^") {
      source += "^";
      index += 1;
    }
    // `]` and `-` are ordinary characters in the first position,
    // which is what Go's `first` flag says.
    let first = true;
    while (index < pattern.length) {
      if (pattern[index] === "]" && !first) break;
      first = false;
      const low = takeClassItem();
      const dash = pattern[index] === "-" && pattern[index + 1] !== undefined;
      if (!dash || pattern[index + 1] === "]") {
        source += low.source;
        continue;
      }
      if (low.code === null) {
        // `[\w-a]` is `\w`, a literal dash and `a` in RE2; under
        // the `u` flag JavaScript reads it as a range and refuses.
        source += low.source + escapeCodePoint(0x2d);
        index += 1;
        continue;
      }
      index += 1;
      const high = takeClassItem();
      if (high.code === null || high.code < low.code) {
        refusePattern(pattern, "invalid character class range", "invalid");
      }
      source += `${low.source}-${high.source}`;
    }
    if (index >= pattern.length) {
      refusePattern(pattern, "missing closing ]", "invalid");
    }
    source += "]";
    index += 1;
    flipGreediness();
  };

  const takeGroup = () => {
    depth += 1;
    if (!pattern.startsWith("(?", index)) {
      source += "(";
      index += 1;
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
      refusePattern(pattern, "invalid or unsupported Perl syntax", "invalid");
    }
    const named = pattern.startsWith("(?P<", index)
      ? index + 4
      : pattern.startsWith("(?<", index)
        ? index + 3
        : null;
    if (named !== null) {
      const close = pattern.indexOf(">", named);
      if (close === -1) {
        refusePattern(pattern, "invalid named capture", "invalid");
      }
      // RE2 allows one name twice; JavaScript refuses. Nothing
      // here ever reads a capture back, so the later one is
      // renamed rather than refused (issue 384).
      let name = pattern.slice(named, close);
      while (groupNames.has(name)) name += "_";
      groupNames.add(name);
      source += `(?<${name}>`;
      index = close + 1;
      return;
    }
    if (FLAG_GROUP.test(pattern.slice(index))) {
      // RE2 accepts `(?i:…)`, a bare `(?i)` applying to the rest of
      // its enclosing group, and `(?-i)` removing a flag.
      // JavaScript has none of them portably: modifier groups
      // reached V8 only in 12.5, so translating one would answer on
      // Node 24 and refuse on Node 22, and a bare group scopes to
      // the whole pattern. Refusing is loud and runtime-independent
      // — and, because RE2 accepts it, it must not refuse the
      // *write*.
      refusePattern(pattern, "unsupported inline group", "untranslatable");
    }
    // Anything else spelled `(?…` is Perl syntax RE2 refuses too.
    refusePattern(pattern, "invalid or unsupported Perl syntax", "invalid");
  };

  const takeRepetition = (): boolean => {
    const repetition = REPETITION.exec(pattern.slice(index));
    if (!repetition) return false;
    const low = Number.parseInt(repetition[1] ?? "", 10);
    const highText = repetition[2];
    const high =
      highText === undefined || highText === ""
        ? null
        : Number.parseInt(highText, 10);
    if (
      low > MAX_REPEAT ||
      (high !== null && (high > MAX_REPEAT || high < low))
    ) {
      refusePattern(pattern, "invalid repeat count", "invalid");
    }
    // Go reads `{m,}` as max = -1 and falls back on min; a max of
    // zero makes the whole subtree unreachable, and `repeatIsValid`
    // returns before it looks at one.
    const repeats = high === null ? low : high;
    const need = repeats === 0 ? 0 : Math.max(repeats, repeats * atomNeed);
    if ((low >= 2 || (high !== null && high >= 2)) && need > MAX_REPEAT) {
      refusePattern(pattern, "invalid repeat count", "invalid");
    }
    atomNeed = need;
    source += repetition[0];
    index += repetition[0].length;
    flipGreediness();
    return true;
  };

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      startAtom();
      source += takeEscape(false).source;
      flipGreediness();
      continue;
    }
    if (char === "[") {
      startAtom();
      takeClass();
      continue;
    }
    if (char === "(") {
      startAtom();
      openNeeds.push(groupNeed);
      groupNeed = 0;
      takeGroup();
      continue;
    }
    if (char === "*" || char === "+" || char === "?") {
      // `x*`, `x+` and `x?` are not `OpRepeat`, so `repeatIsValid`
      // divides nothing for them: the item's need passes through.
      source += char;
      index += 1;
      flipGreediness();
      continue;
    }
    if (char === "{") {
      if (takeRepetition()) continue;
      // `{` that opens no repetition is a literal in RE2 and a
      // syntax error under the `u` flag.
      startAtom();
      source += "\\{";
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      startAtom();
      source += `\\${char}`;
      index += 1;
      continue;
    }
    if (char === ")") {
      source += char;
      index += 1;
      depth -= 1;
      if (depth < 0) refusePattern(pattern, "unexpected )", "invalid");
      // The group becomes the item a quantifier applies to, and it
      // needs whatever the largest thing inside it needed.
      if (atomNeed > groupNeed) groupNeed = atomNeed;
      atomNeed = groupNeed;
      groupNeed = openNeeds.pop() ?? 0;
      flipGreediness();
      continue;
    }
    // An ordinary character, a `.`, an anchor or an alternation
    // bar: the same thing in both dialects.
    startAtom();
    source += char;
    index += 1;
  }
  if (depth > 0) refusePattern(pattern, "missing closing )", "invalid");

  return { source, flags };
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
    // **There is no retry without the `u` flag.** There used to be
    // one, for the patterns where `u` is stricter than RE2, and it
    // was the mechanism behind three separate silent divergences:
    // a construct the translator did not recognise reached
    // `new RegExp`, failed under `u`, and recompiled without it —
    // where Annex B web compatibility reads an unknown escape as
    // its bare letter and a class range endpoint as a literal.
    // `translateRe2Pattern` now emits only constructs that compile
    // under `u`, so arriving here means the translation itself was
    // not expressible.
    //
    // A `RegExp` that will not compile is classed `untranslatable`
    // and not `invalid`: the two dialects reject overlapping but
    // different sets and this path cannot tell which side refused,
    // so guessing `invalid` would refuse writes upstream accepts.
    throw new Re2PatternError(
      `error parsing regexp: \`${pattern}\``,
      "untranslatable",
      { cause: error },
    );
  }

  if (regexCache.size >= REGEX_CACHE_MAX_ENTRIES) {
    const oldest = regexCache.keys().next();
    if (!oldest.done) regexCache.delete(oldest.value);
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

/** How one spelling of one owned call is rewritten. */
interface Rewrite {
  /** The tsfga-owned name that replaces the author's. */
  readonly replacement: string;
  /** Arguments this spelling takes, the receiver excluded. */
  readonly arity: number;
  /**
   * Which argument is an RE2 pattern, or `null` when none is. The
   * pattern is the last argument in both spellings, so its index
   * moves with the arity — `args[1]` globally, `args[0]` on a
   * receiver — which is exactly the bookkeeping issue 321 was
   * filed for.
   */
  readonly patternArgument: number | null;
}

/** The two call styles cel-js's AST has, and nothing else. */
interface RewriteStyles {
  /** `f(a)` — a `call` node. */
  readonly call: Rewrite | null;
  /** `a.f(b)` — an `rcall` node. */
  readonly rcall: Rewrite | null;
}

/**
 * Every call this module owns an implementation for, keyed by
 * **name** and then by call style.
 *
 * Keying on the style alone — one table for `call`, one for
 * `rcall` — is what let the global spelling of `matches` escape
 * both the RE2 rewrite and the write-time pattern compile (issues
 * 320 / 380 / 321). CEL declares a function once and may declare
 * several overloads of it in either style, so the name is what
 * identifies the function and the style is a property of the
 * overload. The table below is that 3 × 2 matrix in full, with the
 * cells CEL does not declare written out as `null` rather than
 * left absent, so adding a name forces a decision on both styles.
 */
const REWRITES: ReadonlyMap<string, RewriteStyles> = new Map([
  [
    "int",
    {
      call: { replacement: "tsfga_int", arity: 1, patternArgument: null },
      rcall: null,
    },
  ],
  [
    "double",
    {
      call: { replacement: "tsfga_double", arity: 1, patternArgument: null },
      rcall: null,
    },
  ],
  [
    "matches",
    {
      call: {
        replacement: "tsfga_re2_matches",
        arity: 2,
        patternArgument: 1,
      },
      rcall: {
        replacement: "tsfga_re2_matches",
        arity: 1,
        patternArgument: 0,
      },
    },
  ],
]);

/**
 * Every function cel-go's standard library declares in the
 * **global** spelling, plus the two OpenFGA adds.
 *
 * Transcribed from `common/stdlib/standard.go` — the `decls.Overload`
 * entries, as opposed to the `decls.MemberOverload` ones — plus the
 * `has()` macro from `cel.StandardMacros`, plus `ipaddress` from
 * `types.IPAddressEnvOption()`.
 *
 * The operators are absent on purpose: `_+_`, `_==_` and their
 * siblings are declared as functions in cel-go but there is no
 * spelling that writes one as a call, and cel-js parses each into
 * its own AST node rather than into a `call`.
 */
const CEL_GO_GLOBAL_CALLS: ReadonlySet<string> = new Set([
  "bool",
  "bytes",
  "double",
  "duration",
  "dyn",
  "has",
  "int",
  "ipaddress",
  "size",
  "string",
  "timestamp",
  "type",
  "uint",
]);

/**
 * Every function cel-go's standard library declares in the
 * **receiver** spelling, plus the two OpenFGA adds.
 *
 * The `decls.MemberOverload` entries of the same file, plus the
 * five comprehension macros of `cel.StandardMacros`, plus `in_cidr`
 * from the `IPADDRESS` custom parameter type.
 *
 * `ipaddress` and `in_cidr` are declared here and implemented
 * nowhere: cel-js has neither, so a condition naming one is written
 * and then refuses at the check that reads it. That is the
 * behaviour this file has always had and the allow-list must not
 * change it — refusing the *write* would refuse a model upstream
 * accepts, which is the worse of the two directions.
 *
 * **`matches` is deliberately absent — from this table and from
 * the global one above — and its absence is the whole of tsfga's
 * regex policy.** cel-go declares it in both spellings, so both
 * entries had to go; leaving either one would have kept regex
 * support alive through that spelling alone.
 *
 * cel-go's `matches` is RE2 and cel-js's is a JavaScript
 * `RegExp`. They share a syntax and are different
 * languages, so a pattern means one thing upstream and another
 * here — sometimes granting (`^[^]*$` is a syntax error in RE2 and
 * *every possible input* in JavaScript), sometimes silently
 * denying (`[[:alnum:]]` is a POSIX class in RE2 and seven literal
 * characters in JavaScript), and always unbounded in time (V8 runs
 * `^(a+)+$` for 20 seconds at 32 characters, and longer above
 * that).
 *
 * A pattern translator and then a write-time deny-list were both
 * tried. Each closed some of that and left the rest, and every new
 * measurement moved which. Restoring this one table entry restores
 * **all** of it, silently, with no other diff — so anyone reaching
 * for it should read `docs/cel-js/` and `CLAUDE.md`'s *CEL is
 * bounded by cel-js* first. Regex comes back with a cel-js whose
 * `matches` is RE2, and not before.
 */
const CEL_GO_MEMBER_CALLS: ReadonlySet<string> = new Set([
  "all",
  "contains",
  "endsWith",
  "exists",
  "exists_one",
  "filter",
  "getDate",
  "getDayOfMonth",
  "getDayOfWeek",
  "getDayOfYear",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "in_cidr",
  "map",
  "size",
  "startsWith",
]);

/**
 * The two sets above, exported for the enumeration test.
 *
 * `conditions.test.ts` diffs them against `getDefinitions()` on the
 * live cel-js environment and fails on any name in one and not the
 * other. That is what keeps this transcription honest across a
 * cel-js upgrade: the surface it describes is the *difference*
 * between two libraries, and a difference nobody measures is a
 * divergence nobody knows about.
 */
export const CEL_GO_DECLARED_CALLS: Readonly<{
  global: ReadonlySet<string>;
  member: ReadonlySet<string>;
}> = { global: CEL_GO_GLOBAL_CALLS, member: CEL_GO_MEMBER_CALLS };

/**
 * Refuse a call cel-go's environment does not declare.
 *
 * cel-js's base environment ships the equivalent of cel-go's
 * `ext.Strings()` and `ext.Bindings()` libraries — `split`,
 * `substring`, `trim`, `indexOf`, `lastIndexOf`, `lowerAscii`,
 * `upperAscii`, `join`, `cel.bind` — and OpenFGA enables neither,
 * so a condition naming one of them is a model OpenFGA refuses to
 * store. It refuses it at `WriteAuthorizationModel`, because
 * `cel.EagerlyValidateDeclarations(true)` compiles every condition
 * against its declared parameters while the model is validated
 * (issue 381).
 *
 * There is no way to *remove* a function from cel-js: registries
 * lock on clone, there is no `deleteFunction`, and `stdlib` has no
 * opt-out. An allow-list applied to the parse is the only mechanism
 * available, and it is the same mechanism whatever cel-js adds
 * next — a name nobody has enumerated is refused because it is
 * absent from the transcription, not because someone thought of it.
 */
function refuseUndeclaredCall(name: string, receiver: boolean): void {
  const declared = receiver ? CEL_GO_MEMBER_CALLS : CEL_GO_GLOBAL_CALLS;
  if (declared.has(name)) return;
  throw new Error(`undeclared reference to '${name}' (in container '')`);
}

/**
 * Walk the parsed expression and refuse every call cel-go's
 * environment does not declare.
 *
 * The gate asks one question of one node — *which function is
 * this?* — so it reads no source text, masks no comments and knows
 * nothing about where a call sits. It is the whole of the
 * allow-list's reach into the AST, and it stands alone so the
 * allow-list stays a separable refusal rather than a side effect
 * of a walk that exists to do something else.
 *
 * Comprehension macros (`all`, `exists`, `exists_one`, `filter`,
 * `map`) are ordinary `rcall` nodes carrying their body in the
 * argument list, so the argument loop reaches it. A walk that
 * descended only into the receiver would leave every macro body
 * ungated.
 */
function refuseUndeclaredCalls(node: ASTNode): void {
  switch (node.op) {
    case "value":
    case "id":
      return;

    case ".":
    case ".?":
      refuseUndeclaredCalls(node.args[0]);
      return;

    case "!_":
    case "-_":
      refuseUndeclaredCalls(node.args);
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
      refuseUndeclaredCalls(node.args[0]);
      refuseUndeclaredCalls(node.args[1]);
      return;

    case "?:":
      refuseUndeclaredCalls(node.args[0]);
      refuseUndeclaredCalls(node.args[1]);
      refuseUndeclaredCalls(node.args[2]);
      return;

    case "list":
      for (const item of node.args) refuseUndeclaredCalls(item);
      return;

    case "map":
      for (const [key, value] of node.args) {
        refuseUndeclaredCalls(key);
        refuseUndeclaredCalls(value);
      }
      return;

    case "call": {
      const [name, args] = node.args;
      refuseUndeclaredCall(name, false);
      for (const argument of args) refuseUndeclaredCalls(argument);
      return;
    }

    case "rcall": {
      const [name, receiver, args] = node.args;
      refuseUndeclaredCall(name, true);
      refuseUndeclaredCalls(receiver);
      for (const argument of args) refuseUndeclaredCalls(argument);
      return;
    }

    default:
      return;
  }
}

/** One name replaced, as a half-open range of the source text. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * The expression with every comment blanked out, character for
 * character.
 *
 * The splicer reads the source text around a call site, and CEL's
 * `//` comment may sit anywhere whitespace may — including between
 * a receiver and its `.`. Blanking rather than removing keeps every
 * offset equal to the one cel-js reported, so the mask and the AST
 * agree on where everything is.
 *
 * String literals are stepped over rather than blanked: their
 * contents are never scanned, but a `//` inside one is not a
 * comment and must not start one.
 */
function maskComments(source: string): string {
  let masked = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;
    if (char === '"' || char === "'") {
      const previous = source[index - 1];
      const raw = previous === "r" || previous === "R";
      const triple = char.repeat(3);
      const quote = source.startsWith(triple, index) ? triple : char;
      masked += quote;
      index += quote.length;
      while (index < source.length) {
        if (!raw && source[index] === "\\" && index + 1 < source.length) {
          masked += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (source.startsWith(quote, index)) {
          masked += quote;
          index += quote.length;
          break;
        }
        masked += source[index];
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/**
 * Where a receiver call's method name sits in the source, or
 * `null`.
 *
 * Scanned **backwards from the first argument**, not forwards from
 * the receiver: cel-js ends a parenthesised expression's range
 * *inside* the closing paren, so `(s).matches(r)` puts a `)`
 * between the receiver's end and the name and a forward scan gave
 * up — leaving the call bound to cel-js's own `matches` and its
 * JavaScript `RegExp` semantics, which is issue 020 reopened behind
 * one pair of parentheses (issue 240). The argument side has no
 * such ambiguity: whatever the receiver's spelling, the bytes
 * between the name and the first argument are `(`, whitespace and
 * comments, and nothing else. Extra parens are consumed because a
 * parenthesised argument reports its range inside them too.
 */
function findReceiverCallName(
  masked: string,
  name: string,
  firstArgumentStart: number,
): { start: number; end: number } | null {
  let index = firstArgumentStart - 1;
  while (isSpace(masked[index])) index -= 1;
  if (masked[index] !== "(") return null;
  while (masked[index] === "(") {
    index -= 1;
    while (isSpace(masked[index])) index -= 1;
  }
  const end = index + 1;
  const start = end - name.length;
  if (start < 0 || masked.slice(start, end) !== name) return null;
  let before = start - 1;
  while (isSpace(masked[before])) before -= 1;
  if (masked[before] !== ".") return null;
  return { start, end };
}

/**
 * Refuse a constant pattern RE2 itself refuses.
 *
 * cel-go's `regexOptimizer` compiles every `matches` call whose
 * pattern is a literal while the program is built, so upstream
 * rejects the *model* rather than every check that reads it. tsfga
 * does the same here, at `writeConditionDefinition` (issue 241).
 *
 * A pattern RE2 accepts and this translator cannot spell stays a
 * run-time concern: refusing it here would refuse a model upstream
 * accepts. A non-constant pattern is not compiled at all —
 * upstream's optimiser only folds constants either.
 */
function refuseUncompilableConstantPattern(pattern: string): void {
  try {
    compileRe2(pattern);
  } catch (error) {
    if (error instanceof Re2PatternError && error.kind === "untranslatable") {
      return;
    }
    throw error;
  }
}

/**
 * Compile a rewritten call's pattern argument when it is a string
 * literal, in whichever position that spelling puts it.
 *
 * Called from **both** branches of `collectSplices`. Calling it
 * from the receiver branch alone stored a globally written pattern
 * RE2 cannot compile, which was harmless only for as long as the
 * global spelling did not resolve at all — the moment it is
 * rewritten, an uncompiled pattern is a wrong answer rather than a
 * refusal, which is why issues 320 and 321 are one change.
 */
function refuseConstantPatternArgument(
  rewrite: Rewrite,
  args: readonly ASTNode[],
): void {
  if (rewrite.patternArgument === null) return;
  const pattern = args[rewrite.patternArgument];
  if (
    pattern !== undefined &&
    pattern.op === "value" &&
    typeof pattern.args === "string"
  ) {
    refuseUncompilableConstantPattern(pattern.args);
  }
}

/** One walk of one expression. */
interface SpliceScan {
  readonly source: string;
  /** `source` with its comments blanked; see `maskComments`. */
  readonly masked: string;
  readonly out: Splice[];
}

function unplaceableCall(name: string): string {
  return (
    `cannot locate the call site of '${name}' in the expression, ` +
    `so it cannot be rewritten onto tsfga's implementation`
  );
}

/**
 * Find every call this module owns an implementation for.
 *
 * The allow-list used to ride along on this walk. It has its own
 * now (`refuseUndeclaredCalls`), which runs first, so by the time
 * this one starts every name in the expression is one cel-go
 * declares.
 *
 * The rewrite is a **source-text splice**, not an AST edit: only
 * the function's name moves, every other byte of the author's
 * expression survives untouched, and nothing depends on cel-js's
 * serializer round-tripping a literal the way it was written.
 *
 * A call this module owns and cannot place **raises** rather than
 * being left alone, in **either** style. cel-js refuses to let a
 * built-in overload be replaced, so an unspliced `int` or receiver
 * `matches` does not fail to resolve — it resolves to cel-js's own
 * implementation, which is the silent wrong answer the whole
 * module exists to remove. A loud refusal is the only other option
 * there is, and the global spelling inherits the rule rather than
 * relying on cel-js having no global overload to fall onto.
 */
function collectSplices(node: ASTNode, scan: SpliceScan): void {
  switch (node.op) {
    case "value":
    case "id":
      return;

    case ".":
    case ".?":
      collectSplices(node.args[0], scan);
      return;

    case "!_":
    case "-_":
      collectSplices(node.args, scan);
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
      collectSplices(node.args[0], scan);
      collectSplices(node.args[1], scan);
      return;

    case "?:":
      collectSplices(node.args[0], scan);
      collectSplices(node.args[1], scan);
      collectSplices(node.args[2], scan);
      return;

    case "list":
      for (const item of node.args) collectSplices(item, scan);
      return;

    case "map":
      for (const [key, value] of node.args) {
        collectSplices(key, scan);
        collectSplices(value, scan);
      }
      return;

    case "call": {
      const [name, args] = node.args;
      const rewrite = REWRITES.get(name)?.call ?? null;
      if (rewrite !== null && args.length === rewrite.arity) {
        // A `call` node starts at its own name, so the name is the
        // first `name.length` bytes of the node.
        if (!scan.source.startsWith(name, node.range.start)) {
          throw new Error(unplaceableCall(name));
        }
        scan.out.push({
          start: node.range.start,
          end: node.range.start + name.length,
          text: rewrite.replacement,
        });
        // A literal pattern is compiled now, as cel-go's
        // `regexOptimizer` does while it builds the program.
        refuseConstantPatternArgument(rewrite, args);
      }
      for (const argument of args) collectSplices(argument, scan);
      return;
    }

    case "rcall": {
      const [name, receiver, args] = node.args;
      const rewrite = REWRITES.get(name)?.rcall ?? null;
      const first = args[0];
      if (
        rewrite !== null &&
        args.length === rewrite.arity &&
        first !== undefined
      ) {
        const site = findReceiverCallName(scan.masked, name, first.range.start);
        if (site === null) throw new Error(unplaceableCall(name));
        scan.out.push({ ...site, text: rewrite.replacement });
        refuseConstantPatternArgument(rewrite, args);
      }
      collectSplices(receiver, scan);
      for (const argument of args) collectSplices(argument, scan);
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
  collectSplices(ast, {
    source: expression,
    masked: maskComments(expression),
    out: splices,
  });
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
 * How each declared parameter type is spelled to cel-js's type
 * checker.
 *
 * Four of the eight are spelled the same in both. A `duration` and
 * a `timestamp` are protobuf well-known types and carry their full
 * names, and `any` is CEL's `dyn` — the type that checks against
 * everything, which is what an `any` parameter means.
 */
const CEL_TYPE_NAMES: Readonly<Record<ConditionParameterScalarType, string>> = {
  any: "dyn",
  bool: "bool",
  double: "double",
  duration: "google.protobuf.Duration",
  int: "int",
  string: "string",
  timestamp: "google.protobuf.Timestamp",
  uint: "uint",
};

/**
 * A declared parameter type as cel-js spells it, or `dyn` for
 * anything unrecognised.
 *
 * Unrecognised falls to `dyn` rather than refusing: the parameter
 * types are gated where a condition is written, and a checker that
 * refused what that gate admits would turn a stored row nobody can
 * fix into an outage. `dyn` checks against everything, so an
 * unreadable declaration costs coverage and never an answer.
 */
function celTypeName(type: ConditionParameterType): string {
  if (isScalarParameterType(type)) return CEL_TYPE_NAMES[type];
  const container = containerOf(type);
  if (container === null) return "dyn";
  const element = CEL_TYPE_NAMES[container.element];
  // A model's `map<T>` is keyed by string; only the value type is
  // spelled, exactly as OpenFGA's parameter grammar spells it.
  return container.kind === "list"
    ? `list<${element}>`
    : `map<string, ${element}>`;
}

/**
 * Refuse an expression that does not type-check against its
 * declared parameters.
 *
 * OpenFGA compiles every condition while it validates
 * `WriteAuthorizationModel` — `cel.EagerlyValidateDeclarations(true)`
 * on an environment carrying exactly the declared parameters — so
 * `n != 'a'` on an `int` parameter, or a reference to a parameter
 * that was never declared, is a **model-write** refusal upstream and
 * there is no model carrying it for a check to read. tsfga parsed
 * and did not check, so all seven shapes issue 388 reports answered,
 * and four of them granted.
 *
 * Two things make this reachable without tsfga writing a checker of
 * its own: cel-js 8.0.0 exposes a typed `check()`, and its
 * environment can be cloned with `unlistedVariablesAreDyn` turned
 * **off** — which is what makes an undeclared reference an error
 * rather than a `dyn`. `n > 0 || other > 0` is the cell that needs
 * both: cel-js short-circuits the `||` before `other` is ever
 * evaluated, so it used to grant with no error anywhere.
 *
 * The check runs on the **rewritten** expression, where `int(…)`,
 * `double(…)` and `matches(…)` name tsfga's own overloads. Checking
 * the author's spelling instead would refuse `int(d)` and
 * `int(t)` — overloads cel-go declares, cel-js does not, and this
 * module supplies.
 */
function refuseUntypedExpression(
  expression: string,
  parameters: Readonly<Record<string, ConditionParameterType>>,
): void {
  const strict = typeVerdict(expression, parameters, false);
  if (strict === null) return;
  // A verdict that only stands while a temporal type is known is
  // not tsfga's to enforce; see `hasUntrustedType`.
  if (hasUntrustedType(parameters)) {
    if (typeVerdict(expression, parameters, true) === null) return;
  }
  throw new Error(strict);
}

/**
 * The types cel-js declares differently from cel-go, and whose
 * verdicts are therefore not enforced.
 *
 * Exactly one declaration is wrong, and it is enough to reach both
 * of them: cel-js gives `duration + timestamp` the return type
 * **Duration**, where cel-go's `add_duration_timestamp` gives
 * Timestamp. So `d + t > t` — a comparison upstream compiles — is
 * a type error here, and no `registerOperator` can repair it
 * because cel-js refuses to replace an overload that exists
 * ("Operator overload already registered"). The value cel-js
 * *computes* is right; only the declaration is wrong.
 *
 * Rather than special-case the one shape, the rule is stated the
 * way it will still be true after the next cel-js release: where
 * the two libraries' declarations are known to disagree, a
 * refusal is not tsfga's to make. An expression naming a temporal
 * parameter is re-checked with those parameters as `dyn`, and is
 * accepted when the disagreement was the only thing between it and
 * a verdict. Everything else about it is still checked, and an
 * expression with no temporal parameter is unaffected.
 */
const CEL_JS_UNTRUSTED_TYPES: ReadonlySet<string> = new Set([
  "duration",
  "timestamp",
]);

function hasUntrustedType(
  parameters: Readonly<Record<string, ConditionParameterType>>,
): boolean {
  for (const type of Object.values(parameters)) {
    const container = containerOf(type);
    const element = container === null ? type : container.element;
    if (CEL_JS_UNTRUSTED_TYPES.has(element)) return true;
  }
  return false;
}

/**
 * cel-js's verdict on one expression, or `null` when it has none
 * to give — which is what "this type-checks" looks like.
 *
 * `degradeTemporal` declares every temporal parameter as `dyn`
 * instead of as its own type.
 */
function typeVerdict(
  expression: string,
  parameters: Readonly<Record<string, ConditionParameterType>>,
  degradeTemporal: boolean,
): string | null {
  const typed = env.clone({
    unlistedVariablesAreDyn: false,
    homogeneousAggregateLiterals: false,
  });
  // Declared by OpenFGA and absent from cel-js, so the checker
  // would report an overload error on a model upstream accepts.
  // The bodies are never reached: `check` does not evaluate, and
  // the environment that does evaluate is the module's own, where
  // neither name resolves — which is the documented gap.
  typed.registerFunction("ipaddress(string): dyn", () => null);
  typed.registerFunction("dyn.in_cidr(string): bool", () => false);
  for (const [name, type] of Object.entries(parameters)) {
    const declared = celTypeName(type);
    const untrusted = CEL_JS_UNTRUSTED_TYPES.has(type);
    typed.registerVariable(
      name,
      degradeTemporal && untrusted ? "dyn" : declared,
    );
  }
  let result: ReturnType<typeof typed.check>;
  try {
    result = typed.check(expression);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!result.valid) {
    return result.error?.message ?? `'${expression}' does not type-check`;
  }
  // Upstream's own words for the same refusal. A `dyn` result is
  // accepted: the expression's type is unknown, not known to be
  // something other than a bool, and upstream's checker admits it
  // for the same reason.
  if (result.type === undefined) return null;
  if (result.type === "bool" || result.type === "dyn") return null;
  const got = result.type;
  return `expected a bool condition expression output, but got '${got}'`;
}

/**
 * Type-check a compiled expression when its declarations are in
 * hand, raising `ConditionCompileError` in the one class the write
 * path already reports.
 *
 * `ast.input` is the source cel-js parsed, which is the *rewritten*
 * expression whenever a rewrite happened — the text the checker has
 * to read, and the one place it survives.
 */
function typeCheck(
  conditionName: string,
  compiled: ParseResult,
  parameters:
    | Readonly<Record<string, ConditionParameterType>>
    | null
    | undefined,
): void {
  if (parameters === undefined || parameters === null) return;
  try {
    refuseUntypedExpression(compiled.ast.input, parameters);
  } catch (error) {
    throw new ConditionCompileError(conditionName, error);
  }
}

/**
 * Compile an expression, or raise `ConditionCompileError`.
 *
 * The one place `parse` is called on a stored expression, so that
 * a parse failure has exactly one error class wherever it is
 * discovered. It used to be called outside the `try` that wraps
 * evaluation, which let cel-js's own `ParseError` — not a
 * `TsfgaError` — escape `check()`.
 *
 * `parameters` is what a caller holding the whole definition — the
 * write path — passes to have the expression **type-checked**
 * against its declarations, as upstream's model write does. It is
 * deliberately absent on the read path: the type check is a
 * property of the definition, not of the expression, so two
 * conditions sharing an expression and declaring different
 * parameters must each be checked, and neither may read the
 * other's verdict out of the expression cache. Passing it costs
 * one environment clone per write and nothing per check.
 */
export function compileCondition(
  conditionName: string,
  expression: string,
  parameters?: Readonly<Record<string, ConditionParameterType>> | null,
): ParseResult {
  const cached = exprCache.get(expression);
  if (cached) {
    // Re-insert so the iteration order is least-recently-used
    // first. Eviction by insertion order alone would drop the
    // hottest expression in a workload that cycles through more
    // than the bound, which is the case the bound exists for.
    exprCache.delete(expression);
    exprCache.set(expression, cached);
    typeCheck(conditionName, cached, parameters);
    return cached;
  }
  let compiled: ParseResult;
  try {
    compiled = env.parse(expression);
    // Inside this `try` on purpose: `refuseUndeclaredCalls` throws
    // a bare `Error`, and this `catch` is the only thing that
    // launders one into a `ConditionCompileError`. Called a line
    // above, a non-`TsfgaError` escapes `writeConditionDefinition`.
    refuseUndeclaredCalls(compiled.ast);
    const rewritten = rewriteCalls(expression, compiled.ast);
    if (rewritten !== expression) compiled = env.parse(rewritten);
  } catch (error) {
    throw new ConditionCompileError(conditionName, error);
  }
  typeCheck(conditionName, compiled, parameters);
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

/** One term of a duration: digits, an optional fraction, a unit. */
const DURATION_TERM = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g;

/** Each unit in nanoseconds, as `time.unitMap` spells it. */
const DURATION_UNIT_NS: Readonly<Record<string, bigint>> = {
  ns: 1n,
  us: 1000n,
  µs: 1000n,
  μs: 1000n,
  ms: 1000000n,
  s: 1000000000n,
  m: 60000000000n,
  h: 3600000000000n,
};

/**
 * `time.ParseDuration`'s accumulator bound.
 *
 * The sum is built in a `uint64` and checked against `1<<63` after
 * every term; the sign is applied last, so the negative extreme is
 * exactly `-2^63` and the positive one `2^63 - 1`.
 */
const DURATION_MAX_NS = 2n ** 63n;

/**
 * Whether a duration string names more nanoseconds than an int64
 * holds (issue 420).
 *
 * Upstream's converter is `time.ParseDuration` and nothing else,
 * and it errors the moment its accumulator overflows — so a value
 * past the bound is refused as the context is *read*, before any
 * expression runs and with no arithmetic anywhere in the
 * condition. tsfga validated Go's grammar with `DURATION` and
 * never the magnitude, which let a check answer `true` on a value
 * upstream declines to read, and let the write gate store a tuple
 * upstream will not store at all.
 *
 * The bound is on the **sum**: `2400000h2400000h` is two terms
 * each inside the range whose total is not. The terms are summed
 * in a `bigint` rather than a float, and a fraction is truncated
 * as Go's `uint64` conversion truncates.
 *
 * Only the magnitude is decided here. A string this cannot parse
 * is left to the grammar gate and to cel-js, so no spelling either
 * of them refuses becomes acceptable by passing through.
 */
function durationExceedsInt64(value: string): boolean {
  let total = 0n;
  DURATION_TERM.lastIndex = 0;
  for (;;) {
    const term = DURATION_TERM.exec(value);
    if (term === null) break;
    const digits = term[1];
    const suffix = term[2];
    if (digits === undefined || suffix === undefined) return false;
    const unit = DURATION_UNIT_NS[suffix];
    if (unit === undefined) return false;
    const dot = digits.indexOf(".");
    const whole = dot === -1 ? digits : digits.slice(0, dot);
    const fraction = dot === -1 ? "" : digits.slice(dot + 1);
    // 2^63 is nineteen digits, so twenty of them overflow whatever
    // the unit is. Said before the `BigInt`, because a caller
    // chooses the length of the string.
    if (whole.length > 20) return true;
    const scaled = whole === "" ? 0n : BigInt(whole);
    if (scaled > DURATION_MAX_NS / unit) return true;
    let nanos = scaled * unit;
    // Past twenty fractional digits nothing survives the scaling:
    // the largest unit is 3.6e12 nanoseconds.
    const kept = fraction.slice(0, 20);
    if (kept !== "") {
      nanos += (BigInt(kept) * unit) / 10n ** BigInt(kept.length);
      if (nanos > DURATION_MAX_NS) return true;
    }
    total += nanos;
    if (total > DURATION_MAX_NS) return true;
  }
  if (value.startsWith("-")) return false;
  return total > DURATION_MAX_NS - 1n;
}

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
 *
 * It gates the **shape** and nothing else, deliberately. The field
 * ranges are Go's and they are not the ones a regex would express
 * — the day depends on the month and the year, and the zone
 * offset's minute is bounded at 60 rather than 59 — so they are
 * checked in `asTimestamp` against the calendar (issues 421, 423).
 */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

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

/** Days in a month, with Gregorian's leap rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * A timestamp string as a `Date`, or `null`.
 *
 * Built here rather than through cel-js's `timestamp()`, which
 * refuses any spelling longer than 30 characters — ten fractional
 * digits are enough — where upstream keeps nanoseconds and
 * discards the rest of whatever it is given.
 *
 * The components are checked against the calendar rather than
 * handed to `new Date`, because `new Date` **normalises where Go
 * refuses** (issue 421): `2026-02-30T00:00:00Z` is March 2 and
 * `2026-01-01T24:00:00Z` is the next midnight, so a date that does
 * not exist used to become a different instant and the condition
 * was evaluated against it. `time.Parse` reports "day out of
 * range" and "hour out of range" instead, and the check refuses.
 *
 * Only the spellings JavaScript is willing to roll over leaked —
 * `2026-01-32`, `2026-13-01` and `T00:60:00` were already
 * `Invalid Date` — which is why this is a component parser and not
 * a stricter regex. A stricter regex would also have pinned the
 * divergence in the other direction: Go's range tests on the zone
 * offset "use > rather than >=, as some people do write offsets of
 * 24 hours or 60 minutes", so `+00:60` is one hour to upstream and
 * `Invalid Date` to `new Date` (issue 423). The offset is applied
 * as written here, and only `+24:00` / `+00:60` and beyond refuse.
 *
 * The bounds on the resulting instant are CEL's, and are the ones
 * cel-js would have applied.
 */
function asTimestamp(value: string): Date | null {
  const parts = RFC3339.exec(value);
  if (!parts) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = parts;
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    return null;
  }
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (offsetSign !== undefined) {
    if (offsetHourText === undefined || offsetMinuteText === undefined) {
      return null;
    }
    const offsetHour = Number.parseInt(offsetHourText, 10);
    const offsetMinute = Number.parseInt(offsetMinuteText, 10);
    if (offsetHour > 24 || offsetMinute > 60) return null;
    const magnitude = offsetHour * 60 + offsetMinute;
    offsetMinutes = offsetSign === "-" ? -magnitude : magnitude;
  }

  // Every field is now in range, so the canonical spelling is one
  // `Date.parse` reads the same way Go would — and the fraction
  // keeps whatever truncation a `Date` has always applied to it.
  const canonical =
    `${yearText}-${monthText}-${dayText}` +
    `T${hourText}:${minuteText}:${secondText}${fraction ?? ""}Z`;
  const utc = Date.parse(canonical);
  if (Number.isNaN(utc)) return null;
  const time = utc - offsetMinutes * 60000;
  if (time < TIMESTAMP_MIN || time > TIMESTAMP_MAX) return null;
  return new Date(time);
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
      // The grammar is not the whole gate: `time.ParseDuration`
      // counts nanoseconds in an int64 and errors on overflow, so
      // a well-spelled duration too large to hold is refused as
      // the context is read (issue 420).
      if (durationExceedsInt64(value)) {
        refuse("a duration within int64 nanoseconds");
      }
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

// ---------------------------------------------------------------
// The evaluation cost budget (issues 402 / 444)
// ---------------------------------------------------------------

/**
 * cel-go's cost constants, transcribed from `common/cost.go` at the
 * version OpenFGA v1.18.2 builds against (cel-go v0.29.2; read at
 * v0.26.1, where the file is unchanged).
 *
 * They are spelled out here rather than folded into the call sites
 * because the whole model is a transcription: a reader checking it
 * against `interpreter/runtimecost.go` should find the same names.
 */
const SELECT_AND_IDENT_COST = 1;
const LIST_CREATE_BASE_COST = 10;
const MAP_CREATE_BASE_COST = 30;
const STRING_TRAVERSAL_COST_FACTOR = 0.1;
const REGEX_STRING_LENGTH_COST_FACTOR = 0.25;

/**
 * OpenFGA's `DefaultMaxConditionEvaluationCost`
 * (`pkg/server/config/config.go`), which it also refuses to start
 * below. tsfga does not floor it — see
 * `CheckOptions.maxConditionEvaluationCost`.
 */
export const DEFAULT_MAX_CONDITION_EVALUATION_COST = 100;

/**
 * A per-evaluation cost ceiling, as an options object rather than a
 * fourth positional: `evaluateTupleCondition` is re-exported from
 * `index.ts` and store authors call it directly.
 */
export interface ConditionEvaluationOptions {
  /** See `CheckOptions.maxConditionEvaluationCost`. */
  readonly maxConditionEvaluationCost?: number;
}

/**
 * The prefix every cost refusal's cause carries.
 *
 * `ConditionEvaluationError.cause` is free-form by design, so the
 * one refusal tsfga raises there on its own account is told apart
 * by this string and not by a cause value. The same sentence is
 * written on the error class and on the option; this constant is
 * what keeps the three from drifting.
 */
const COST_REFUSAL = "evaluation cost limit exceeded";

/**
 * Validate `maxConditionEvaluationCost` and resolve its default.
 *
 * The same negated predicate the other five options use, so `NaN`
 * is rejected rather than admitted — a `NaN` ceiling would compare
 * false against every cost and silently remove the budget from a
 * caller who was setting one. A fraction would admit a cost above
 * the stated figure, and `0` is a budget no expression evaluates
 * inside, because a bare identifier already costs 1.
 *
 * **Not floored at 100.** Upstream floors a *server's*
 * configuration; tsfga is a library and a caller who sets 50 means
 * 50.
 */
export function resolveMaxConditionEvaluationCost(
  options?: ConditionEvaluationOptions,
): number {
  const limit =
    options?.maxConditionEvaluationCost ??
    DEFAULT_MAX_CONDITION_EVALUATION_COST;
  if (
    !(limit >= 1) ||
    (limit !== Number.POSITIVE_INFINITY && !Number.isInteger(limit))
  ) {
    throw new TsfgaError(
      "maxConditionEvaluationCost must be a positive integer or " +
        `Infinity, got ${limit}`,
    );
  }
  return limit;
}

/** `ceil(n * 0.1)`, cel-go's charge for traversing `n` units. */
function traversal(size: number): number {
  return Math.ceil(size * STRING_TRAVERSAL_COST_FACTOR);
}

/** Whether a value is a `{}`-shaped map rather than a class. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * cel-go's `actualSize`: a `Sizer`'s size, and 1 for everything
 * else.
 *
 * A string is sized in **code points**, because cel-go's
 * `String.Size()` is `len([]rune(s))` — so an astral character is
 * one unit here and two UTF-16 units in `String.length`.
 */
function valueSize(value: unknown): number {
  if (typeof value === "string") {
    let points = 0;
    for (const _ of value) points += 1;
    return points;
  }
  if (Array.isArray(value)) return value.length;
  if (value instanceof Uint8Array) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return 1;
}

/** How deep `contextCeiling` reads before it stops descending. */
const CONTEXT_SCAN_DEPTH = 8;

/**
 * The size charged for a value the pre-pass cannot resolve.
 *
 * The largest size anywhere in the coerced context, which is the
 * "larger plausible value" rule the approximation is built on: a
 * node whose value is computed cannot be bigger than the biggest
 * thing the request carried, unless the expression built it, and
 * the shapes that build one — concatenation, a comprehension's
 * output — are sized from their operands instead.
 */
function contextCeiling(value: unknown, depth: number): number {
  let largest = valueSize(value);
  if (depth >= CONTEXT_SCAN_DEPTH) return largest;
  if (Array.isArray(value)) {
    for (const item of value) {
      largest = Math.max(largest, contextCeiling(item, depth + 1));
    }
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) {
      largest = Math.max(largest, contextCeiling(item, depth + 1));
    }
  }
  return largest;
}

/** What one node charges, and how large its value is. */
interface Charge {
  readonly cost: number;
  readonly size: number;
}

interface CostScope {
  readonly context: Readonly<Record<string, unknown>>;
  /** `contextCeiling` over the whole context, at least 1. */
  readonly unknown: number;
  /** Comprehension iteration variables, by the size they carry. */
  readonly bindings: ReadonlyMap<string, number>;
}

/**
 * The comprehension macros. cel-js parses each as an `rcall` whose
 * arguments are the iteration variable and the body, so the body's
 * cost is charged once per element of the receiver.
 */
const COMPREHENSION_MACROS: ReadonlySet<string> = new Set([
  "all",
  "exists",
  "exists_one",
  "filter",
  "map",
]);

/**
 * The value a node evaluates to, when the pre-pass can reach it
 * without evaluating anything — a literal, a context variable, or a
 * constant path into one. `undefined` means "not resolvable", which
 * is why a literal `null` is returned as `null`.
 */
function resolveValue(node: ASTNode, scope: CostScope): unknown {
  switch (node.op) {
    case "value":
      return node.args;
    case "id":
      return node.args in scope.context ? scope.context[node.args] : undefined;
    case ".":
    case ".?": {
      const receiver = resolveValue(node.args[0], scope);
      if (!isPlainObject(receiver)) return undefined;
      return receiver[node.args[1]];
    }
    case "[]":
    case "[?]": {
      const target = resolveValue(node.args[0], scope);
      const key = resolveValue(node.args[1], scope);
      if (typeof key === "string" && isPlainObject(target)) return target[key];
      if (typeof key === "bigint" && Array.isArray(target)) {
        return target[Number(key)];
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The size of a node's value, falling back to the ceiling. */
function resolvedSize(node: ASTNode, scope: CostScope): number {
  const value = resolveValue(node, scope);
  return value === undefined ? scope.unknown : valueSize(value);
}

/**
 * The largest element of a resolvable list, for the iteration
 * variable of a comprehension over it.
 */
function elementCeiling(node: ASTNode, scope: CostScope): number {
  const value = resolveValue(node, scope);
  if (!Array.isArray(value)) return scope.unknown;
  let largest = 1;
  for (const item of value) largest = Math.max(largest, valueSize(item));
  return largest;
}

function chargeAll(nodes: readonly ASTNode[], scope: CostScope): Charge[] {
  return nodes.map((node) => chargeNode(node, scope));
}

function sumCost(charges: readonly Charge[]): number {
  let total = 0;
  for (const charge of charges) total += charge.cost;
  return total;
}

/**
 * How wide a scalar rendered by `string()` is charged as. Long
 * enough for an RFC 3339 timestamp with nanoseconds, which is the
 * widest cel-go produces.
 */
const FORMATTED_SCALAR_SIZE = 32;

/** The loop bookkeeping a comprehension charges per element. */
const COMPREHENSION_STEP_COST = 1;

/**
 * Charge a function call, receiver folded in as operand 0 — which
 * is where cel-go's runtime cost model finds it too: a member
 * overload's `args[0]` *is* the receiver.
 */
function chargeCall(
  name: string,
  operands: readonly ASTNode[],
  scope: CostScope,
): Charge {
  const parts = chargeAll(operands, scope);
  const base = sumCost(parts);
  const first = parts[0]?.size ?? 1;
  const second = parts[1]?.size ?? 1;
  switch (name) {
    // `tsfga_re2_matches` is what `rewriteCalls` renames both
    // spellings of `matches` to; the author's own name never
    // reaches an evaluation, but it is priced here too so the
    // model reads the same as cel-go's.
    case "matches":
    case "tsfga_re2_matches": {
      // cel-go adds one to the subject's length so an empty
      // subject against an expensive pattern is not free.
      const subject = traversal(1 + first);
      const pattern = Math.ceil(second * REGEX_STRING_LENGTH_COST_FACTOR);
      return { cost: base + subject * pattern, size: 1 };
    }
    case "contains":
      return {
        cost: base + traversal(first) * traversal(second),
        size: 1,
      };
    case "startsWith":
    case "endsWith":
      return { cost: base + traversal(first), size: 1 };
    case "bytes":
      return { cost: base + traversal(first), size: first };
    case "string":
      // `string(bytes)` traverses; the scalar conversions do not,
      // and `traversal(1)` is 1 either way. The *result* is sized
      // at the widest a formatted scalar reaches, because a
      // timestamp renders as 20-odd characters from a value of
      // size 1 and sizing it at 1 would under-charge a comparison
      // against it.
      return {
        cost: base + traversal(first),
        size: Math.max(first, FORMATTED_SCALAR_SIZE),
      };
    default:
      // Every other declared function is O(1) in cel-go's model,
      // including the conversions, `size()`, `has()` and `type()`.
      return { cost: base + 1, size: 1 };
  }
}

function chargeComprehension(
  name: string,
  receiver: ASTNode,
  args: readonly ASTNode[],
  scope: CostScope,
): Charge {
  const source = chargeNode(receiver, scope);
  const iterations = source.size;
  const [iterVar, ...body] = args;
  const bindings = new Map(scope.bindings);
  if (iterVar !== undefined && iterVar.op === "id") {
    bindings.set(iterVar.args, elementCeiling(receiver, scope));
  }
  const inner: CostScope = { ...scope, bindings };
  const perElement = sumCost(chargeAll(body, inner)) + COMPREHENSION_STEP_COST;
  return {
    cost: source.cost + iterations * perElement,
    // `map` and `filter` produce a list; the predicates produce a
    // bool. `filter` returns at most as many elements as it read.
    size: name === "map" || name === "filter" ? iterations : 1,
  };
}

/**
 * cel-go's runtime cost for one node and its subtree, charged
 * against the coerced context.
 *
 * Transcribed from `interpreter/runtimecost.go` — `costTrackerFactory.
 * Observe` for the per-node charges and `CostTracker.costCall` for
 * the per-overload ones. Three places it deliberately differs, all
 * of them **over**-charging, which is the direction the residue is
 * required to fail in:
 *
 * - **No short-circuit.** Both arms of `||` and `&&` and all three
 *   of a ternary are charged, where cel-go charges only what it
 *   evaluated. A pre-pass cannot know which arm runs without
 *   running it, and this is the price of refusing *before* the work
 *   rather than after.
 * - **Computed sizes.** `+` on strings is sized exactly, a
 *   comprehension's output at its input, and anything else the
 *   walk cannot reach at the largest value the request carried.
 * - **Operators whose overload cel-go prices at 1** — `in` over a
 *   map, `+` over a list — are priced by size here, because the
 *   pre-pass has no types.
 */
function chargeNode(node: ASTNode, scope: CostScope): Charge {
  switch (node.op) {
    // A constant is free (`ConstCost`), and it is the one place a
    // size is known exactly.
    case "value":
      return { cost: 0, size: valueSize(node.args) };

    case "id": {
      const bound = scope.bindings.get(node.args);
      if (bound !== undefined) {
        return { cost: SELECT_AND_IDENT_COST, size: bound };
      }
      return {
        cost: SELECT_AND_IDENT_COST,
        size: resolvedSize(node, scope),
      };
    }

    case ".":
    case ".?": {
      const receiver = chargeNode(node.args[0], scope);
      return {
        cost: receiver.cost + SELECT_AND_IDENT_COST,
        size: resolvedSize(node, scope),
      };
    }

    // An index is a `Qualifier`, which costs one.
    case "[]":
    case "[?]": {
      const parts = chargeAll(node.args, scope);
      return { cost: sumCost(parts) + 1, size: resolvedSize(node, scope) };
    }

    case "!_":
    case "-_": {
      const operand = chargeNode(node.args, scope);
      return { cost: operand.cost + 1, size: 1 };
    }

    // `evalOr` / `evalAnd` have no charge of their own.
    case "||":
    case "&&": {
      const parts = chargeAll(node.args, scope);
      return { cost: sumCost(parts), size: 1 };
    }

    // Nor has a ternary: all of its cost is in its three arms.
    case "?:": {
      const parts = chargeAll(node.args, scope);
      const truthy = parts[1]?.size ?? 1;
      const falsy = parts[2]?.size ?? 1;
      return { cost: sumCost(parts), size: Math.max(truthy, falsy) };
    }

    // O(min(m, n)): the shorter operand decides, because a
    // comparison stops at the first difference. On two scalars both
    // sizes are 1 and `traversal(1)` is 1, which is the cost of
    // every fixed-width comparison in cel-go's default branch — so
    // one formula covers both.
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const parts = chargeAll(node.args, scope);
      const left = parts[0]?.size ?? 1;
      const right = parts[1]?.size ?? 1;
      return {
        cost: sumCost(parts) + traversal(Math.min(left, right)),
        size: 1,
      };
    }

    // `in_list` is charged one per element of the list. cel-go
    // prices `in_map` at 1 instead; this charges the map's entry
    // count there too, which over-charges and so is safe.
    case "in": {
      const parts = chargeAll(node.args, scope);
      const container = parts[1]?.size ?? 1;
      return { cost: sumCost(parts) + Math.max(1, container), size: 1 };
    }

    // O(m+n) on strings: the worst case reallocates and copies both
    // operands. `traversal(1 + 1)` is 1, so numeric addition lands
    // on cel-go's default charge of one without a type to check.
    case "+": {
      const parts = chargeAll(node.args, scope);
      const left = parts[0]?.size ?? 1;
      const right = parts[1]?.size ?? 1;
      return {
        cost: sumCost(parts) + traversal(left + right),
        size: left + right,
      };
    }

    case "-":
    case "*":
    case "/":
    case "%": {
      const parts = chargeAll(node.args, scope);
      return { cost: sumCost(parts) + 1, size: 1 };
    }

    case "list": {
      const parts = chargeAll(node.args, scope);
      return {
        cost: sumCost(parts) + LIST_CREATE_BASE_COST,
        size: node.args.length,
      };
    }

    case "map": {
      let cost = MAP_CREATE_BASE_COST;
      for (const [key, value] of node.args) {
        cost += chargeNode(key, scope).cost + chargeNode(value, scope).cost;
      }
      return { cost, size: node.args.length };
    }

    case "call":
      return chargeCall(node.args[0], node.args[1], scope);

    case "rcall": {
      const [name, receiver, args] = node.args;
      if (COMPREHENSION_MACROS.has(name)) {
        return chargeComprehension(name, receiver, args, scope);
      }
      return chargeCall(name, [receiver, ...args], scope);
    }

    default:
      // A node shape this transcription does not know. One unit,
      // and the ceiling for its size — the same fallback an
      // unresolvable value takes.
      return { cost: 1, size: scope.unknown };
  }
}

/**
 * What evaluating `ast` against `context` would cost cel-go.
 *
 * Exported for the unit tests, which state the calibration points
 * as numbers rather than as answers.
 */
export function estimateEvaluationCost(
  ast: ASTNode,
  context: Readonly<Record<string, unknown>>,
): number {
  let ceiling = 1;
  for (const value of Object.values(context)) {
    ceiling = Math.max(ceiling, contextCeiling(value, 0));
  }
  return chargeNode(ast, { context, unknown: ceiling, bindings: new Map() })
    .cost;
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
 *
 * It also refuses an expression whose estimated evaluation cost
 * exceeds `options.maxConditionEvaluationCost` (default 100,
 * upstream's `DefaultMaxConditionEvaluationCost`), raising a
 * `ConditionEvaluationError` whose cause begins `evaluation cost
 * limit exceeded`. The estimate is charged **before** evaluating,
 * where upstream cancels a program part-way through; both refuse,
 * and the cost model is an approximation of cel-go's that
 * over-charges where it cannot be exact. See
 * `CheckOptions.maxConditionEvaluationCost`.
 */
export async function evaluateTupleCondition(
  store: TupleStore,
  tuple: Tuple,
  requestContext?: Record<string, unknown>,
  options?: ConditionEvaluationOptions,
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

  // Before evaluating, not after: the budget exists to bound work
  // driven by whoever is asking, and a charge collected once the
  // work is done bounds nothing. The estimate is over the
  // *rewritten* AST — `compiled.ast` — which is the program that
  // actually runs.
  const maxCost = resolveMaxConditionEvaluationCost(options);
  if (maxCost !== Number.POSITIVE_INFINITY) {
    const cost = estimateEvaluationCost(compiled.ast, context);
    if (cost > maxCost) {
      throw new ConditionEvaluationError(
        condDef.name,
        new Error(
          `${COST_REFUSAL}: estimated ${cost} against a limit of ` +
            `${maxCost}`,
        ),
      );
    }
  }

  try {
    const result = compiled(context);
    return result === true;
  } catch (error) {
    throw new ConditionEvaluationError(condDef.name, error);
  }
}
