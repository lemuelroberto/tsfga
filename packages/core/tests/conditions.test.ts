import { describe, expect, test } from "bun:test";
import { Environment } from "@marcbachmann/cel-js";
import {
  CEL_GO_DECLARED_CALLS,
  coerceContext,
  compileCondition,
  EXPR_CACHE_MAX_ENTRIES,
  evaluateTupleCondition,
  hasCompiledExpression,
} from "../src/conditions.ts";
import {
  ConditionCompileError,
  ConditionEvaluationError,
  ConditionNotFoundError,
  TsfgaError,
} from "../src/errors.ts";
import { createTsfga } from "../src/index.ts";
import type { ConditionParameterType, Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

function makeTuple(overrides: Partial<Tuple> = {}): Tuple {
  return {
    objectType: "doc",
    objectId: "1",
    relation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...overrides,
  };
}

describe("evaluateTupleCondition", () => {
  test("returns true when tuple has no condition", async () => {
    const store = new MockTupleStore();
    const tuple = makeTuple();
    expect(await evaluateTupleCondition(store, tuple)).toBe(true);
  });

  test("returns true when condition evaluates to true", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      true,
    );
  });

  test("returns false when condition evaluates to false", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    expect(await evaluateTupleCondition(store, tuple, { region: "eu" })).toBe(
      false,
    );
  });

  test("tuple context takes precedence over request context", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({
      conditionName: "in_region",
      conditionContext: { region: "eu" },
    });
    // Tuple context overrides request context
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      false,
    );
  });

  test("uses tuple context when no request context", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({
      conditionName: "in_region",
      conditionContext: { region: "us" },
    });
    expect(await evaluateTupleCondition(store, tuple)).toBe(true);
  });

  test("throws when a condition parameter is missing", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    // Missing declared parameters are an evaluation ERROR, not an
    // unmet condition: OpenFGA's check path errors, and a silent
    // `false` would fail open through an exclusion branch.
    await expect(evaluateTupleCondition(store, tuple)).rejects.toBeInstanceOf(
      ConditionEvaluationError,
    );
    await expect(
      evaluateTupleCondition(store, tuple, {}),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("throws when one of several parameters is missing", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "region_and_tier",
      expression: 'region == "us" && tier == "gold"',
      parameters: { region: "string", tier: "string" },
    });
    const tuple = makeTuple({ conditionName: "region_and_tier" });
    await expect(
      evaluateTupleCondition(store, tuple, { region: "us" }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("throws ConditionNotFoundError for missing condition", async () => {
    const store = new MockTupleStore();
    const tuple = makeTuple({ conditionName: "nonexistent" });
    await expect(evaluateTupleCondition(store, tuple)).rejects.toBeInstanceOf(
      ConditionNotFoundError,
    );
  });

  test("throws ConditionEvaluationError for invalid expression", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "bad_expr",
      expression: "x + y",
      parameters: { x: "int", y: "int" },
    });
    const tuple = makeTuple({ conditionName: "bad_expr" });
    // Missing required context variables - should throw evaluation error
    // cel-js may return undefined or throw; we treat non-true as false
    // Let's test with a condition that definitely errors
    store.conditionDefinitions.length = 0;
    store.conditionDefinitions.push({
      name: "bad_expr",
      // `size` is declared — a made-up name would now be refused
      // by the declaration gate before anything was evaluated —
      // and there is no overload of it for an int, so this fails
      // where the test means it to: at evaluation.
      expression: "size(x)",
      parameters: {},
    });
    await expect(
      evaluateTupleCondition(store, tuple, { x: 42 }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("caches compiled expressions", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "simple",
      expression: "allowed == true",
      parameters: { allowed: "bool" },
    });
    const tuple = makeTuple({ conditionName: "simple" });

    // Call twice - second call should use cached expression
    expect(await evaluateTupleCondition(store, tuple, { allowed: true })).toBe(
      true,
    );
    expect(await evaluateTupleCondition(store, tuple, { allowed: false })).toBe(
      false,
    );
  });

  test("redefined condition evaluates the new expression", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "threshold",
      expression: "x > 5",
      parameters: { x: "int" },
    });
    const tuple = makeTuple({ conditionName: "threshold" });
    expect(await evaluateTupleCondition(store, tuple, { x: 10 })).toBe(true);

    // Redefine the condition with a stricter expression. The
    // compiled-expression cache is keyed by expression source, so
    // the new expression must take effect immediately.
    await store.upsertConditionDefinition({
      name: "threshold",
      expression: "x > 100",
      parameters: { x: "int" },
    });
    expect(await evaluateTupleCondition(store, tuple, { x: 10 })).toBe(false);
    expect(await evaluateTupleCondition(store, tuple, { x: 200 })).toBe(true);
  });

  test("handles numeric comparisons", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "min_level",
      expression: "level >= 5",
      parameters: { level: "int" },
    });
    const tuple = makeTuple({ conditionName: "min_level" });
    expect(await evaluateTupleCondition(store, tuple, { level: 10 })).toBe(
      true,
    );
    expect(await evaluateTupleCondition(store, tuple, { level: 3 })).toBe(
      false,
    );
  });

  test("handles uint comparisons", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "under_limit",
      expression: "count < limit",
      parameters: { count: "uint", limit: "uint" },
    });
    const tuple = makeTuple({ conditionName: "under_limit" });
    expect(
      await evaluateTupleCondition(store, tuple, { count: 5, limit: 10 }),
    ).toBe(true);
    expect(
      await evaluateTupleCondition(store, tuple, { count: 10, limit: 10 }),
    ).toBe(false);
  });
});

/**
 * The coercion table, ported from OpenFGA's
 * `internal/condition/types/converters.go` and probed against the
 * container at v1.18.2.
 *
 * `4.5` declared `int` is the case that motivates it. tsfga read
 * it as an ordinary number, CEL compared it, and the condition
 * resolved `false` — which on the subtract side of an `excludedBy`
 * means the exclusion does not fire, so a mistyped context value
 * *granted*. `"42"` declared `int` is the mirror: tsfga threw
 * where OpenFGA accepts.
 */
describe("condition parameter coercion", () => {
  const ACCEPTED: Array<[ConditionParameterType, unknown]> = [
    ["int", 42],
    ["int", "42"],
    ["int", -7],
    ["uint", 7],
    ["uint", "7"],
    ["uint", 0],
    ["double", 1.5],
    ["double", "1.5"],
    ["double", 2],
    ["bool", true],
    ["bool", false],
    ["string", "x"],
    ["string", ""],
    ["duration", "1h"],
    ["duration", "1.5h"],
    ["duration", "2h45m"],
    ["duration", "300ms"],
    ["timestamp", "2026-01-01T00:00:00Z"],
    ["timestamp", "2026-01-01T00:00:00+01:00"],
    ["list<string>", []],
    ["list<string>", ["a"]],
    ["map<string>", {}],
    ["map<string>", { a: "x" }],
    ["any", { x: 1 }],
    ["any", "anything"],
  ];

  const REFUSED: Array<[ConditionParameterType, unknown]> = [
    // Numeric types take numeric strings but not everything.
    ["int", 4.5],
    ["int", "abc"],
    ["int", true],
    ["int", ""],
    ["int", null],
    ["uint", -1],
    ["uint", "-1"],
    ["uint", 1.5],
    ["double", "abc"],
    ["double", true],
    // Exact, no coercion in either direction.
    ["bool", "true"],
    ["bool", 1],
    ["string", 1],
    ["string", null],
    // Strings only, and only in the accepted grammar.
    ["duration", "1d"],
    ["duration", 3600],
    ["duration", "later"],
    ["timestamp", 1700000000],
    ["timestamp", "not a date"],
    ["timestamp", "2026-01-01"],
    ["list<string>", "a"],
    ["list<string>", { a: 1 }],
    ["map<string>", ["a"]],
    ["map<string>", "a"],
    ["map<string>", null],
    // The element type is enforced, not just the container.
    ["list<string>", [1]],
    ["map<string>", { a: 1 }],
    ["list<int>", ["x"]],
  ];

  for (const [paramType, value] of ACCEPTED) {
    test(`${paramType} accepts ${JSON.stringify(value) ?? String(value)}`, () => {
      expect(() => coerceContext({ p: paramType }, { p: value })).not.toThrow();
    });
  }

  for (const [paramType, value] of REFUSED) {
    test(`${paramType} refuses ${JSON.stringify(value) ?? String(value)}`, () => {
      // Refused, not resolved `false`. A `false` here would mean an
      // enclosing `but not` does not fire, which grants.
      expect(() => coerceContext({ p: paramType }, { p: value })).toThrow();
    });
  }

  test("a key the condition does not declare is left alone", () => {
    // Probed: a check carrying a stray context key is accepted.
    // Refusing it is a write-path rule, not an evaluation one.
    const { coerced, missing } = coerceContext(
      { p: "int" },
      { p: 1, stray: "kept" },
    );
    expect(coerced["stray"]).toBe("kept");
    expect(missing).toEqual([]);
  });

  test("an absent declared parameter is reported, not thrown", () => {
    const { missing } = coerceContext({ p: "int", q: "string" }, { p: 1 });
    expect(missing).toEqual(["q"]);
  });

  test("null parameters coerce nothing", () => {
    const { coerced, missing } = coerceContext(null, { anything: 4.5 });
    expect(coerced["anything"]).toBe(4.5);
    expect(missing).toEqual([]);
  });
});

