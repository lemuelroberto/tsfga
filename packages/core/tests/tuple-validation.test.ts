import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  DuplicateTupleError,
  InvalidConditionalTupleError,
  InvalidSubjectTypeError,
  TsfgaError,
} from "../src/errors.ts";
import { createTsfga, type TsfgaClient } from "../src/index.ts";
import { DEFAULT_WRITE_CONTEXT_BYTE_LIMIT } from "../src/tuple-validation.ts";
import type { AddTupleRequest } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * The write-path gates OpenFGA applies and tsfga did not.
 *
 * Pinned two-sided in `tests/conformance/a3-write-gate.test.ts`.
 * Here the same rules are exercised against the mock, plus the
 * three things the conformance suite cannot say: which error class
 * and cause each refusal carries, that a duplicate leaves the
 * stored row *untouched* rather than merely unreported, and that
 * the context byte limit is a write-path rule the contextual-tuple
 * path does not inherit.
 */

const BACKSPACE = "\u0008";
const DELETE = "\u007f";

function seed(store: MockTupleStore): void {
  store.relationConfigs.push(
    {
      objectType: "doc",
      relation: "userset_only",
      directlyAssignable: [{ type: "team", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    },
    {
      objectType: "doc",
      relation: "both",
      directlyAssignable: [
        { type: "user" },
        { type: "user", condition: "big" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    },
  );
  store.conditionDefinitions.push({
    name: "big",
    expression: "s != ''",
    parameters: { s: "string" },
  });
}

const conditioned = (context: Record<string, unknown>): AddTupleRequest => ({
  objectType: "doc",
  objectId: "1",
  relation: "both",
  subjectType: "user",
  subjectId: "alice",
  conditionName: "big",
  conditionContext: context,
});

describe("addTuple refuses a malformed subject", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const malformed: AddTupleRequest = {
    objectType: "doc",
    objectId: "1",
    relation: "userset_only",
    subjectType: "team",
    subjectId: "*",
    subjectRelation: "member",
  };

  test("a wildcard id carrying a subject relation", async () => {
    await expect(fga.addTuple(malformed)).rejects.toBeInstanceOf(
      InvalidSubjectTypeError,
    );
  });

  test("the refusal is discriminated as a malformed subject", async () => {
    // Not "the relation does not admit this shape": the relation
    // admits `team#member`, and `team:*#member` reads as one. The
    // defect is the ref, not the model.
    const error = await fga.addTuple(malformed).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidSubjectTypeError);
    expect(error.cause).toBe("malformed subject");
  });

  test("nothing is stored", async () => {
    await fga.addTuple(malformed).catch(() => {});
    expect(store.tuples).toHaveLength(0);
  });

  test("the same shape is refused as a contextual tuple", async () => {
    // Upstream validates a contextual tuple exactly as a write, so
    // the shape gate has to fire on both paths.
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "userset_only",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [malformed],
      }),
    ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
  });

  test("the control: a concrete userset is written", async () => {
    await expect(
      fga.addTuple({ ...malformed, subjectId: "engineering" }),
    ).resolves.toBeUndefined();
  });
});

