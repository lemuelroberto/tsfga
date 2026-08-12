import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
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
 * A grant to the nil-UUID subject.
 *
 * The Kysely adapter stores the public wildcard `"*"` as the nil
 * UUID, because `subject_id` is `uuid`-typed. It documents the
 * consequence — "callers must never use the nil UUID as a real
 * subject id" — but nothing enforces it, and OpenFGA reserves no
 * such id: `user:00000000-0000-0000-0000-000000000000` is an
 * ordinary subject upstream, distinct from `user:*`.
 *
 * So the write is accepted by both engines and then means two
 * different things. This is the granting direction, and the
 * failure is the widest one there is.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d420-400000000001"],
  ["mixed_doc", "00000000-0000-4000-d420-400000000002"],
  ["narrow_doc", "00000000-0000-4000-d420-400000000003"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Nil-UUID Subject Conformance", () => {
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

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3n",
      relation: "mixed",
      directlyAssignable: [
        { type: "user_a3n" },
        { type: "user_a3n", wildcard: true },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3n",
      relation: "narrow",
      directlyAssignable: [{ type: "user_a3n" }],
      ...plain,
    });

    storeId = await fgaCreateStore("a3-nil-subject-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./a3-nil-subject/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("the nil-UUID subject is an ordinary write for both", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("mixed_doc"),
        relation: "mixed",
        subjectType: "user_a3n",
        subjectId: NIL_UUID,
      },
      "accepted",
    );
  });

  test("GAP-045: the nil-UUID subject keeps its own grant", async () => {
    // The other half of the collision: the row reads back as the
    // wildcard, so the subject it was written for no longer
    // matches it.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("mixed_doc"),
        relation: "mixed",
        subjectType: "user_a3n",
        subjectId: NIL_UUID,
      },
      true,
    );
  });

  test("GAP-045: a nil-UUID grant does not grant everybody", async () => {
    // `mixed` admits `user_a3n:*`, so the check asks the store for
    // the wildcard row — and the adapter answers with the row
    // written for the nil-UUID subject, which `rowToTuple` maps
    // back to `"*"`. Upstream, that row grants exactly one subject.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("mixed_doc"),
        relation: "mixed",
        subjectType: "user_a3n",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("a relation admitting no wildcard is unaffected", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("narrow_doc"),
        relation: "narrow",
        subjectType: "user_a3n",
        subjectId: NIL_UUID,
      },
      "accepted",
    );
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("narrow_doc"),
        relation: "narrow",
        subjectType: "user_a3n",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./a3-nil-subject/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