/**
 * The integer path, which is the one place tsfga could answer a
 * question confidently and wrongly.
 *
 * cel-js maps a JS `number` onto CEL's `double`, so an `int`
 * parameter reached every arithmetic operator as the wrong type
 * and every comparison past 2^53 as the wrong value. `bigint`
 * fixes both, but only if the string is parsed directly: the value
 * arrives as a string and `Number()` has already lost the
 * precision by the time a `BigInt` could preserve it.
 */
describe("integer parameters are read as bigint", () => {
  const int = (value: unknown): unknown =>
    coerceContext({ n: "int" }, { n: value }).coerced["n"];
  const uint = (value: unknown): unknown =>
    coerceContext({ n: "uint" }, { n: value }).coerced["n"];

  test("a decimal string keeps precision past 2^53", () => {
    // Number("9007199254740993") is 9007199254740992, so this is
    // the assertion that a BigInt wrapped around Number() fails.
    expect(int("9007199254740993")).toBe(9007199254740993n);
  });

  test("a JSON number becomes a bigint", () => {
    expect(int(42)).toBe(42n);
  });

  test("out-of-range magnitudes saturate to the int64 bounds", () => {
    // Upstream converts through bigFloat.Int64(), which clamps and
    // then answers on the clamped value.
    expect(int("99999999999999999999999")).toBe(9223372036854775807n);
    expect(int("-99999999999999999999999")).toBe(-9223372036854775808n);
  });

  test("uint saturates at the int64 ceiling, not the uint64 one", () => {
    // Measured against v1.18.2, which is the only reason this is
    // not the obvious bound: every numeric string goes through the
    // same `bigFloat.Int64()`, and the uint branch only rejects
    // the result afterwards for being negative. So a magnitude
    // past int64 clamps to int64's ceiling and
    // `n == 18446744073709551615u` is `false` upstream.
    //
    // The clamped value is carried as CEL's `uint` rather than its
    // `int`, so it is cel-js's `UnsignedInt` rather than a bare
    // `bigint` — the carrier is what makes `type(n) == uint` and a
    // bare `u`-suffixed literal agree with upstream, and what
    // bounds the arithmetic at uint64 instead of int64.
    expect(`${uint("99999999999999999999999")}`).toBe("9223372036854775807");
  });

  test("a uint is carried as CEL's uint, not as its int", async () => {
    // The distinction is invisible to `==` in JavaScript and
    // decisive inside CEL, so it is asserted through an
    // expression rather than on the coerced value.
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "carrier",
      expression: "type(n) == uint && n + 1u == 8u && int(n) == 7",
      parameters: { n: "uint" },
    });
    const tuple = makeTuple({ conditionName: "carrier" });
    expect(await evaluateTupleCondition(store, tuple, { n: "7" })).toBe(true);
  });

  describe("the numeric grammar refuses what BigInt would accept", () => {
    // BigInt("0x10") is 16n, BigInt(" 42 ") is 42n and BigInt("")
    // is 0n, so delegating the parse to the built-in would be as
    // lax as Number was.
    for (const spelling of [
      "0x10",
      "0o10",
      "0b10",
      " 42 ",
      "\n42",
      "",
      "4.5",
      ".5",
      "1_000",
      "abc",
      "Inf",
    ]) {
      test(`refuses ${JSON.stringify(spelling)}`, () => {
        expect(() => int(spelling)).toThrow();
      });
    }
  });

  describe("and accepts what upstream's does", () => {
    // Upstream parses every numeric type with
    // `big.ParseFloat(value, 10, 64, 0)` and then asks
    // `bigFloat.IsInt()`, so an exponent or a zero fraction is an
    // ordinary integer spelling and answers `true` there. A
    // grammar of bare digits refused all four.
    for (const [spelling, expected] of [
      ["1e3", 1000n],
      ["1E3", 1000n],
      ["1e+3", 1000n],
      ["1000e-3", 1n],
      ["4.0", 4n],
      ["5.", 5n],
      ["1p3", 8n],
    ] as const) {
      test(`reads ${JSON.stringify(spelling)} as ${expected}`, () => {
        expect(int(spelling)).toBe(expected);
      });
    }
  });

  test("refuses a boolean, which Number would read as 1", () => {
    expect(() => int(true)).toThrow();
  });

  test("uint refuses a negative", () => {
    expect(() => uint("-1")).toThrow();
    expect(() => uint(-1)).toThrow();
  });

  test("int accepts a negative", () => {
    expect(int("-7")).toBe(-7n);
  });
});

/**
 * Controls kept in the core suite because a conformance test
 * cannot express them: with an `int` parameter OpenFGA refuses the
 * *model* for both, so there is nothing to compare against.
 */
describe("cel-js mixed-type behaviour under bigint", () => {
  test("a bare double comparison against an int has no overload", () => {
    // Upstream refuses this model, so tsfga erroring is the
    // conservative match rather than a divergence.
    const { coerced } = coerceContext({ n: "int" }, { n: "7" });
    expect(coerced["n"]).toBe(7n);
  });
});

/**
 * `double` reads the same grammar as `int`, and one rule more:
 * upstream parses at 64-bit precision and refuses the value when
 * converting it to a `float64` is inexact. So a decimal fraction
 * with no finite binary form is an error rather than the nearest
 * double, which is why `"0.1"` is refused and `1.5` is not.
 *
 * Every one of these was measured on v1.18.2. `double` used to
 * inherit the whole `Number()` grammar, so the first four answered
 * where upstream refuses to read the value at all.
 */
describe("double parameters read Go's grammar", () => {
  const double = (value: unknown): unknown =>
    coerceContext({ n: "double" }, { n: value }).coerced["n"];

  for (const spelling of [
    "0x10",
    "0o10",
    "0b10",
    " 1.5 ",
    "1e-400",
    "1e400",
    "1.0000000000000000001",
    "0.1",
    "3.14",
    "9007199254740993",
    "Infinity",
    "INF",
    "NaN",
    "",
  ]) {
    test(`refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => double(spelling)).toThrow();
    });
  }

  for (const [spelling, expected] of [
    ["1.5", 1.5],
    ["1.5e3", 1500],
    [".5", 0.5],
    ["-2.25", -2.25],
    ["1p3", 8],
    // `big.Float.Parse` special-cases exactly these spellings
    // before it scans anything, and `Number()` reads none of them.
    ["Inf", Number.POSITIVE_INFINITY],
    ["+Inf", Number.POSITIVE_INFINITY],
    ["-Inf", Number.NEGATIVE_INFINITY],
    ["inf", Number.POSITIVE_INFINITY],
  ] as const) {
    test(`reads ${JSON.stringify(spelling)} as ${expected}`, () => {
      expect(double(spelling)).toBe(expected);
    });
  }

  test("a JSON number is taken as it stands", () => {
    // The precision rule is upstream's *string* parser. A number
    // is already a float64 there and is asserted, not parsed, so
    // 0.1 given as a number is fine where "0.1" is not.
    expect(double(0.1)).toBe(0.1);
  });
});

/**
 * `duration` and `timestamp` are strings on both sides, and each
 * had one spelling that disagreed.
 */
describe("duration and timestamp grammars", () => {
  const duration = (value: unknown): unknown =>
    coerceContext({ n: "duration" }, { n: value }).coerced["n"];
  const timestamp = (value: unknown): unknown =>
    coerceContext({ n: "timestamp" }, { n: value }).coerced["n"];

  for (const spelling of ["0", "+0", "-0"]) {
    test(`duration accepts the bare zero ${JSON.stringify(spelling)}`, () => {
      // `time.ParseDuration` special-cases it before looking for a
      // unit. The unit-demanding grammar refused all three.
      expect(duration(spelling)).toEqual(duration("0s"));
    });
  }

  for (const spelling of ["00", "1", "0.5", " 1h "]) {
    test(`duration still refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => duration(spelling)).toThrow();
    });
  }

  for (const spelling of [
    "2026-01-01t00:00:00z",
    "2026-01-01t00:00:00Z",
    "2026-01-01T00:00:00z",
  ]) {
    test(`timestamp refuses the lowercase ${JSON.stringify(spelling)}`, () => {
      // Go's RFC3339 layout spells the designators uppercase and
      // its parser is exact about it.
      expect(() => timestamp(spelling)).toThrow();
    });
  }

  for (const digits of [3, 9, 10, 12, 30]) {
    test(`timestamp accepts ${digits} fractional digits`, () => {
      // cel-js's own timestamp() refuses anything longer than 30
      // characters, which is where ten digits lands, so the Date
      // is built here instead. Upstream keeps nanoseconds and
      // discards the rest, accepting all five.
      const value = `2026-01-01T00:00:00.${"1".repeat(digits)}Z`;
      expect(timestamp(value)).toBeInstanceOf(Date);
    });
  }

  for (const spelling of [
    "2026-13-01T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2016-12-31T23:59:60Z",
    "2026-01-01T00:00:00.Z",
    "2026-01-01T00:00:00",
  ]) {
    test(`timestamp still refuses ${JSON.stringify(spelling)}`, () => {
      // The regex admits the shape of the first three, so what
      // refuses them is the Date being invalid — the check that
      // came free while cel-js built it.
      expect(() => timestamp(spelling)).toThrow();
    });
  }
});

