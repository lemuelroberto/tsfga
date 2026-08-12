import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * Object ids that are not UUIDs, through every rewrite kind.
 *
 * Migration `007` made `tsfga.tuples.object_id` `text` (issue
 * 281): before it, two ids differing outside the hex digits of a
 * UUID collapsed onto one row, and the whole conformance corpus
 * used UUIDs, so nothing exercised the column as a string. What
 * this file asserts is that an id upstream treats as an opaque
 * string is one tsfga treats the same way at every point a
 * *different* id could be substituted for it: a direct row, a
 * userset row, a wildcard row, a tuple-to-userset hop onto a
 * second object, an exclusion, and the `listObjects` candidate
 * pool.
 *
 * The pairs that differ only in case are the sharp end. `doc.one`
 * and `DOC.one` are two objects to OpenFGA, and were one object to
 * the `uuid` column, which normalised what it stored.
 */

const ALICE = "alice.smith";
const BOB = "BOB.smith";

/** Object ids no `uuid` column would have taken. */
const DOC_LOWER = "doc.one";
const DOC_UPPER = "DOC.one";
const DOC_TTU = "doc|ttu";
const DOC_TEAM = "doc-team";
const DOC_WILD = "doc_wild";
const DOC_BLOCKED = "doc.blocked";
const DOC_UNICODE = "dökümän-1";
const DOC_NUMERIC = "0";
const FOLDER = "Folder.A";
const FOLDER_OTHER = "folder.a";
const TEAM = "team~1";

describe("Non-UUID Identifier Conformance", () => {
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
      objectType: "team_c2i",
      relation: "member",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_c2i",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "parent",
      directlyAssignable: [{ type: "folder_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "owner",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "blocked",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "viewer",
      directlyAssignable: [
        { type: "user_c2i" },
        { type: "user_c2i", wildcard: true },
        { type: "team_c2i", relation: "member" },
      ],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "allowed",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "viewer",
      tupleToUserset: null,
      excludedBy: "blocked",
      intersection: null,
    });

    const tuples = [
      // A direct row on the lower-case id; nothing on the
      // upper-case one.
      {
        objectType: "doc_c2i",
        objectId: DOC_LOWER,
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      // A tuple-to-userset hop onto a folder whose id differs from
      // a second folder only in case.
      {
        objectType: "doc_c2i",
        objectId: DOC_TTU,
        relation: "parent",
        subjectType: "folder_c2i",
        subjectId: FOLDER,
      },
      {
        objectType: "folder_c2i",
        objectId: FOLDER,
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      {
        objectType: "folder_c2i",
        objectId: FOLDER_OTHER,
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: BOB,
      },
      // A userset row.
      {
        objectType: "doc_c2i",
        objectId: DOC_TEAM,
        relation: "viewer",
        subjectType: "team_c2i",
        subjectId: TEAM,
        subjectRelation: "member",
      },
      {
        objectType: "team_c2i",
        objectId: TEAM,
        relation: "member",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      // A wildcard row.
      {
        objectType: "doc_c2i",
        objectId: DOC_WILD,
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: "*",
      },
      // An exclusion.
      {
        objectType: "doc_c2i",
        objectId: DOC_BLOCKED,
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      {
        objectType: "doc_c2i",
        objectId: DOC_BLOCKED,
        relation: "blocked",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      // Ids at the edges of what a string id can be.
      {
        objectType: "doc_c2i",
        objectId: DOC_UNICODE,
        relation: "owner",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      {
        objectType: "doc_c2i",
        objectId: DOC_NUMERIC,
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
    ] as const;

    for (const tuple of tuples) await tsfgaClient.addTuple(tuple);

    storeId = await fgaCreateStore("c2-ids-conformance");
    authorizationModelId = await fgaWriteModel(storeId, "./c2-ids/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      tuples.map((tuple) => ({
        user:
          "subjectRelation" in tuple
            ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
            : `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function expectCheck(
    objectId: string,
    relation: string,
    subjectId: string,
    expected: boolean | "refused",
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2i",
        objectId,
        relation,
        subjectType: "user_c2i",
        subjectId,
      },
      expected,
    );
  }

  test("a dotted object id grants directly", async () => {
    await expectCheck(DOC_LOWER, "viewer", ALICE, true);
  });

  test("an id differing only in case is a different object", async () => {
    await expectCheck(DOC_UPPER, "viewer", ALICE, false);
  });

  test("a dotted subject id differing only in case is a different subject", async () => {
    await expectCheck(DOC_LOWER, "viewer", BOB, false);
  });

  test("a tuple-to-userset hop keeps the linked id verbatim", async () => {
    await expectCheck(DOC_TTU, "viewer", ALICE, true);
  });

  test("the tuple-to-userset hop does not reach the other case", async () => {
    // `folder.a#viewer` holds BOB, `Folder.A#viewer` holds ALICE,
    // and `doc|ttu#parent` names the second.
    await expectCheck(DOC_TTU, "viewer", BOB, false);
  });

  test("a userset row on a tilde id expands", async () => {
    await expectCheck(DOC_TEAM, "viewer", ALICE, true);
  });

  test("a wildcard row on an underscore id grants", async () => {
    await expectCheck(DOC_WILD, "viewer", BOB, true);
  });

  test("an exclusion on a dotted id denies", async () => {
    await expectCheck(DOC_BLOCKED, "allowed", ALICE, false);
  });

  test("a non-ASCII id grants through relation inheritance", async () => {
    await expectCheck(DOC_UNICODE, "viewer", ALICE, true);
  });

  test("an id of a single digit grants", async () => {
    await expectCheck(DOC_NUMERIC, "viewer", ALICE, true);
  });

  test("listObjects returns every string id and no other", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2i",
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      [
        DOC_LOWER,
        DOC_TTU,
        DOC_TEAM,
        DOC_WILD,
        DOC_BLOCKED,
        DOC_UNICODE,
        DOC_NUMERIC,
      ],
    );
  });

  test("listObjects for the wildcard-only subject", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2i",
        relation: "allowed",
        subjectType: "user_c2i",
        subjectId: BOB,
      },
      [DOC_WILD],
    );
  });

  test("the fixture's configs match its model", () => {
    expectConfigsMatchModel("./c2-ids/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
