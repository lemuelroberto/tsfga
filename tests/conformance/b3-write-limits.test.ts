import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectWriteConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * The write gates round 1 added, and the id surface migration 006
 * opened.
 *
 * Two independent things are probed here:
 *
 * 1. The 32 KiB condition-context limit. Upstream measures
 *    `proto.Size` of the serialised `Struct`; tsfga measures the
 *    UTF-8 length of `JSON.stringify`. The two differ by a fixed
 *    framing overhead **and** by JSON's escaping, so there is a
 *    window on each side of the limit where the engines disagree
 *    — in both directions.
 *
 * 2. Subject ids. `tsfga.tuples.subject_id` became `text` in
 *    migration 006, so ids that the `uuid` column used to reject
 *    at the driver are now writable. Upstream's `userIDRegex` is
 *    `^[^:#\s\x00\p{Cc}]+$`; tsfga's write path applies no id rule
 *    at all, which was unobservable while the column enforced one.
 */

const ALICE = "00000000-0000-4000-d4a0-000000000001";

/** Each write gets its own object, so nothing is a duplicate by accident. */
let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-d4a0-3${String(nextObject).padStart(11, "0")}`;
}

/**
 * Upstream's framing overhead for `{"s": "<n bytes>"}`: measured
 * against v1.18.2, the protobuf `Struct` is `n + 15` bytes while
 * the JSON is `n + 8`, so ids in `[32754, 32760]` land between the
 * two measures.
 */
const BETWEEN_THE_MEASURES = 32_760;

/** A control character, written as an escape so it survives a diff. */
const BACKSPACE = String.fromCharCode(8);

describe("Write Limits and Id Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "big_b3",
      expression: 's != "zzz"',
      parameters: { s: "string" },
    });

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3w",
      relation: "bare",
      directlyAssignable: [{ type: "user_b3w" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3w",
      relation: "big",
      directlyAssignable: [{ type: "user_b3w", condition: "big_b3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3w",
      relation: "both",
      directlyAssignable: [
        { type: "user_b3w" },
        { type: "user_b3w", condition: "big_b3" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3w",
      relation: "wild",
      directlyAssignable: [{ type: "user_b3w", wildcard: true }],
      ...plain,
    });

    storeId = await fgaCreateStore("b3-write-limits-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./b3-write-limits/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function tuple(overrides: Partial<AddTupleRequest>): AddTupleRequest {
    return {
      objectType: "doc_b3w",
      objectId: objectId(),
      relation: "bare",
      subjectType: "user_b3w",
      subjectId: ALICE,
      ...overrides,
    };
  }

  async function expectWrite(
    overrides: Partial<AddTupleRequest>,
    expected: "accepted" | "refused",
  ): Promise<void> {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      tuple(overrides),
      expected,
    );
  }

  // --- the context byte limit ------------------------------------

  test("a context well under the limit is written", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: "x".repeat(1000) },
      },
      "accepted",
    );
  });

  test("a context well over the limit is refused", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: "x".repeat(40_000) },
      },
      "refused",
    );
  });

  test("GAP-242: a context between the two measures", async () => {
    // JSON: 32_768 bytes, which tsfga admits because its check is
    // `>` the limit. Protobuf: 32_775 bytes, which upstream
    // refuses. tsfga stores a row OpenFGA would not have created.
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: "x".repeat(BETWEEN_THE_MEASURES) },
      },
      "refused",
    );
  });

  test("GAP-242: a context JSON escaping inflates past the limit", async () => {
    // 20_000 quote characters are 20_015 protobuf bytes and
    // 40_008 JSON bytes. Upstream accepts the write; tsfga refuses
    // it, so a grant the model allows cannot be created at all.
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: '"'.repeat(20_000) },
      },
      "accepted",
    );
  });

  // --- control characters ----------------------------------------

  test("a control character in a context value is refused", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: `ok${BACKSPACE}` },
      },
      "refused",
    );
  });

  test("a control character nested in a list is refused", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: "ok", extra: [`bad${BACKSPACE}`] },
      },
      "refused",
    );
  });

  test("a control character in a nested map key is refused", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: "ok", extra: { [`k${BACKSPACE}`]: 1 } },
      },
      "refused",
    );
  });

  test("a DEL character in a context value is refused", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: `ok${String.fromCharCode(0x7f)}` },
      },
      "refused",
    );
  });

  test("a non-control unicode context value is written", async () => {
    await expectWrite(
      {
        relation: "big",
        conditionName: "big_b3",
        conditionContext: { s: "café   日" },
      },
      "accepted",
    );
  });

  // --- duplicate detection ---------------------------------------

  test("the same key twice is refused the second time", async () => {
    const row = tuple({ relation: "bare" });
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      row,
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      row,
      "refused",
    );
  });

  test("a conditional row over an unconditional one is a duplicate", async () => {
    const row = tuple({ relation: "both" });
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      row,
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      { ...row, conditionName: "big_b3", conditionContext: { s: "ok" } },
      "refused",
    );
  });

  test("a wildcard row is not a duplicate of a concrete one", async () => {
    const id = objectId();
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      tuple({ objectId: id, relation: "wild", subjectId: ALICE }),
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      tuple({ objectId: id, relation: "wild", subjectId: "*" }),
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      tuple({ objectId: id, relation: "wild", subjectId: "*" }),
      "refused",
    );
  });

  // --- subject ids, now that the column is text ------------------

  test("a unicode subject id is written", async () => {
    await expectWrite({ subjectId: "café" }, "accepted");
  });

  test("a long subject id is written", async () => {
    await expectWrite({ subjectId: "x".repeat(300) }, "accepted");
  });

  test("GAP-243: an empty subject id is written", async () => {
    // `userIDRegex` requires at least one character, so upstream
    // answers "the 'user' field is malformed".
    await expectWrite({ subjectId: "" }, "refused");
  });

  test("GAP-243: a subject id holding ':' is written", async () => {
    await expectWrite({ subjectId: "a:b" }, "refused");
  });

  test("GAP-243: a subject id holding a space is written", async () => {
    await expectWrite({ subjectId: "a b" }, "refused");
  });

  test("GAP-243: a subject id holding a control character is written", async () => {
    await expectWrite({ subjectId: `a${BACKSPACE}b` }, "refused");
  });

  // --- the limit does not reach a contextual tuple ---------------

  test("an oversized context on a contextual tuple is answered", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_b3w",
        objectId: objectId(),
        relation: "big",
        subjectType: "user_b3w",
        subjectId: ALICE,
        contextualTuples: [
          {
            objectType: "doc_b3w",
            objectId: "00000000-0000-4000-d4a0-000000000099",
            relation: "big",
            subjectType: "user_b3w",
            subjectId: ALICE,
            conditionName: "big_b3",
            conditionContext: { s: "x".repeat(40_000) },
          },
        ],
      },
      false,
    );
  });

  test("configs match the model", () => {
    expectConfigsMatchModel("./b3-write-limits/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
