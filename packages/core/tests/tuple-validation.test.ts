import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  DuplicateTupleError,
  InvalidConditionalTupleError,
  InvalidSubjectTypeError,
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