/**
 * A container's elements are coerced as its declared element type,
 * which is the whole reason the type carries one.
 */
describe("list and map elements are coerced", () => {
  const coerce = (type: ConditionParameterType, value: unknown): unknown =>
    coerceContext({ n: type }, { n: value }).coerced["n"];

  test("a list<int> reaches CEL as bigints", () => {
    // Otherwise `n[0] + 1` finds no overload, exactly as a bare
    // int parameter did.
    expect(coerce("list<int>", ["1", 2])).toEqual([1n, 2n]);
  });

  test("a map<int> reaches CEL as bigints", () => {
    expect(coerce("map<int>", { a: 1 })).toEqual({ a: 1n });
  });

  test("a list<timestamp> reaches CEL as dates", () => {
    expect(coerce("list<timestamp>", ["2026-01-01T00:00:00Z"])).toEqual([
      new Date("2026-01-01T00:00:00Z"),
    ]);
  });

  test("an ill-typed element refuses the whole value", () => {
    // A `false` here would not exclude under a `but not`, which
    // grants. Upstream refuses the check.
    expect(() => coerce("list<string>", [1])).toThrow("n[0]");
    expect(() => coerce("map<string>", { a: 1 })).toThrow("n['a']");
  });

  test("an empty container is accepted whatever it holds", () => {
    expect(coerce("list<int>", [])).toEqual([]);
    expect(coerce("map<int>", {})).toEqual({});
  });

  test("a type with no rule refuses rather than substituting itself", () => {
    // Reachable only through a store reporting a parameter type
    // the union does not have -- which the adapter refuses, but
    // `TupleStore` is the documented extension point. The branch
    // used to `return paramType`, so the value CEL evaluated
    // became the literal string "ipaddress".
    const parameters = { n: "ipaddress" } as unknown as Record<
      string,
      ConditionParameterType
    >;
    expect(() => coerceContext(parameters, { n: ["a"] })).toThrow();
  });
});

/**
 * A caller may hand a `bigint` straight through, and the obvious
 * refusal message would then throw a raw `TypeError` out of the
 * check -- `JSON.stringify` cannot serialize one.
 */
describe("a bigint context value", () => {
  test("is accepted for an int", () => {
    expect(coerceContext({ n: "int" }, { n: 7n }).coerced["n"]).toBe(7n);
  });

  test("is refused for a string without a serializer crash", () => {
    expect(() => coerceContext({ n: "string" }, { n: 7n })).toThrow(
      "expected a string",
    );
  });

  test("is refused as a negative uint", () => {
    expect(() => coerceContext({ n: "uint" }, { n: -7n })).toThrow();
  });
});

/**
 * An expression that does not compile is refused where it is
 * written, and whatever compiles it raises a `TsfgaError`.
 *
 * The two-sided half lives in
 * `tests/conformance/condition-compile.test.ts`, where the same
 * expressions are put to OpenFGA as a model write.
 */
describe("an expression that does not compile", () => {
  const UNPARSEABLE = ["x +", "x ==", "((x", "x = 1", ""];

  for (const expression of UNPARSEABLE) {
    test(`writeConditionDefinition refuses ${JSON.stringify(
      expression,
    )}`, async () => {
      const client = createTsfga(new MockTupleStore());
      await expect(
        client.writeConditionDefinition({
          name: "gate",
          expression,
          parameters: { x: "int" },
        }),
      ).rejects.toBeInstanceOf(ConditionCompileError);
    });
  }

  test("a compiling expression is still accepted", async () => {
    const client = createTsfga(new MockTupleStore());
    await expect(
      client.writeConditionDefinition({
        name: "gate",
        expression: "x > 3",
        parameters: { x: "int" },
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * Injected through the store, because the public API can no
   * longer create this state -- and because a database written by
   * an earlier version is in it. `parse` used to sit outside the
   * `try` that wraps evaluation, so cel-js's own `ParseError`
   * escaped `check()` and could not be caught by the documented
   * class.
   */
  test("evaluation raises a TsfgaError, not cel-js's ParseError", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "gate",
      expression: "x +",
      parameters: { x: "int" },
    });
    const failure = evaluateTupleCondition(
      store,
      makeTuple({ conditionName: "gate", conditionContext: { x: 1 } }),
    );
    await expect(failure).rejects.toBeInstanceOf(ConditionCompileError);
    await expect(failure).rejects.toBeInstanceOf(TsfgaError);
  });
});

/**
 * The compiled-expression cache is process-wide and keyed by
 * expression text, so nothing about a caller's own lifetime
 * releases it. A caller that writes many condition definitions —
 * or one that rewrites the same one repeatedly, since each new
 * source text is a new key — would otherwise grow it forever.
 */
describe("the compiled expression cache is bounded", () => {
  test("filling past the bound evicts the least recently used", () => {
    const expr = (i: number) => `evict_probe_${i} == ${i}`;
    const first = expr(0);

    for (let i = 0; i < EXPR_CACHE_MAX_ENTRIES; i++) {
      compileCondition("probe", expr(i));
    }
    expect(hasCompiledExpression(first)).toBe(true);

    // A hit refreshes recency, so the entry after it is now the
    // oldest and the next insert must take that one instead.
    compileCondition("probe", first);
    compileCondition("probe", expr(EXPR_CACHE_MAX_ENTRIES));

    expect(hasCompiledExpression(first)).toBe(true);
    expect(hasCompiledExpression(expr(1))).toBe(false);

    // And the bound holds however far past it the caller goes.
    for (let i = 0; i < EXPR_CACHE_MAX_ENTRIES; i++) {
      compileCondition("probe", `overflow_${i} == ${i}`);
    }
    expect(hasCompiledExpression(first)).toBe(false);
  });
});

/**
 * `matches()` is RE2 upstream and a JavaScript `RegExp` here, and
 * the two dialects are not a superset of one another.
 *
 * cel-js refuses to replace its own `string.matches` overload, so
 * `compileCondition` renames the call onto one of ours and that
 * one translates the pattern first. The conformance assertions
 * live in `tests/conformance/a2-cel-regex.test.ts`; these are the
 * unit-level rows, including the ones no model in the suite
 * reaches.
 */
describe("matches() reads its pattern as RE2, not as a RegExp", () => {
  const matches = async (
    subject: string,
    pattern: string,
  ): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "re",
      expression: "s.matches(r)",
      parameters: { s: "string", r: "string" },
    });
    return evaluateTupleCondition(store, makeTuple({ conditionName: "re" }), {
      s: subject,
      r: pattern,
    });
  };

  describe("patterns both dialects share pass through", () => {
    for (const [subject, pattern, expected] of [
      ["abc", "^a.c$", true],
      ["abc", "b", true],
      ["abc", "^z", false],
      ["a b", "\\ba\\b", true],
      ["abc", "^[a-c]+$", true],
      ["a.c", "^a\\.c$", true],
      ["aaa", "^a{3}$", true],
      ["xy", "^(?:x)y$", true],
    ] as const) {
      const name = `${JSON.stringify(pattern)} on ${subject}`;
      test(name, async () => {
        expect(await matches(subject, pattern)).toBe(expected);
      });
    }
  });

  describe("RE2 spellings a RegExp cannot compile", () => {
    test("a leading inline flag becomes a RegExp flag", async () => {
      expect(await matches("ABC", "(?i)abc")).toBe(true);
      expect(await matches("a\nb", "(?s)a.b")).toBe(true);
      expect(await matches("a\nb", "(?m)^b$")).toBe(true);
    });

    test("combined flags are read together", async () => {
      expect(await matches("A\nB", "(?is)a.b")).toBe(true);
    });

    test("an ungreedy flag inverts every quantifier", async () => {
      // `(?U)` is what RE2 spells and JavaScript has no flag for,
      // so every quantifier is flipped instead. `matches` is a
      // predicate and a `RegExp` backtracks, so greediness cannot
      // change the answer -- what these assert is that each
      // quantifier form survives the flip and still compiles.
      expect(await matches("abc", "(?U)a.+")).toBe(true);
      expect(await matches("abc", "(?U)^a.+c$")).toBe(true);
      expect(await matches("abc", "(?U)^a.{1,2}c$")).toBe(true);
      expect(await matches("abbc", "(?U)^ab*?c$")).toBe(true);
      expect(await matches("ac", "(?U)^ab?c$")).toBe(true);
      expect(await matches("abc", "(?U)^z.+")).toBe(false);
    });

    test("an RE2-spelled named group becomes a JavaScript one", async () => {
      expect(await matches("abc", "(?P<x>a)b")).toBe(true);
    });
  });

  describe("spellings both compile and read differently", () => {
    test("a POSIX class expands", async () => {
      expect(await matches("abc", "^[[:alpha:]]+$")).toBe(true);
      expect(await matches("a1", "^[[:alnum:]]+$")).toBe(true);
      expect(await matches("a1", "^[[:digit:]]+$")).toBe(false);
      expect(await matches("a_1", "^[[:word:]]+$")).toBe(true);
      expect(await matches("a-b", "^[[:alpha:]-]+$")).toBe(true);
    });

    test("a unicode class needs the u flag to be one", async () => {
      expect(await matches("ab", "^\\pL+$")).toBe(true);
      expect(await matches("ab", "^\\p{L}+$")).toBe(true);
      expect(await matches("12", "^\\p{L}+$")).toBe(false);
      expect(await matches("12", "^\\p{Nd}+$")).toBe(true);
    });
  });

  describe("spellings RE2 refuses are refused here", () => {
    for (const pattern of [
      "a(?=b)",
      "a(?!b)",
      "(?<=a)b",
      "(?<!a)b",
      "(a)\\1",
      "(?P<x>a)(?P=x)",
      "a(?i)b",
      "(?i:a)b",
    ]) {
      test(`${JSON.stringify(pattern)} is an evaluation error`, async () => {
        await expect(matches("ab", pattern)).rejects.toBeInstanceOf(
          ConditionEvaluationError,
        );
      });
    }

    test("a pattern neither dialect compiles is still an error", async () => {
      await expect(matches("abc", "a(")).rejects.toBeInstanceOf(
        ConditionEvaluationError,
      );
    });
  });

  describe("a negated POSIX class is the class's complement", () => {
    // RE2 negates a POSIX class against the **whole** rune range,
    // not against ASCII, so a letter outside ASCII is a member of
    // `[[:^alpha:]]`. This was a refusal until the write-time
    // compilation of issue 241 made refusing it a refusal of models
    // upstream accepts.
    test("it matches what the class does not", async () => {
      expect(await matches("1", "^[[:^alpha:]]+$")).toBe(true);
      expect(await matches("abc", "^[[:^alpha:]]+$")).toBe(false);
      expect(await matches("😀", "^[[:^alpha:]]$")).toBe(true);
    });

    test("it composes with the rest of its bracket expression", async () => {
      expect(await matches("a1", "^[a[:^digit:]]+$")).toBe(false);
      expect(await matches("ax", "^[a[:^digit:]]+$")).toBe(true);
    });

    test("negating a negated class is the class again", async () => {
      expect(await matches("abc", "^[^[:^alpha:]]+$")).toBe(true);
      expect(await matches("a1", "^[^[:^alpha:]]+$")).toBe(false);
    });
  });
});

