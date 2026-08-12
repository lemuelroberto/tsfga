import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  fgaListObjects,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * Round 4, agent D5: does an answer change with size?
 *
 * Three sizes are probed, each chosen for a boundary a smaller
 * fixture cannot reach:
 *
 * - a candidate pool of 1005 objects, which crosses upstream's
 *   `ListObjectsMaxResults` of 1000;
 * - one node carrying 60 userset rows, six times the default
 *   `maxBreadth`, with the only granting row written last;
 * - a `checkMany` batch of 400.
 */

const USER = "user_d5s";
const GROUP = "group_d5s";
const WIDE = "wide_d5";

/** How many objects alice can see. Deliberately past 1000. */
const POOL = 1005;
/** How many objects nobody can see, to keep the pool honest. */
const UNSEEN = 5;
/** Userset rows on the one wide node. */
const FANOUT = 60;

function id(index: number): string {
  return `00000000-0000-4000-d560-${String(index).padStart(12, "0")}`;
}

const ALICE = id(900001);
const BOB = id(900002);
/** The wide node: one object with `FANOUT` userset rows. */
const FAN = id(900003);
/** `wide_d5` objects alice reaches, by index. */
const seen = (index: number): string => id(1000 + index);
/** `wide_d5` objects nobody reaches. */
const unseen = (index: number): string => id(500000 + index);
/** The decoy groups on the wide node. */
const sink = (index: number): string => id(700000 + index);

function config(
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
  config(GROUP, "member", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
  }),
  config(WIDE, "viewer", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
  }),
];

const TUPLES: AddTupleRequest[] = [
  ...Array.from({ length: POOL }, (_unused, index) => ({
    objectType: WIDE,
    objectId: seen(index),
    relation: "viewer",
    subjectType: USER,
    subjectId: ALICE,
  })),
  ...Array.from({ length: UNSEEN }, (_unused, index) => ({
    objectType: WIDE,
    objectId: unseen(index),
    relation: "viewer",
    subjectType: USER,
    subjectId: BOB,
  })),
  // The wide node. Only the last row leads to alice, so at every
  // breadth the granting branch is the one launched last.
  ...Array.from({ length: FANOUT }, (_unused, index) => ({
    objectType: WIDE,
    objectId: FAN,
    relation: "viewer",
    subjectType: GROUP,
    subjectId: sink(index),
    subjectRelation: "member",
  })),
  {
    objectType: GROUP,
    objectId: sink(FANOUT - 1),
    relation: "member",
    subjectType: USER,
    subjectId: ALICE,
  },
];

describe("D5 scale", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let fixture: FixtureRecord;
  let client: TsfgaClient;
  let narrow: TsfgaClient;
  let wide: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    client = createTsfga(store);
    fixture = recordFixture(client);
    narrow = createTsfga(store, { maxBreadth: 1, maxConcurrentChecks: 1 });
    wide = createTsfga(store, {
      maxBreadth: Number.POSITIVE_INFINITY,
      maxConcurrentChecks: Number.POSITIVE_INFINITY,
    });

    for (const relationConfig of CONFIGS) {
      await client.writeRelationConfig(relationConfig);
    }
    for (const tuple of TUPLES) {
      await client.addTuple(tuple);
    }

    storeId = await fgaCreateStore("d5-scale");
    authorizationModelId = await fgaWriteModel(storeId, "./d5-scale/model.dsl");
    const raw = TUPLES.map((tuple) => ({
      user: tuple.subjectRelation
        ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
        : `${tuple.subjectType}:${tuple.subjectId}`,
      relation: tuple.relation,
      object: `${tuple.objectType}:${tuple.objectId}`,
    }));
    // Upstream caps one Write at 100 tuples.
    for (let start = 0; start < raw.length; start += 100) {
      await fgaWriteTuplesRaw(
        storeId,
        authorizationModelId,
        raw.slice(start, start + 100),
      );
    }
  }, 300_000);

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("a node of 60 usersets grants at every breadth", async () => {
    for (const each of [narrow, client, wide]) {
      await expectConformance(
        storeId,
        authorizationModelId,
        each,
        {
          objectType: WIDE,
          objectId: FAN,
          relation: "viewer",
          subjectType: USER,
          subjectId: ALICE,
        },
        true,
      );
    }
  }, 120_000);

  test("a node of 60 usersets denies a stranger at every breadth", async () => {
    for (const each of [narrow, client, wide]) {
      await expectConformance(
        storeId,
        authorizationModelId,
        each,
        {
          objectType: WIDE,
          objectId: FAN,
          relation: "viewer",
          subjectType: USER,
          subjectId: BOB,
        },
        false,
      );
    }
  }, 120_000);

  test("a batch of 400 answers as 400 single checks", async () => {
    const requests = Array.from({ length: 400 }, (_unused, index) => ({
      objectType: WIDE,
      objectId: index % 2 === 0 ? seen(index) : unseen(index % UNSEEN),
      relation: "viewer",
      subjectType: USER,
      subjectId: ALICE,
    }));
    const outcomes = await client.checkMany(requests);
    expect(outcomes.map((outcome) => outcome.error ?? null)).toEqual(
      requests.map(() => null),
    );
    expect(outcomes.map((outcome) => outcome.allowed)).toEqual(
      requests.map((_unused, index) => index % 2 === 0),
    );
  }, 120_000);

  test(`GAP-480: listObjects over ${POOL} candidates`, async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      client,
      {
        objectType: WIDE,
        relation: "viewer",
        subjectType: USER,
        subjectId: ALICE,
      },
      [FAN, ...Array.from({ length: POOL }, (_unused, index) => seen(index))],
    );
  }, 300_000);

  test("upstream's truncation is a cap, not a deadline", async () => {
    // Evidence for issue 480. A deadline would give a different
    // count per run and would make the pinned answer unpinnable;
    // five runs answering the identical number says the boundary
    // is `ListObjectsMaxResults`, which is deterministic.
    const runs: string[] = [];
    for (let run = 0; run < 5; run++) {
      const objects = await fgaListObjects(storeId, authorizationModelId, {
        objectType: WIDE,
        relation: "viewer",
        subjectType: USER,
        subjectId: ALICE,
      });
      runs.push(`${objects.length}`);
    }
    expect([...new Set(runs)]).toHaveLength(1);
    // Which 1000 of the 1006 come back is a separate question, and
    // the answer decides whether the cap is reproducible at all:
    // a stable subset could be matched, a shifting one could not.
    const sets: string[] = [];
    for (let run = 0; run < 3; run++) {
      const objects = await fgaListObjects(storeId, authorizationModelId, {
        objectType: WIDE,
        relation: "viewer",
        subjectType: USER,
        subjectId: ALICE,
      });
      sets.push([...objects].sort().join(","));
    }
    expect([...new Set(sets)]).toHaveLength(1);
  }, 300_000);

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./d5-scale/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