describe("addTuple refuses forbidden characters", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const cause = async (request: AddTupleRequest): Promise<unknown> => {
    const error = await fga.addTuple(request).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidConditionalTupleError);
    return error.cause;
  };

  test("a control character in a context value", async () => {
    expect(await cause(conditioned({ s: `a${BACKSPACE}b` }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character in a context key", async () => {
    expect(await cause(conditioned({ [`s${BACKSPACE}`]: "x" }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character nested in a list", async () => {
    expect(await cause(conditioned({ s: ["ok", `a${BACKSPACE}b`] }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character nested in a struct", async () => {
    expect(await cause(conditioned({ s: { inner: `a${BACKSPACE}b` } }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character in the condition name", async () => {
    // Scanned before the definition lookup, which is upstream's
    // order: this reports the characters, not "undefined
    // condition", even though no such condition can be defined.
    expect(
      await cause({
        ...conditioned({ s: "ok" }),
        conditionName: `big${BACKSPACE}`,
      }),
    ).toBe("context contains forbidden characters");
  });

  test("a delete character is forbidden too", async () => {
    // U+007F is `Cc` and so is `unicode.IsControl`, though it sits
    // above the printable range rather than below it.
    expect(await cause(conditioned({ s: `a${DELETE}b` }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a tab is forbidden too", async () => {
    // A tab is `Cc` in Unicode and so `unicode.IsControl` in Go.
    // Asserted so the boundary is stated rather than assumed: this
    // is the one forbidden character an ordinary caller might send
    // without meaning anything by it.
    expect(await cause(conditioned({ s: "a\tb" }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("the control: an ordinary string is written", async () => {
    await expect(
      fga.addTuple(conditioned({ s: "ok" })),
    ).resolves.toBeUndefined();
  });
});

describe("addTuple refuses an oversized condition context", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  test("a context over the default limit", async () => {
    const error = await fga
      .addTuple(conditioned({ s: "x".repeat(40_000) }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidConditionalTupleError);
    expect(error.cause).toBe("context size limit exceeded");
  });

  test("the default is OpenFGA's 32 KiB", async () => {
    expect(DEFAULT_WRITE_CONTEXT_BYTE_LIMIT).toBe(32 * 1024);
  });

  test("a context just under the limit is written", async () => {
    await expect(
      fga.addTuple(conditioned({ s: "x".repeat(1_000) })),
    ).resolves.toBeUndefined();
  });

  test("the limit is configurable", async () => {
    const tight = createTsfga(store, { writeContextByteLimit: 16 });
    await expect(
      tight.addTuple(conditioned({ s: "x".repeat(100) })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
  });

  test("a contextual tuple is not measured", async () => {
    // The limit lives in upstream's Write command and nowhere
    // else, so a check request carrying a large contextual context
    // is answered rather than refused. Measuring it here would
    // refuse a request upstream accepts.
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [conditioned({ s: "x".repeat(40_000) })],
      }),
    ).resolves.toBe(true);
  });
});

/**
 * The measure itself, calibrated against v1.18.2.
 *
 * The limit is enforced on the serialised size of the
 * `google.protobuf.Struct` the context becomes on the wire, not on
 * the UTF-8 length of its JSON. The two differ in both directions —
 * JSON frames a single entry in 8 bytes where protobuf takes 15,
 * and `JSON.stringify` escapes where protobuf carries raw UTF-8 —
 * so the boundary is asserted exactly rather than approximately.
 *
 * `"x".repeat(32_753)` is the largest single-string context
 * upstream accepts: the container takes it and refuses
 * `32_756`. One entry keyed `s` costs `len(s) + 15`.
 */
describe("the condition context is measured as protobuf does", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  /**
   * A second condition, because the recursive arms need values the
   * `big` fixture's `s: string` cannot carry. `any` is what lets a
   * list, a map and a number reach the size check at all: the
   * parameter pass runs first and would otherwise refuse them
   * before anything was measured.
   */
  const nested = (context: Record<string, unknown>): AddTupleRequest => ({
    objectType: "doc",
    objectId: "1",
    relation: "anything",
    subjectType: "user",
    subjectId: "alice",
    conditionName: "anything",
    conditionContext: context,
  });

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    store.relationConfigs.push({
      objectType: "doc",
      relation: "anything",
      directlyAssignable: [{ type: "user", condition: "anything" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    store.conditionDefinitions.push({
      name: "anything",
      expression: "true",
      parameters: { s: "any", n: "any" },
    });
    fga = createTsfga(store);
  });

  test("the largest context upstream accepts is written", async () => {
    // 32_753 + 15 = 32_768, and the check is `>` the limit.
    await expect(
      fga.addTuple(conditioned({ s: "x".repeat(32_753) })),
    ).resolves.toBeUndefined();
  });

  test("one byte past it is refused", async () => {
    const error = await fga
      .addTuple(conditioned({ s: "x".repeat(32_754) }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidConditionalTupleError);
    expect(error.cause).toBe("context size limit exceeded");
  });

  test("the refusal names the protobuf size, not the JSON one", async () => {
    // JSON would say 32_769 bytes for this context; protobuf says
    // 32_771. Asserting the number pins which measure ran.
    const error = await fga
      .addTuple(conditioned({ s: "x".repeat(32_756) }))
      .catch((e) => e);
    expect(error.message).toContain("32771 bytes");
  });

  test("escaping does not inflate a quote-heavy context", async () => {
    // 20_000 quote characters are 40_008 bytes of JSON and 20_015
    // of protobuf. Upstream accepts the write, so refusing it made
    // a grant the model permits impossible to create.
    await expect(
      fga.addTuple(conditioned({ s: '"'.repeat(20_000) })),
    ).resolves.toBeUndefined();
  });

  test("a backslash-heavy context is not inflated either", async () => {
    await expect(
      fga.addTuple(conditioned({ s: "\\".repeat(20_000) })),
    ).resolves.toBeUndefined();
  });

  test("a nested list is measured through its items", async () => {
    // Each item costs `1 + varint(m) + m` inside the `ListValue`
    // and the list costs the same again as a `Value`, so the pair
    // is 40_031 bytes where one alone is 20_023.
    await expect(
      fga.addTuple(nested({ s: ["x".repeat(20_000), "y".repeat(20_000)] })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
    await expect(
      fga.addTuple(nested({ s: ["x".repeat(20_000)] })),
    ).resolves.toBeUndefined();
  });

  test("a nested map is measured through its entries", async () => {
    // 40_045 and 20_030 — a nested entry pays the map-entry framing
    // a second time, which is what makes the recursion worth
    // asserting separately from the list.
    await expect(
      fga.addTuple(
        nested({ s: { a: "x".repeat(20_000), b: "y".repeat(20_000) } }),
      ),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
    await expect(
      fga.addTuple(nested({ s: { a: "x".repeat(20_000) } })),
    ).resolves.toBeUndefined();
  });

  test("a number entry costs its fixed64", async () => {
    // A `number_value` is a tag plus eight bytes whatever it holds,
    // so the `n` entry costs 16 bytes all in. 32_737 + 16 lands on
    // 32_768 exactly and 32_738 goes over — a boundary JSON's
    // measure could not reproduce, since `1` is one byte there.
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_737), n: 1 })),
    ).resolves.toBeUndefined();
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_738), n: 1 })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
  });

  test("a null entry costs two bytes, not none", async () => {
    // `null_value` is a oneof member, and a oneof member is written
    // even holding its zero value. JSON spells it in four bytes; if
    // the measure were still JSON's, the boundary would move.
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_744), n: null })),
    ).resolves.toBeUndefined();
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_745), n: null })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
  });
});

/**
 * `IsValidUserID` and `IsValidObject`, on the write path.
 *
 * The check path has applied the subject half since round 1, so
 * until now a subject id holding `:` or `#` was writable and
 * uncheckable. Both halves report as `TsfgaError`s, so a caller
 * catching the base class sees every malformed identifier.
 */
describe("addTuple refuses a malformed identifier", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const bare = (subjectId: string): AddTupleRequest => ({
    objectType: "doc",
    objectId: "1",
    relation: "both",
    subjectType: "user",
    subjectId,
  });

  for (const [label, id] of [
    ["empty", ""],
    ["a colon", "a:b"],
    ["a hash", "a#b"],
    ["a space", "a b"],
    ["a backspace", `a${BACKSPACE}b`],
    ["a delete", `a${DELETE}b`],
  ] as const) {
    test(`a subject id holding ${label}`, async () => {
      const error = await fga.addTuple(bare(id)).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidSubjectTypeError);
      expect(error.cause).toBe("malformed subject");
      expect(store.tuples).toHaveLength(0);
    });
  }

  test("the wildcard id is still legal", async () => {
    store.relationConfigs.push({
      objectType: "doc",
      relation: "public",
      directlyAssignable: [{ type: "user", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await expect(
      fga.addTuple({ ...bare("*"), relation: "public" }),
    ).resolves.toBeUndefined();
  });

  test("a unicode subject id is written", async () => {
    await expect(fga.addTuple(bare("café"))).resolves.toBeUndefined();
  });

  test("the `user` field is bounded at 512 bytes", async () => {
    // `user:` is 5 bytes, so 507 fits and 508 does not. Bisected
    // against the container, which counts bytes rather than runes.
    await expect(fga.addTuple(bare("a".repeat(507)))).resolves.toBeUndefined();
    const error = await fga.addTuple(bare("a".repeat(508))).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidSubjectTypeError);
    expect(error.cause).toBe("malformed subject");
  });

  test("the bound counts the subject relation too", async () => {
    const long = {
      objectType: "doc",
      objectId: "1",
      relation: "userset_only",
      subjectType: "team",
      subjectId: "a".repeat(500),
      subjectRelation: "member",
    };
    // `team:` + 500 + `#member` is 512 exactly.
    await expect(fga.addTuple(long)).resolves.toBeUndefined();
    await expect(
      fga.addTuple({ ...long, subjectId: "a".repeat(501) }),
    ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
  });

  test("a contextual tuple is gated identically", async () => {
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [bare("a:b")],
      }),
    ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
  });

  for (const [label, id] of [
    ["empty", ""],
    ["a colon", "a:b"],
    ["a hash", "a#b"],
    ["a space", "a b"],
    ["a backspace", `a${BACKSPACE}b`],
  ] as const) {
    test(`an object id holding ${label}`, async () => {
      await expect(
        fga.addTuple({ ...bare("alice"), objectId: id }),
      ).rejects.toBeInstanceOf(TsfgaError);
      expect(store.tuples).toHaveLength(0);
    });
  }

  test("the `object` field is bounded at 256 code points", async () => {
    // `doc:` is 4 runes, so 252 fits and 253 does not. The bound
    // counts runes, not bytes: the container accepts 200 two-byte
    // runes.
    await expect(
      fga.addTuple({ ...bare("alice"), objectId: "a".repeat(252) }),
    ).resolves.toBeUndefined();
    await expect(
      fga.addTuple({ ...bare("alice"), objectId: "a".repeat(253) }),
    ).rejects.toBeInstanceOf(TsfgaError);
    await expect(
      fga.addTuple({ ...bare("alice"), objectId: "é".repeat(200) }),
    ).resolves.toBeUndefined();
  });
});

describe("addTuple refuses a duplicate", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  const bare: AddTupleRequest = {
    objectType: "doc",
    objectId: "1",
    relation: "both",
    subjectType: "user",
    subjectId: "alice",
  };

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  test("the second write of the same edge", async () => {
    await fga.addTuple(bare);
    await expect(fga.addTuple(bare)).rejects.toBeInstanceOf(
      DuplicateTupleError,
    );
  });

  test("the condition is not part of the key", async () => {
    // Upstream keys on `TupleKeyWithoutCondition`, so re-granting
    // the same edge under a condition is a duplicate rather than
    // an edit.
    await fga.addTuple(bare);
    await expect(
      fga.addTuple({ ...bare, conditionName: "big", conditionContext: {} }),
    ).rejects.toBeInstanceOf(DuplicateTupleError);
  });

  test("the stored row is left exactly as it was", async () => {
    // The failure this replaces was silent, and it ran in the
    // widening direction as readily as the narrowing one: an
    // upsert would have dropped the condition here.
    await fga.addTuple({
      ...bare,
      conditionName: "big",
      conditionContext: { s: "ok" },
    });
    await fga.addTuple(bare).catch(() => {});
    expect(store.tuples).toHaveLength(1);
    expect(store.tuples[0]?.conditionName).toBe("big");
    expect(store.tuples[0]?.conditionContext).toEqual({ s: "ok" });
  });

  test("the error names the edge", async () => {
    await fga.addTuple(bare);
    const error = await fga.addTuple(bare).catch((e) => e);
    expect(error.objectType).toBe("doc");
    expect(error.objectId).toBe("1");
    expect(error.relation).toBe("both");
    expect(error.subjectType).toBe("user");
    expect(error.subjectId).toBe("alice");
    expect(error.subjectRelation).toBeNull();
  });

  test("removing then writing is how a condition changes", async () => {
    await fga.addTuple(bare);
    expect(await fga.removeTuple(bare)).toBe(true);
    await expect(
      fga.addTuple({
        ...bare,
        conditionName: "big",
        conditionContext: { s: "ok" },
      }),
    ).resolves.toBeUndefined();
    expect(store.tuples[0]?.conditionName).toBe("big");
  });

  test("a different subject relation is a different edge", async () => {
    await fga.addTuple({
      objectType: "doc",
      objectId: "1",
      relation: "userset_only",
      subjectType: "team",
      subjectId: "engineering",
      subjectRelation: "member",
    });
    await expect(
      fga.addTuple({
        objectType: "doc",
        objectId: "1",
        relation: "userset_only",
        subjectType: "team",
        subjectId: "engineering",
        subjectRelation: "member",
      }),
    ).rejects.toBeInstanceOf(DuplicateTupleError);
  });
});