/**
 * The RE2 translation is **total**: every construct either
 * translates faithfully or refuses.
 *
 * It used to pass anything it did not recognise through to
 * `new RegExp`, which is not the neutral act it looks like. The
 * `u` flag rejects an unknown escape, the compile then retried
 * without `u`, and Annex B web compatibility reads `\A` as the
 * literal letter `A` — so `\Aabc` matched `Aabc` and did not match
 * `abc`, in both directions, with no error anywhere (issue 383).
 * That is the only failure mode in this area that a caller cannot
 * see, and refusing by default closes it for constructs nobody has
 * enumerated as well as for the ones below.
 *
 * The conformance assertions live in
 * `tests/conformance/c5-cel-re2.test.ts`, against the container.
 * These are the unit-level rows, including the ones no model in
 * that suite can reach — `(?s)` and `(?m)` need a subject holding a
 * newline, and both engines refuse a control character in a request
 * context (issue 386), so this file is the only place they are
 * reachable at all.
 */
describe("the RE2 translation refuses what it cannot spell", () => {
  const matches = async (
    subject: string,
    pattern: string,
  ): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "re",
      expression: "s.matches(r)",
      parameters: { s: "string", r: "string" },
    });
    return evaluateTupleCondition(store, makeTuple({ conditionName: "re" }), {
      s: subject,
      r: pattern,
    });
  };

  const refuses = (pattern: string) =>
    expect(matches("a", pattern)).rejects.toBeInstanceOf(
      ConditionEvaluationError,
    );

  /** Whether a *constant* pattern is refused at write time, which
   *  is the `invalid` / `untranslatable` split made observable. */
  const write = async (pattern: string): Promise<string> => {
    const client = createTsfga(new MockTupleStore());
    return client
      .writeConditionDefinition({
        name: "re",
        expression: `s.matches(${JSON.stringify(pattern)})`,
        parameters: { s: "string" },
      })
      .then(() => "accepted")
      .catch((error: unknown) =>
        error instanceof ConditionCompileError ? "refused" : "other",
      );
  };

  describe("the flags a model in the suite cannot reach", () => {
    // A newline is a control character, and both engines refuse one
    // in a request context, so no conformance cell can carry it.
    test("(?s) makes . match a newline", async () => {
      expect(await matches("a\nb", "^a.b$")).toBe(false);
      expect(await matches("a\nb", "(?s)^a.b$")).toBe(true);
    });

    test("(?m) anchors each line", async () => {
      expect(await matches("a\nb", "^b$")).toBe(false);
      expect(await matches("a\nb", "(?m)^b$")).toBe(true);
    });

    test("\\A and \\z are the text anchors (?m) does not move", async () => {
      expect(await matches("a\nb", "\\Aa")).toBe(true);
      expect(await matches("a\nb", "\\Ab")).toBe(false);
      expect(await matches("a\nb", "b\\z")).toBe(true);
      expect(await matches("a\nb", "a\\z")).toBe(false);
    });

    test("\\A under (?m) refuses rather than becoming ^", async () => {
      // `^` is `\A` only while `m` is absent, and RE2 has no other
      // spelling of the text anchor JavaScript could reach. RE2
      // compiles the pattern, so the *write* must still succeed.
      await refuses("(?m)\\Aa");
      expect(await write("(?m)\\Aa")).toBe("accepted");
    });
  });

  describe("383: escapes JavaScript would read as literals", () => {
    test("\\A is the start of the text, not the letter A", async () => {
      expect(await matches("abc", "\\Aabc")).toBe(true);
      expect(await matches("Aabc", "\\Aabc")).toBe(false);
    });

    test("\\z is the end of the text, not the letter z", async () => {
      expect(await matches("abc", "abc\\z")).toBe(true);
      expect(await matches("abcz", "abc\\z")).toBe(false);
    });

    test("\\Q…\\E quotes its contents", async () => {
      expect(await matches("a.c", "^\\Qa.c\\E$")).toBe(true);
      expect(await matches("abc", "^\\Qa.c\\E$")).toBe(false);
      expect(await matches("a+b", "^\\Qa+b\\E$")).toBe(true);
    });

    test("an unterminated \\Q runs to the end of the pattern", async () => {
      expect(await matches("a.c", "^\\Qa.c")).toBe(true);
      expect(await matches("axc", "^\\Qa.c")).toBe(false);
    });

    test("\\x{…} is a wide hex escape and \\xHH a narrow one", async () => {
      expect(await matches("\u{1F600}", "^\\x{1F600}$")).toBe(true);
      expect(await matches("A", "^\\x41$")).toBe(true);
      expect(await matches("x", "^\\x41$")).toBe(false);
    });

    test("\\a is the bell character", async () => {
      expect(await matches("\u0007", "^\\a$")).toBe(true);
      expect(await matches("a", "^\\a$")).toBe(false);
    });

    test("\\s is RE2's five characters, not JavaScript's set", async () => {
      // Go's `\s` is `[\t\n\f\r ]`. JavaScript's also holds `\v`,
      // every `Zs` space and the BOM, so passing it through widened
      // the class silently and invisibly.
      expect(await matches(" ", "^\\s$")).toBe(true);
      expect(await matches("\t", "^\\s$")).toBe(true);
      expect(await matches("\u000b", "^\\s$")).toBe(false);
      expect(await matches("\u00a0", "^\\s$")).toBe(false);
      expect(await matches("\u000b", "^\\S$")).toBe(true);
      expect(await matches("a b", "^[a-z\\s]+$")).toBe(true);
      expect(await matches("a\u00a0b", "^[a-z\\s]+$")).toBe(false);
    });
  });

  describe("384: RE2 syntax that has a JavaScript spelling", () => {
    test("an octal escape", async () => {
      expect(await matches("A", "^\\101$")).toBe(true);
      expect(await matches("\n", "^\\12$")).toBe(true);
      expect(await matches(" ", "^\\0$")).toBe(true);
    });

    test("a lone backreference digit is still refused", async () => {
      // `\1` alone is a backreference, which RE2 does not have.
      await refuses("(a)\\1");
      expect(await write("(a)\\1")).toBe("refused");
    });

    test("a script name becomes \\p{Script=…}", async () => {
      expect(await matches("α", "^\\p{Greek}$")).toBe(true);
      expect(await matches("a", "^\\p{Greek}$")).toBe(false);
      expect(await matches("a", "^\\p{Latin}$")).toBe(true);
    });

    test("a general category keeps its own spelling", async () => {
      expect(await matches("a", "^\\p{Ll}$")).toBe(true);
      expect(await matches("A", "^\\p{Ll}$")).toBe(false);
    });

    test("a negation inside the braces becomes \\P", async () => {
      expect(await matches("a", "^\\p{^L}$")).toBe(false);
      expect(await matches("1", "^\\p{^L}$")).toBe(true);
      expect(await matches("a", "^\\P{^L}$")).toBe(true);
    });

    test("\\p{Any} is every rune", async () => {
      expect(await matches("😀", "^\\p{Any}$")).toBe(true);
      expect(await matches("😀", "^[\\p{Any}]$")).toBe(true);
    });

    test("a duplicate group name is renamed, not refused", async () => {
      // RE2 allows one name twice and JavaScript does not. Nothing
      // in this module ever reads a capture back, so renaming the
      // later one is free.
      expect(await matches("aa", "^(?P<n>a)(?P<n>a)$")).toBe(true);
      expect(await matches("a", "^(?P<n>a)(?P<n>a)$")).toBe(false);
    });

    test("the three inline flag forms stay refused", async () => {
      // Deliberate, and the residue this pass leaves: JavaScript's
      // modifier groups reached V8 only in 12.5, later than the
      // runtimes this package supports. RE2 accepts all three, so
      // none of them refuses the write.
      for (const pattern of ["a(?i)bc", "(?i:abc)", "(?-i)abc"]) {
        await refuses(pattern);
        expect(await write(pattern)).toBe("accepted");
      }
    });
  });

  describe("385: patterns RE2 refuses, refused as invalid", () => {
    // `invalid` rather than `untranslatable`, so a model carrying
    // one as a constant is refused at write time as upstream
    // refuses it — issue 241's gate reading this pass's verdicts.
    for (const pattern of [
      "[a-\\w]",
      "[a-[:digit:]]",
      "[\\b]",
      "[\\B]",
      "a{1000}",
      "a{1001}",
      "a{2,1000}",
      "a{2,1}",
      "\\C",
    ]) {
      const name = `${JSON.stringify(pattern)} refuses check and write`;
      test(name, async () => {
        await refuses(pattern);
        expect(await write(pattern)).toBe("refused");
      });
    }

    test("a repetition below the ceiling still compiles", async () => {
      expect(await matches("a".repeat(999), `^a{999}$`)).toBe(true);
      expect(await matches("aa", "^a{1,999}$")).toBe(true);
    });
  });

  describe("an unrecognised construct refuses rather than compiling", () => {
    for (const pattern of ["\\y", "\\Z", "\\E", "\\8", "\\9", "\\xZZ", "\\"]) {
      test(`${JSON.stringify(pattern)} is refused`, async () => {
        await refuses(pattern);
      });
    }

    test("an escaped non-ASCII rune is refused", async () => {
      await refuses("\\é");
    });
  });

  describe("what the u flag would have refused is emitted for it", () => {
    // Each of these used to compile only because the translation
    // fell back to a non-unicode `RegExp`. There is no fallback
    // now, so each has to be spelled for the `u` flag.
    test("a brace that opens no repetition is a literal", async () => {
      expect(await matches("a{2}", "^a\\{2\\}$")).toBe(true);
      expect(await matches("a{,2}", "^a{,2}$")).toBe(true);
      expect(await matches("a}", "^a}$")).toBe(true);
    });

    test("a bracket outside a bracket expression is a literal", async () => {
      expect(await matches("a]", "^a]$")).toBe(true);
      expect(await matches("]", "^[]]$")).toBe(true);
      expect(await matches("[", "^[[]$")).toBe(true);
    });

    test("RE2 escapes any ASCII punctuation", async () => {
      expect(await matches("-", "^\\-$")).toBe(true);
      expect(await matches("!", "^\\!$")).toBe(true);
      expect(await matches("/", "^\\/$")).toBe(true);
    });

    test("a dash after a class is a literal, not a range", async () => {
      expect(await matches("a-b", "^[\\w-]+$")).toBe(true);
      expect(await matches("-", "^[[:alpha:]-]$")).toBe(true);
    });

    test("an astral literal is one code point", async () => {
      expect(await matches("😀", "^.$")).toBe(true);
      expect(await matches("😀", "^[😀]$")).toBe(true);
    });
  });
});

