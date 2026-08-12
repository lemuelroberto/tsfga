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
 * CEL's **evaluation cost** budget, which tsfga does not have.
 *
 * `internal/modelgraph/model.go:36` builds every condition with
 * `WithMaxEvaluationCost(config.MaxConditionEvaluationCost())`,
 * which is `cel.CostLimit` on the program. The default is
 * `DefaultMaxConditionEvaluationCost = 100`
 * (`pkg/server/config/config.go:67`), and `config.go:547` refuses
 * to start with anything below 100 — so 100 is not merely a
 * default, it is the floor. A program whose *actual* cost passes
 * it is cancelled mid-evaluation and the check comes back as an
 * error rather than as a boolean.
 *
 * cel-go prices comparison and membership by operand **size**, so
 * the budget is reached by data rather than by expression shape:
 * `internal/condition/condition_test.go:374` spends 3 on
 * `x == y` for two two-character strings, and `:395` spends 4 on
 * `'a' in strlist` for a three-element list. Scale either operand
 * and the same expression crosses 100.
 *
 * That is the whole point of the limit: the expression is stored
 * at model-write time and passes every gate tsfga has, and the
 * *request* decides what it costs. `@marcbachmann/cel-js` has no
 * cost accounting at all, so tsfga evaluates to completion and
 * answers `true` where upstream refuses the request.
 *
 * Both conditions here are ordinary — one string equality, one
 * list membership — and both are asked twice: once with operands
 * that fit inside the budget, and once with operands that do not.
 * The first pair is the control that proves the divergence is the
 * *size*, not the model.
 */

const ALICE = "00000000-0000-4000-d540-000000000101";
const DOC_EQUAL = "00000000-0000-4000-d540-000000000110";
const DOC_MEMBER = "00000000-0000-4000-d540-000000000111";

/**
 * Long enough to pass 100 with room to spare. cel-go prices a
 * string comparison at roughly one unit per eight bytes of the
 * shorter operand, so 4 000 characters is about 500.
 */
const LONG = "x".repeat(4000);

/**
 * `in` walks the list, so the cost scales with its length. 300
 * entries is about three times the budget; the needle is absent so
 * the walk cannot end early.
 */
const LONG_LIST = Array.from({ length: 300 }, (_, index) => `item-${index}`);

describe("CEL evaluation-cost conformance", () => {
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

    await tsfgaClient.writeConditionDefinition({
      name: "equal_d3c",
      expression: "x == y",
      parameters: { x: "string", y: "string" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "member_d3c",
      expression: "needle in haystack",
      parameters: { needle: "string", haystack: "list<string>" },
    });

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d3c",
      relation: "viewer",
      directlyAssignable: [{ type: "user_d3c", condition: "equal_d3c" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d3c",
      relation: "member",
      directlyAssignable: [{ type: "user_d3c", condition: "member_d3c" }],
      ...plain,
    });

    storeId = await fgaCreateStore("d3-cel-cost");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./d3-cel-cost/model.dsl",
    );

    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_EQUAL,
        relation: "viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        conditionName: "equal_d3c",
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_MEMBER,
        relation: "member",
        subjectType: "user_d3c",
        subjectId: ALICE,
        conditionName: "member_d3c",
      },
      "accepted",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("control: a cheap string equality is answered by both", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_EQUAL,
        relation: "viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { x: "ab", y: "ab" },
      },
      true,
    );
  });

  test("control: a cheap list membership is answered by both", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_MEMBER,
        relation: "member",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { needle: "b", haystack: ["a", "b", "c"] },
      },
      true,
    );
  });

  test("GAP-444: a string equality over the cost budget is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_EQUAL,
        relation: "viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { x: LONG, y: LONG },
      },
      "refused",
    );
  });

  test("GAP-444: a list membership over the cost budget is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_MEMBER,
        relation: "member",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { needle: "absent", haystack: LONG_LIST },
      },
      "refused",
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./d3-cel-cost/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
