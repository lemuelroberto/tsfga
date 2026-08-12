import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
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
 * A **userset as the subject of a check**.
 *
 * OpenFGA's Check and ListObjects both accept a `user` of the form
 * `type:id#relation` — "does this whole userset hold the
 * relation?" — and it is the subject form the generated corpora
 * lean on hardest: `tests/check/complexity_three.go` and
 * `check_userset.go` (v1.18.2) assert it in almost every case, as
 * `User: "ttus:...#direct_pa_direct_ch"`.
 *
 * tsfga's `CheckRequest` and `ListObjectsRequest` carry
 * `subjectType` and `subjectId` and no `subjectRelation`, so the
 * request cannot be spelled at all. The tests below pass the ref
 * the only way the type allows — `subjectId` holding
 * `"<id>#member"` — which is what makes them fail rather than
 * silently answer something else.
 *
 * See `tmp/openfga-parity/issues/080-check-subject-userset.md`.
 */

const NAMES = ["1", "eng", "other", "alice"] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d446-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const GROUP = "us_group_a5";
const DOC = "us_document_a5";

function cfg(
  objectType: string,
  relation: string,
  overrides: Partial<RelationConfig> = {},
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

const CONFIGS: RelationConfig[] = [
  cfg(GROUP, "member", { directlyAssignable: [{ type: USER }] }),
  cfg(DOC, "viewer", {
    directlyAssignable: [{ type: GROUP, relation: "member" }],
  }),
  cfg(DOC, "can_view", { computedUserset: "viewer" }),
];

const TUPLES: AddTupleRequest[] = [
  {
    objectType: DOC,
    objectId: uuid("1"),
    relation: "viewer",
    subjectType: GROUP,
    subjectId: uuid("eng"),
    subjectRelation: "member",
  },
  {
    objectType: GROUP,
    objectId: uuid("eng"),
    relation: "member",
    subjectType: USER,
    subjectId: uuid("alice"),
  },
];

describe("A5 userset as the check subject", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    for (const config of CONFIGS) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("a5-userset-subject");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./a5-userset-subject/model.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      TUPLES.map((tuple) => ({
        user: tuple.subjectRelation
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

  // Controls: the same model answered for a concrete subject.
  test("control: alice is a viewer through the userset", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: USER,
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("control: alice reaches can_view through the rewrite", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "can_view",
        subjectType: USER,
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("GAP-080: a userset subject holds the relation it was granted", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: `${uuid("eng")}#member`,
      },
      true,
    );
  });

  test("GAP-080: a userset subject reaches a computed relation", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "can_view",
        subjectType: GROUP,
        subjectId: `${uuid("eng")}#member`,
      },
      true,
    );
  });

  test("GAP-080: an ungranted userset subject is denied", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: `${uuid("other")}#member`,
      },
      false,
    );
  });

  test("GAP-080: listObjects reaches objects for a userset subject", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        relation: "viewer",
        subjectType: GROUP,
        subjectId: `${uuid("eng")}#member`,
      },
      [uuid("1")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./a5-userset-subject/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