/**
 * The splice that puts `matches` on tsfga's implementation, at the
 * seam issue 240 opened.
 *
 * The name used to be located by scanning **forward** from the
 * receiver's range end and demanding `\s*\.\s*`. cel-js ends a
 * parenthesised expression's range inside the closing paren, so
 * `(s).matches(r)` left `).` in the gap, the splice was skipped,
 * and the call resolved to cel-js's own `matches` — a JavaScript
 * `RegExp`, which is the divergence issue 020 paid to close. It is
 * scanned backwards from the first argument now, which no
 * receiver's spelling can move.
 *
 * Each spelling is asserted twice: once that RE2 syntax is honoured
 * (so the splice happened) and once that syntax RE2 refuses is
 * refused (so nothing fell through to a `RegExp` quietly).
 */
describe("every receiver spelling reaches the RE2 implementation", () => {
  const evaluate = async (expression: string): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "re",
      expression,
      parameters: { s: "string" },
    });
    return evaluateTupleCondition(store, makeTuple({ conditionName: "re" }), {
      s: "abc",
    });
  };

  const receivers: ReadonlyArray<readonly [string, string]> = [
    ["bare", "s"],
    ["parenthesised", "(s)"],
    ["a concatenation", '(s + "")'],
    ["a ternary", '(s == "" ? "zzz" : s)'],
    ["an index", "[s][0]"],
    ["a map index", '{"k": s}["k"]'],
    ["nested parentheses", "(((s)))"],
    ["a comment before the dot", "s // c\n"],
    ["a comment after the dot", "s. //c\n"],
  ];

  for (const [label, receiver] of receivers) {
    const dot = receiver.endsWith(". //c\n") ? "" : ".";

    test(`${label}: an RE2 POSIX class is read as RE2`, async () => {
      expect(await evaluate(`${receiver}${dot}matches("[[:alpha:]]+")`)).toBe(
        true,
      );
    });

    test(`${label}: an RE2 inline flag is read as RE2`, async () => {
      expect(await evaluate(`${receiver}${dot}matches("(?i)ABC")`)).toBe(true);
    });

    test(`${label}: syntax RE2 refuses does not fall through`, async () => {
      // A lookahead is valid JavaScript and invalid RE2, so an
      // unspliced call would answer `true` where upstream refuses.
      await expect(
        evaluate(`${receiver}${dot}matches("a(?=b)")`),
      ).rejects.toBeInstanceOf(TsfgaError);
    });
  }

  test("a parenthesised argument is spliced too", async () => {
    expect(await evaluate('s.matches(("[[:alpha:]]+"))')).toBe(true);
  });

  test("two calls in one expression are both spliced", async () => {
    // The splices are applied back to front, so the second one's
    // offsets must survive the first being a different length.
    expect(
      await evaluate('s.matches("[[:alpha:]]+") && (s).matches("(?i)ABC")'),
    ).toBe(true);
  });
});

/**
 * The rewrite table is keyed on the call's **name**, with the call
 * style a property of the overload rather than the key.
 *
 * CEL declares `matches` twice in one function block — a global
 * `matches(string, string)` and the member `<string>.matches(string)`,
 * bound to the same RE2 matcher (`common/stdlib/standard.go`). A
 * table split by style knew only the member one, so the global
 * spelling reached neither the RE2 implementation nor the
 * write-time pattern compile: every check reading such a condition
 * was refused, including plain ASCII patterns where the two
 * dialects agree (issues 320 / 380 / 321).
 *
 * The whole owned surface is `int`, `double` and `matches` times
 * the two call styles cel-js's AST has, and the six cells are
 * enumerated below.
 */
describe("an owned call is rewritten in every style CEL declares", () => {
  const evaluate = async (
    expression: string,
    parameters: Record<string, ConditionParameterType>,
    context: Record<string, unknown>,
  ): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({ name: "c", expression, parameters });
    return evaluateTupleCondition(
      store,
      makeTuple({ conditionName: "c" }),
      context,
    );
  };

  const match = (expression: string, s = "abc"): Promise<boolean> =>
    evaluate(expression, { s: "string", p: "string" }, { s, p: "^a" });

  describe("matches: global as well as receiver", () => {
    test("a global call reads a POSIX class as RE2", async () => {
      // A JavaScript `RegExp` reads `[[:alpha:]]` as the class of
      // the characters `[:alph`, so this answering `true` is what
      // says the call reached RE2 and not cel-js.
      expect(await match('matches(s, "[[:alpha:]]+")')).toBe(true);
    });

    test("a global call reads an RE2 inline flag", async () => {
      expect(await match('matches(s, "(?i)ABC")')).toBe(true);
    });

    test("a global call denies a non-match", async () => {
      expect(await match('matches(s, "[[:alpha:]]+")', "123")).toBe(false);
    });

    test("a global call resolves at all", async () => {
      // Nothing exotic in the pattern: before the fix this was not
      // a wrong answer but a refusal, because cel-js ships no
      // global `matches` for an unrewritten call to land on.
      expect(await match('matches(s, "^a.c$")')).toBe(true);
    });

    test("syntax RE2 refuses does not fall through globally", async () => {
      // A lookahead is valid JavaScript and invalid RE2, so a
      // global call answering here would mean it had been left on
      // a JavaScript `RegExp`.
      await expect(match('matches(s, "a(?=b)")')).rejects.toBeInstanceOf(
        TsfgaError,
      );
    });

    test("the pattern may arrive in either spelling's argument", async () => {
      // The pattern is the last argument in both, so its index
      // moves with the arity — `args[1]` globally, `args[0]` on a
      // receiver — and both must reach the same implementation.
      expect(await match("matches(s, p) && s.matches(p)")).toBe(true);
    });

    test("a global call with the wrong arity is not rewritten", async () => {
      // CEL declares no such overload either, so both refuse. What
      // matters is that the arity guard is per entry rather than
      // the constant 1 the table used to assume.
      await expect(match('matches(s, "^a", "b")')).rejects.toBeInstanceOf(
        TsfgaError,
      );
    });
  });

  describe("int and double: global only, as CEL declares them", () => {
    test("the global spelling is rewritten", async () => {
      expect(
        await evaluate(
          "int(x) == 1 && double(x) == 1.5",
          { x: "double" },
          { x: 1.5 },
        ),
      ).toBe(true);
    });

    for (const call of ["x.int()", "x.double()"]) {
      test(`${call} resolves nowhere, as upstream declares none`, async () => {
        // CEL declares no member overload of either conversion, so
        // the receiver cell is empty on purpose and a receiver
        // spelling must refuse rather than be rewritten onto
        // tsfga's implementation.
        await expect(
          evaluate(`${call} == 1`, { x: "double" }, { x: 1.5 }),
        ).rejects.toBeInstanceOf(TsfgaError);
      });
    }
  });

  /**
   * A `call` node's range starts at its own name in every spelling
   * cel-js parses — there is no `(f)(x)` form — so the splice site
   * is structurally always placeable and the guard below cannot be
   * reached through the parser. It exists because falling through
   * silently is the one outcome that must not happen: cel-js
   * refuses to let a built-in overload be replaced, so an
   * unspliced `int` or `matches` does not fail to resolve, it
   * resolves to cel-js's own implementation. The observable half
   * of the rule is asserted above — every owned spelling reaches
   * tsfga's implementation, and none is answered by cel-js's.
   */
  describe("a global constant pattern is compiled at write time", () => {
    const write = async (expression: string): Promise<string> => {
      const client = createTsfga(new MockTupleStore());
      return client
        .writeConditionDefinition({
          name: "re",
          expression,
          parameters: { s: "string", p: "string" },
        })
        .then(() => "accepted")
        .catch((error: unknown) =>
          error instanceof ConditionCompileError ? "refused" : "other",
        );
    };

    for (const pattern of ["a(?=b)", "[[:nope:]]", "a("]) {
      test(`${JSON.stringify(pattern)} is refused globally too`, async () => {
        // cel-go's `regexOptimizer` folds a constant pattern by
        // function name, not by call style, so upstream refuses
        // the model whichever spelling carries it.
        expect(await write(`matches(s, "${pattern}")`)).toBe("refused");
      });
    }

    test("a pattern RE2 accepts is stored", async () => {
      expect(await write('matches(s, "^[[:alpha:]]+$")')).toBe("accepted");
    });

    test("a global pattern that is not a constant is stored", async () => {
      // Upstream's optimiser folds constants only, so a pattern
      // arriving in the context is a run-time concern either way.
      expect(await write("matches(s, p)")).toBe("accepted");
    });
  });
});

/**
 * A constant pattern is compiled when the condition is written.
 *
 * cel-go's `regexOptimizer` folds every `matches` call whose
 * pattern is a literal while it builds the program, so upstream
 * refuses the *model* rather than every check that reads it
 * (issue 241). The refusal is narrowed to patterns RE2 itself
 * refuses: a pattern RE2 accepts and this translator cannot spell
 * stays a check-time refusal, because refusing the write would
 * refuse a model upstream accepts.
 */
describe("a constant matches() pattern is compiled at write time", () => {
  const write = async (expression: string): Promise<string> => {
    const client = createTsfga(new MockTupleStore());
    return client
      .writeConditionDefinition({
        name: "re",
        expression,
        parameters: { s: "string", r: "string" },
      })
      .then(() => "accepted")
      .catch((error: unknown) =>
        error instanceof ConditionCompileError ? "refused" : "other",
      );
  };

  for (const pattern of [
    "a(?=b)",
    "a(?!b)",
    "(?<=a)b",
    "(a)\\\\1",
    "(?P<x>a)(?P=x)",
    "[[:nope:]]",
    "a[",
    "a(",
  ]) {
    test(`${JSON.stringify(pattern)} is refused`, async () => {
      expect(await write(`s.matches("${pattern}")`)).toBe("refused");
    });
  }

  for (const pattern of [
    "^[[:alpha:]]+$",
    "[[:^alpha:]]",
    "(?i)abc",
    "(?P<x>a)b",
    "\\\\p{L}+",
  ]) {
    test(`${JSON.stringify(pattern)} is accepted`, async () => {
      expect(await write(`s.matches("${pattern}")`)).toBe("accepted");
    });
  }

  test("a pattern RE2 accepts and tsfga cannot spell is stored", async () => {
    // `(?i:…)` is RE2, and JavaScript's modifier groups reached V8
    // only in 12.5 — too late for the runtimes this package
    // supports. Refusing the write would refuse a model upstream
    // accepts, so the refusal stays where it always was.
    expect(await write('s.matches("(?i:A)b")')).toBe("accepted");
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "re",
      expression: 's.matches("(?i:A)b")',
      parameters: { s: "string" },
    });
    await expect(
      evaluateTupleCondition(store, makeTuple({ conditionName: "re" }), {
        s: "ab",
      }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("a pattern that is not a constant is not compiled", async () => {
    // Upstream's optimiser folds constants only, so a pattern
    // arriving in the context is a run-time concern on both sides.
    expect(await write("s.matches(r)")).toBe("accepted");
  });
});

/**
 * The overloads cel-js does not ship, and the range checks it does
 * not apply.
 *
 * `string(duration)` and `string(timestamp)` are absent rather
 * than occupied, so they register directly. `int()` and `double()`
 * are occupied, so the call is renamed onto a checked
 * implementation — which is also where `int(uint)` comes from,
 * since a `uint` parameter is carried as CEL's `uint` and cel-js
 * has no such overload.
 */
describe("conversions agree with cel-go", () => {
  const answer = async (
    expression: string,
    parameters: Record<string, ConditionParameterType>,
    context: Record<string, unknown>,
  ): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "convert",
      expression,
      parameters,
    });
    return evaluateTupleCondition(
      store,
      makeTuple({ conditionName: "convert" }),
      context,
    );
  };

  describe("string() of a duration", () => {
    for (const [written, formatted] of [
      ["1h", "3600s"],
      ["1.5s", "1.5s"],
      ["-90s", "-90s"],
      ["0", "0s"],
      ["100ns", "0.0000001s"],
      ["2h45m", "9900s"],
    ] as const) {
      test(`${written} formats as ${formatted}`, async () => {
        expect(
          await answer(
            `string(d) == '${formatted}'`,
            { d: "duration" },
            {
              d: written,
            },
          ),
        ).toBe(true);
      });
    }
  });

  describe("string() of a timestamp", () => {
    for (const [written, formatted] of [
      ["2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"],
      ["2026-01-02T00:00:00.500Z", "2026-01-02T00:00:00.5Z"],
      ["2026-01-02T01:00:00+01:00", "2026-01-02T00:00:00Z"],
    ] as const) {
      test(`${written} formats as ${formatted}`, async () => {
        expect(
          await answer(
            `string(t) == '${formatted}'`,
            { t: "timestamp" },
            {
              t: written,
            },
          ),
        ).toBe(true);
      });
    }
  });

  describe("int() is range-checked", () => {
    test("a double inside int64 converts", async () => {
      expect(await answer("int(x) == 7", { x: "double" }, { x: 7.9 })).toBe(
        true,
      );
      expect(await answer("int(x) == -7", { x: "double" }, { x: -7.9 })).toBe(
        true,
      );
    });

    for (const value of [1e19, -1e19]) {
      test(`${value} overflows rather than answering`, async () => {
        await expect(
          answer("int(x) > 0", { x: "double" }, { x: value }),
        ).rejects.toBeInstanceOf(ConditionEvaluationError);
      });
    }

    test("a uint converts, which cel-js has no overload for", async () => {
      expect(await answer("int(n) == 7", { n: "uint" }, { n: "7" })).toBe(true);
    });

    test("a duration converts to its nanoseconds", async () => {
      // cel-go reads `int(duration)` as nanoseconds and
      // `int(timestamp)` as epoch seconds; cel-js has neither
      // overload, so both were refused (issue 382).
      const nanos = (written: string, expected: string): Promise<boolean> =>
        answer(`int(d) == ${expected}`, { d: "duration" }, { d: written });
      expect(await nanos("1h", "3600000000000")).toBe(true);
      expect(await nanos("-90s", "-90000000000")).toBe(true);
    });

    test("a timestamp converts to its epoch seconds", async () => {
      const epoch = (written: string, expected: string): Promise<boolean> =>
        answer(`int(t) == ${expected}`, { t: "timestamp" }, { t: written });
      expect(await epoch("2026-01-01T00:00:00Z", "1767225600")).toBe(true);
      // Seconds are floored, which is coarser than the
      // sub-millisecond resolution the coercion boundary already
      // loses, and matches Go's `Unix()`.
      expect(await epoch("1970-01-01T00:00:00.999Z", "0")).toBe(true);
      expect(await epoch("1969-12-31T23:59:59Z", "-1")).toBe(true);
    });

    test("an int and a numeric string still convert", async () => {
      expect(await answer("int(n) == 7", { n: "int" }, { n: "7" })).toBe(true);
      expect(await answer("int(s) == 7", { s: "string" }, { s: "7" })).toBe(
        true,
      );
      await expect(
        answer("int(s) > 0", { s: "string" }, { s: "abc" }),
      ).rejects.toBeInstanceOf(ConditionEvaluationError);
    });
  });

  describe("double() is range-checked", () => {
    test("a string inside float64 converts", async () => {
      expect(
        await answer("double(s) == 1.5", { s: "string" }, { s: "1.5" }),
      ).toBe(true);
    });

    for (const value of ["1e400", "-1e400", "1e-400"]) {
      test(`${value} leaves the range rather than answering`, async () => {
        await expect(
          answer("double(s) > 0.0", { s: "string" }, { s: value }),
        ).rejects.toBeInstanceOf(ConditionEvaluationError);
      });
    }

    test("the named infinities still read", async () => {
      expect(
        await answer("double(s) > 0.0", { s: "string" }, { s: "Inf" }),
      ).toBe(true);
      expect(
        await answer("double(s) < 0.0", { s: "string" }, { s: "-inf" }),
      ).toBe(true);
    });

    test("an int and a uint convert", async () => {
      expect(await answer("double(n) == 7.0", { n: "int" }, { n: "7" })).toBe(
        true,
      );
      expect(await answer("double(n) == 7.0", { n: "uint" }, { n: "7" })).toBe(
        true,
      );
    });
  });

  /**
   * The rewrite is a source-text splice, so anything it gets wrong
   * shows up as a changed expression rather than a wrong answer.
   * These are the shapes where a splice could land in the wrong
   * place: several calls in one expression, a call nested in
   * another, a string literal that happens to spell one, and a
   * field whose name is one.
   */
  describe("the rewrite touches only the call it means to", () => {
    test("several rewritten calls in one expression", async () => {
      expect(
        await answer(
          "int(x) == 1 && double(s) == 2.0 && t.matches('^a')",
          { x: "double", s: "string", t: "string" },
          { x: 1.5, s: "2", t: "abc" },
        ),
      ).toBe(true);
    });

    test("a rewritten call nested in another", async () => {
      expect(
        await answer("int(double(s)) == 2", { s: "string" }, { s: "2.5" }),
      ).toBe(true);
    });

    test("a string literal spelling a rewritten call", async () => {
      expect(
        await answer(
          "s == 'int(x)' && int(1.0) == 1",
          { s: "string" },
          {
            s: "int(x)",
          },
        ),
      ).toBe(true);
    });

    test("a map key named like a rewritten call", async () => {
      expect(
        await answer(
          "m['int'] == 'double'",
          { m: "map<string>" },
          {
            m: { int: "double" },
          },
        ),
      ).toBe(true);
    });

    test("an expression with nothing to rewrite is untouched", async () => {
      expect(
        await answer("s.startsWith('a')", { s: "string" }, { s: "abc" }),
      ).toBe(true);
    });
  });

  /**
   * A list literal takes CEL's `list(dyn)`, not the type of its
   * first element.
   *
   * cel-js's `homogeneousAggregateLiterals` defaults to `true` and
   * refuses every element whose type differs from the first, so a
   * variable beside a string literal was an evaluation error.
   * cel-go's own option of that name defaults off and OpenFGA
   * never sets it — `internal/condition/condition.go` builds the
   * base environment from the custom parameter types,
   * `IPAddressEnvOption` and `EagerlyValidateDeclarations` alone
   * (issue 322).
   */
  describe("a list literal may mix types", () => {
    test("a literal before a variable", async () => {
      expect(
        await answer('["x", s][1] == "abc"', { s: "string" }, { s: "abc" }),
      ).toBe(true);
    });

    test("a variable before a literal", async () => {
      expect(
        await answer('[s, "x"][0] == "abc"', { s: "string" }, { s: "abc" }),
      ).toBe(true);
    });

    test("two literals of different types", async () => {
      expect(await answer('size(["x", 1]) == 2', {}, {})).toBe(true);
    });

    test("a map value of a mixed type", async () => {
      expect(await answer('{"a": "x", "b": 1}["b"] == 1', {}, {})).toBe(true);
    });

    test("a homogeneous list still reads", async () => {
      expect(await answer('"b" in ["a", "b"]', {}, {})).toBe(true);
    });
  });
});

/**
 * The enumeration test.
 *
 * cel-go's standard library is a finite declaration list and cel-js
 * 8.0.0 exposes `getDefinitions()`, so "which functions does one
 * have that the other does not" is not a question to be discovered
 * by probing a check at a time — it is a **diff that can be
 * computed**. Computing it is what turns the widest of the CEL root
 * causes from a sweep into a standing guard: a cel-js upgrade that
 * adds a function reports itself here rather than waiting for
 * someone to write a conformance cell against it.
 *
 * The two residues below are checked in with a reason each. A name
 * appearing on either side that is not in its residue fails, in
 * both directions.
 */
describe("cel-js's declared surface against cel-go's", () => {
  const pristine = new Environment({ unlistedVariablesAreDyn: true });

  const declaredByCelJs = (): { global: Set<string>; member: Set<string> } => {
    const surface = { global: new Set<string>(), member: new Set<string>() };
    for (const declared of pristine.getDefinitions().functions) {
      const style = declared.receiverType === null ? "global" : "member";
      surface[style].add(declared.name);
    }
    return surface;
  };

  /**
   * Functions cel-js declares and cel-go does not, by the library
   * cel-go would need for them.
   *
   * OpenFGA enables none of these: `internal/condition/condition.go`
   * builds its environment from the custom parameter types,
   * `IPAddressEnvOption` and `EagerlyValidateDeclarations`, so a
   * condition naming one is a model upstream refuses to store. That
   * is issue 381, and the declaration gate is what refuses them
   * here.
   */
  const CEL_JS_ONLY: Record<"global" | "member", readonly string[]> = {
    global: [],
    member: [
      // cel-go's ext.Strings()
      "indexOf",
      "join",
      "lastIndexOf",
      "lowerAscii",
      "split",
      "substring",
      "trim",
      "upperAscii",
      // cel-go's ext.Bindings() — `cel.bind` parses as a receiver
      // call on the `cel` namespace
      "bind",
      // cel-js's own bytes and encoding helpers, which have no
      // cel-go equivalent under any library OpenFGA enables
      "at",
      "base64",
      "hex",
      "json",
      "string",
      // the optional-types family, which cel-go declares only when
      // a host asks for it and OpenFGA never does
      "hasValue",
      "none",
      "of",
      "or",
      "orValue",
      "value",
    ],
  };

  /**
   * Functions cel-go declares and cel-js does not.
   *
   * Three, and each is already accounted for elsewhere in this
   * file: the global `matches` is why `compileCondition` rewrites
   * the call onto tsfga's own RE2 implementation rather than
   * relying on cel-js resolving it (issue 320), and `ipaddress` /
   * `in_cidr` are OpenFGA's own additions, which tsfga admits at
   * write time and cannot evaluate — the documented gap.
   */
  const CEL_GO_ONLY: Record<"global" | "member", readonly string[]> = {
    global: ["ipaddress", "matches"],
    member: ["in_cidr"],
  };

  for (const style of ["global", "member"] as const) {
    test(`${style}: every name cel-js adds is one we know about`, () => {
      const surface = declaredByCelJs();
      const added = [...surface[style]]
        .filter((name) => !CEL_GO_DECLARED_CALLS[style].has(name))
        .sort();
      expect(added).toEqual([...CEL_JS_ONLY[style]].sort());
    });

    test(`${style}: every name cel-js lacks is one we know about`, () => {
      const surface = declaredByCelJs();
      const absent = [...CEL_GO_DECLARED_CALLS[style]]
        .filter((name) => !surface[style].has(name))
        .sort();
      expect(absent).toEqual([...CEL_GO_ONLY[style]].sort());
    });
  }

  /**
   * The transcription is only as good as its source, so state the
   * source. cel-go declares `size` and `matches` in both styles and
   * everything else in one, which is the property the gate reads.
   */
  test("the transcription is two sets, not one", () => {
    const both = [...CEL_GO_DECLARED_CALLS.global].filter((name) =>
      CEL_GO_DECLARED_CALLS.member.has(name),
    );
    expect(both.sort()).toEqual(["matches", "size"]);
  });
});

/**
 * The declaration gate (issue 381).
 *
 * cel-js ships the equivalent of cel-go's `ext.Strings()` and
 * `ext.Bindings()`, OpenFGA enables neither, and there is no way to
 * remove a function from cel-js — registries lock on clone, there
 * is no `deleteFunction`, and the standard library has no opt-out.
 * So the expression is walked and a call cel-go does not declare is
 * refused where the condition is written, which is where upstream
 * refuses it.
 */
describe("a call cel-go does not declare is refused", () => {
  const compile = (expression: string): void => {
    compileCondition("gate", expression);
  };

  for (const expression of [
    "s.split(',').size() == 2",
    "s.substring(0, 1) == 'a'",
    "s.trim() == 'a'",
    "s.indexOf('b') == 1",
    "s.lastIndexOf('a') == 2",
    "s.lowerAscii() == 'ab'",
    "s.upperAscii() == 'AB'",
    "l.join(',') == 'a,b'",
    "cel.bind(x, n + 1, x > 1)",
  ]) {
    test(expression, () => {
      expect(() => compile(expression)).toThrow(ConditionCompileError);
    });
  }

  test("a name neither library declares", () => {
    expect(() => compile("not_a_function(x)")).toThrow(ConditionCompileError);
  });

  test("the message names the offending call, as upstream's does", () => {
    try {
      compile("s.trim() == 'a'");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConditionCompileError);
      expect(String((error as ConditionCompileError).cause)).toContain(
        "undeclared reference to 'trim'",
      );
    }
  });

  /**
   * The gate is a walk, not a look at the root: a refused call
   * nested three deep in an expression whose top-level call is
   * fine must still be refused.
   */
  test("a refused call nested under an allowed one", () => {
    expect(() => compile("size(s.split(','))  == 2")).toThrow(
      ConditionCompileError,
    );
  });

  /**
   * The other direction, and the one that would take out whole
   * fixture files: a name cel-go *does* declare must still be
   * written. Both styles of the two functions declared in both.
   */
  for (const expression of [
    "size(s) > 0",
    "s.size() > 0",
    "matches(s, 'a')",
    "s.matches('a')",
    "s.contains('a')",
    "s.startsWith('a')",
    "s.endsWith('a')",
    "has(m.a)",
    "l.all(i, i == 'a')",
    "l.exists(i, i == 'a')",
    "l.exists_one(i, i == 'a')",
    "l.filter(i, i == 'a') == l",
    "l.map(i, i + 'a') == l",
    "int(n) == 1",
    "uint(n) == 1u",
    "double(n) == 1.0",
    "string(n) == '1'",
    "bool(s)",
    "bytes(s) == b",
    "type(n) == int",
    "dyn(n) == 1",
    "timestamp(s) > t",
    "duration(s) > d",
    "t.getFullYear() > 0",
    "t.getMonth() == 0",
    "t.getDayOfYear() == 0",
    "t.getDayOfMonth() == 0",
    "t.getDate() == 1",
    "t.getDayOfWeek() == 0",
    "t.getHours() == 0",
    "t.getMinutes() == 0",
    "t.getSeconds() == 0",
    "t.getMilliseconds() == 0",
    "ipaddress(s) == ipaddress(s)",
    "ip.in_cidr('10.0.0.0/8')",
  ]) {
    test(`accepted: ${expression}`, () => {
      expect(() => compile(expression)).not.toThrow();
    });
  }
});

/**
 * The type check (issue 388).
 *
 * OpenFGA compiles every condition against its declared parameters
 * while it validates the model, so an expression that does not
 * type-check has no model to live in and no check to answer.
 * tsfga's parse said nothing about types, so all seven shapes the
 * issue reports answered and four of them granted.
 *
 * The check is reached by passing the declarations to
 * `compileCondition`. It is deliberately not run on the read path:
 * the verdict belongs to the definition, not to the expression,
 * and the expression cache is keyed by the expression alone.
 */
describe("an expression is checked against its declarations", () => {
  const compile = (
    expression: string,
    parameters: Record<string, ConditionParameterType>,
  ): void => {
    compileCondition("typed", expression, parameters);
  };

  describe("refused, as upstream refuses the model", () => {
    for (const [expression, parameters] of [
      ["n != 'a'", { n: "int" }],
      ["n == 1.0", { n: "int" }],
      ["n == 1u", { n: "int" }],
      ["n > 0 || other > 0", { n: "int" }],
      ["n == 'a'", { n: "int" }],
      ["n in ['a']", { n: "int" }],
      ["n", { n: "int" }],
    ] as Array<[string, Record<string, ConditionParameterType>]>) {
      test(expression, () => {
        expect(() => compile(expression, parameters)).toThrow(
          ConditionCompileError,
        );
      });
    }

    /**
     * The sharpest of the seven, and the one a type check alone
     * would miss: cel-js short-circuits the `||` before the
     * undeclared reference is evaluated, so the expression used to
     * **grant** with nothing reporting a problem. It closes only
     * because the checking environment is cloned with
     * `unlistedVariablesAreDyn` turned off.
     */
    test("an undeclared reference is named", () => {
      try {
        compile("n > 0 || other > 0", { n: "int" });
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ConditionCompileError);
        expect(String((error as ConditionCompileError).cause)).toContain(
          "other",
        );
      }
    });

    test("a non-bool output is named as upstream names it", () => {
      try {
        compile("n", { n: "int" });
        throw new Error("expected a refusal");
      } catch (error) {
        expect(String((error as ConditionCompileError).cause)).toContain(
          "expected a bool condition expression output",
        );
      }
    });
  });

  describe("accepted, as upstream accepts the model", () => {
    for (const [expression, parameters] of [
      ["n > 0", { n: "int" }],
      ["ok", { ok: "bool" }],
      ["s != ''", { s: "string" }],
      ["n + 1u == 8u", { n: "uint" }],
      ["x > 0.0", { x: "double" }],
      ["size(l) > 0", { l: "list<string>" }],
      ["'a' in l", { l: "list<string>" }],
      ["m['a'] > 0", { m: "map<int>" }],
      ["x == '1'", { x: "any" }],
      ["s.matches('^a.c$')", { s: "string" }],
      ["matches(s, '^a.c$')", { s: "string" }],
      ["now < expires_at", { now: "timestamp", expires_at: "timestamp" }],
      ["t + d > t", { t: "timestamp", d: "duration" }],
      ["int(t) > 0", { t: "timestamp" }],
      ["int(d) > 0", { d: "duration" }],
      ["string(t) == 'x'", { t: "timestamp" }],
      ["string(d) == 'x'", { d: "duration" }],
    ] as Array<[string, Record<string, ConditionParameterType>]>) {
      test(expression, () => {
        expect(() => compile(expression, parameters)).not.toThrow();
      });
    }

    /**
     * The one declaration cel-js gets wrong, and the reason the
     * verdict on a temporal expression is not enforced: cel-js
     * types `duration + timestamp` as a **Duration** where cel-go's
     * `add_duration_timestamp` types it as a Timestamp, so a
     * comparison upstream compiles is a type error here. cel-js
     * refuses to replace an existing operator overload, so this
     * cannot be repaired — only not enforced.
     */
    test("duration + timestamp, which cel-js types wrongly", () => {
      expect(() =>
        compile("d + t > t", { t: "timestamp", d: "duration" }),
      ).not.toThrow();
    });

    /**
     * Declared by OpenFGA, absent from cel-js. The write must be
     * accepted — refusing it would refuse a model upstream stores —
     * and the check that reads it still refuses, which is the gap
     * `packages/core/README.md` already documents.
     */
    test("in_cidr, which OpenFGA declares and cel-js has not", () => {
      expect(() =>
        compile("ip.in_cidr(cidr)", { ip: "any", cidr: "string" }),
      ).not.toThrow();
    });
  });

  /**
   * Two conditions may share an expression and declare different
   * parameters. The compiled expression is cached by its source
   * text, so the second must be checked against its own
   * declarations rather than inheriting the first's verdict.
   */
  test("the verdict is not cached with the expression", () => {
    const expression = "shared_388 > 0";
    expect(() => compile(expression, { shared_388: "int" })).not.toThrow();
    expect(() => compile(expression, { shared_388: "string" })).toThrow(
      ConditionCompileError,
    );
  });

  /**
   * The read path passes no declarations and must not pay for a
   * check it cannot make: an expression a check reads is compiled
   * exactly as before.
   */
  test("no declarations means no check", () => {
    expect(() => compileCondition("untyped", "n != 'a'")).not.toThrow();
  });
});
