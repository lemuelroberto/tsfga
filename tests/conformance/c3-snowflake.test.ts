import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
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
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * A Snowflake-shaped warehouse: account -> database -> schema ->
 * table, with privileges granted to roles and roles inheriting
 * from roles.
 *
 * Two seams are the point of this fixture.
 *
 * **USAGE is required at every level.** `schema_c3s.can_use` is
 * `local_use and can_use from database`, and
 * `table_c3s.can_select` is `local_select and can_use from
 * schema`: an intersection whose second operand is a
 * tuple-to-userset onto another intersection. A `SELECT` grant on
 * a table therefore means nothing without USAGE on the schema
 * *and* the database above it, which is the actual Snowflake rule
 * and the one a naive union model gets wrong in the granting
 * direction.
 *
 * **Ownership is a separate chain.** `can_admin` walks table ->
 * schema -> database -> account, and feeds both `local_select` and
 * `local_use`, so an owner three levels up satisfies both operands
 * of every intersection below.
 *
 * The 30-link role chain exercises depth on a recursive TTU
 * (`member: direct_member or member from parent`) without
 * dragging the resource tree into it, so what the ladder measures
 * is the dispatch budget and nothing else.
 */

const CHAIN = 30;

/** `r01` … `r30`, the chain the role hierarchy is built from. */
function role(index: number): string {
  return `r${String(index).padStart(2, "0")}`;
}

describe("Snowflake Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    expected: CheckOutcome,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId,
        relation,
        subjectType: "user_c3s",
        subjectId: subject,
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const roleMember = { type: "role_c3s", relation: "member" } as const;

    // === role_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "role_c3s",
      relation: "parent",
      directlyAssignable: [{ type: "role_c3s" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "role_c3s",
      relation: "direct_member",
      directlyAssignable: [{ type: "user_c3s" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "role_c3s",
      relation: "member",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["direct_member"],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
    });

    // === account_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "account_c3s",
      relation: "admin",
      directlyAssignable: [roleMember],
      ...plain,
    });

    // === database_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "database_c3s",
      relation: "account",
      directlyAssignable: [{ type: "account_c3s" }],
      ...plain,
    });
    for (const relation of ["owner", "usage_grant"]) {
      await tsfga.writeRelationConfig({
        objectType: "database_c3s",
        relation,
        directlyAssignable: [roleMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "database_c3s",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "account", computedUserset: "admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "database_c3s",
      relation: "can_use",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["usage_grant", "can_admin"],
    });

    // === schema_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "database",
      directlyAssignable: [{ type: "database_c3s" }],
      ...plain,
    });
    for (const relation of ["owner", "usage_grant"]) {
      await tsfga.writeRelationConfig({
        objectType: "schema_c3s",
        relation,
        directlyAssignable: [roleMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "database", computedUserset: "can_admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "local_use",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["usage_grant", "can_admin"],
    });
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "can_use",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "local_use" },
        {
          type: "tupleToUserset",
          tupleset: "database",
          computedUserset: "can_use",
        },
      ],
    });

    // === table_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "schema",
      directlyAssignable: [{ type: "schema_c3s" }],
      ...plain,
    });
    for (const relation of ["owner", "masked"]) {
      await tsfga.writeRelationConfig({
        objectType: "table_c3s",
        relation,
        directlyAssignable: [roleMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "select_grant",
      directlyAssignable: [roleMember, { type: "user_c3s" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "schema", computedUserset: "can_admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "local_select",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["select_grant", "can_admin"],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "can_select",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "local_select" },
        {
          type: "tupleToUserset",
          tupleset: "schema",
          computedUserset: "can_use",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "can_select_pii",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_select",
      excludedBy: "masked",
    });

    // === Tuples (mirroring ./c3-snowflake/tuples.yaml) ===
    for (let i = 1; i < CHAIN; i++) {
      await tsfga.addTuple({
        objectType: "role_c3s",
        objectId: role(i),
        relation: "parent",
        subjectType: "role_c3s",
        subjectId: role(i + 1),
      });
    }
    const members: Array<[string, string]> = [
      [role(CHAIN), "alice"],
      ["analyst", "bob"],
      ["engineer", "carol"],
      ["sysadmin", "dan"],
    ];
    for (const [roleId, user] of members) {
      await tsfga.addTuple({
        objectType: "role_c3s",
        objectId: roleId,
        relation: "direct_member",
        subjectType: "user_c3s",
        subjectId: user,
      });
    }

    /** A grant of `relation` on an object to a role's members. */
    const grant = (
      objectType: string,
      objectId: string,
      relation: string,
      roleId: string,
    ) =>
      tsfga.addTuple({
        objectType,
        objectId,
        relation,
        subjectType: "role_c3s",
        subjectId: roleId,
        subjectRelation: "member",
      });

    await grant("account_c3s", "acme", "admin", "sysadmin");

    for (const database of ["prod", "dev"]) {
      await tsfga.addTuple({
        objectType: "database_c3s",
        objectId: database,
        relation: "account",
        subjectType: "account_c3s",
        subjectId: "acme",
      });
    }
    await grant("database_c3s", "prod", "usage_grant", "analyst");
    await grant("database_c3s", "prod", "owner", "engineer");

    const schemas: Array<[string, string]> = [
      ["sales", "prod"],
      ["hr", "prod"],
      ["scratch", "dev"],
    ];
    for (const [schema, database] of schemas) {
      await tsfga.addTuple({
        objectType: "schema_c3s",
        objectId: schema,
        relation: "database",
        subjectType: "database_c3s",
        subjectId: database,
      });
    }
    await grant("schema_c3s", "sales", "usage_grant", "analyst");
    await grant("schema_c3s", "hr", "owner", "engineer");
    await grant("schema_c3s", "scratch", "usage_grant", "analyst");

    const tables: Array<[string, string]> = [
      ["orders", "sales"],
      ["customers", "sales"],
      ["salaries", "hr"],
      ["notes", "scratch"],
    ];
    for (const [table, schema] of tables) {
      await tsfga.addTuple({
        objectType: "table_c3s",
        objectId: table,
        relation: "schema",
        subjectType: "schema_c3s",
        subjectId: schema,
      });
    }
    await grant("table_c3s", "orders", "select_grant", "analyst");
    await tsfga.addTuple({
      objectType: "table_c3s",
      objectId: "customers",
      relation: "select_grant",
      subjectType: "user_c3s",
      subjectId: "bob",
    });
    await grant("table_c3s", "customers", "masked", "analyst");
    await grant("table_c3s", "salaries", "select_grant", "analyst");
    await grant("table_c3s", "notes", "select_grant", "analyst");

    storeId = await fgaCreateStore("c3-snowflake");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./c3-snowflake/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./c3-snowflake/tuples.yaml",
      authorizationModelId,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Role inheritance ---

  test("1: alice is a direct member of the last role", async () => {
    await can("role_c3s", role(CHAIN), "member", "alice", true);
  });

  test("2: and an inherited member one link up", async () => {
    await can("role_c3s", role(CHAIN - 1), "member", "alice", true);
  });

  test("3: ten links up", async () => {
    await can("role_c3s", role(CHAIN - 10), "member", "alice", true);
  });

  test("4: bob's flat role is nobody else's", async () => {
    await can("role_c3s", "engineer", "member", "bob", false);
  });

  test("5: the chain does not run backwards", async () => {
    await can("role_c3s", role(CHAIN), "member", "bob", false);
  });

  // --- USAGE required at every level ---

  test("6: bob may select orders — grant, schema and database", async () => {
    await can("table_c3s", "orders", "can_select", "bob", true);
  });

  test("7: bob may select customers on a direct user grant", async () => {
    await can("table_c3s", "customers", "can_select", "bob", true);
  });

  test("8: the mask takes the PII column back", async () => {
    await can("table_c3s", "customers", "can_select_pii", "bob", false);
  });

  test("9: the mask does not touch the plain select", async () => {
    await can("table_c3s", "customers", "can_select", "bob", true);
  });

  test("10: no schema usage, so the salaries grant is inert", async () => {
    await can("schema_c3s", "hr", "can_use", "bob", false);
    await can("table_c3s", "salaries", "local_select", "bob", true);
    await can("table_c3s", "salaries", "can_select", "bob", false);
  });

  test("11: schema usage without database usage is inert too", async () => {
    await can("schema_c3s", "scratch", "local_use", "bob", true);
    await can("database_c3s", "dev", "can_use", "bob", false);
    await can("schema_c3s", "scratch", "can_use", "bob", false);
    await can("table_c3s", "notes", "can_select", "bob", false);
  });

  // --- Ownership reaching down ---

  test("12: the database owner administers the table below", async () => {
    await can("table_c3s", "orders", "can_admin", "carol", true);
  });

  test("13: and therefore selects it, both operands satisfied", async () => {
    await can("table_c3s", "orders", "can_select", "carol", true);
  });

  test("14: the mask bites the owner too — it names analyst", async () => {
    await can("table_c3s", "customers", "can_select_pii", "carol", true);
  });

  test("15: the account admin reaches the dev tree", async () => {
    await can("table_c3s", "notes", "can_select", "dan", true);
  });

  test("16: the prod owner does not reach dev", async () => {
    await can("table_c3s", "notes", "can_select", "carol", false);
  });

  test("17: a stranger reaches nothing", async () => {
    await can("table_c3s", "orders", "can_select", "erin", false);
  });

  test("18: nor does the account admin lose what he never used", async () => {
    await can("database_c3s", "dev", "usage_grant", "dan", false);
  });

  // --- Depth on the recursive role chain ---

  test("19: 20 links resolve", async () => {
    await can("role_c3s", role(CHAIN - 20), "member", "alice", true);
  });

  test("20: 23 links resolve", async () => {
    await can("role_c3s", role(CHAIN - 23), "member", "alice", true);
  });

  test("21: 24 links resolve", async () => {
    await can("role_c3s", role(CHAIN - 24), "member", "alice", true);
  });

  test("22: 29 links is past every budget — both refuse", async () => {
    await can("role_c3s", role(1), "member", "alice", "refused");
  });

  test("23: 24 links deny a stranger", async () => {
    await can("role_c3s", role(CHAIN - 24), "member", "erin", false);
  });

  test("24: a subject with a tuple elsewhere refuses past the budget", async () => {
    // bob holds `role_c3s:analyst#direct_member`, a row on the same
    // relation but off the chain. Upstream cannot rule him out from
    // the tuples alone, so it walks and exhausts, as tsfga does.
    await can("role_c3s", role(1), "member", "bob", "refused");
  });

  test("GAP-340: a subject with no tuples at all is answered past the budget", async () => {
    // erin holds no `direct_member` row anywhere. Upstream's
    // recursive resolver starts from the *user* side, finds nothing
    // to walk, and answers `false` at any depth; tsfga dispatches
    // down the chain and exhausts its budget.
    await can("role_c3s", role(1), "member", "erin", false);
  });

  // --- listObjects ---

  test("25: the tables bob may select", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: "bob",
      },
      ["orders", "customers"],
    );
  });

  test("26: the tables carol may select", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: "carol",
      },
      ["orders", "customers", "salaries"],
    );
  });

  test("27: the tables dan may select", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: "dan",
      },
      ["orders", "customers", "salaries", "notes"],
    );
  });

  test("28: the databases bob may use", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "database_c3s",
        relation: "can_use",
        subjectType: "user_c3s",
        subjectId: "bob",
      },
      ["prod"],
    );
  });

  test("29: the tables bob may select unmasked", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select_pii",
        subjectType: "user_c3s",
        subjectId: "bob",
      },
      ["orders"],
    );
  });

  // --- Userset subjects ---

  test("30: the analyst userset may itself select orders", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: "orders",
        relation: "can_select",
        subjectType: "role_c3s",
        subjectId: "analyst",
        subjectRelation: "member",
      },
      true,
    );
  });

  test("31: the engineer userset does not select notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: "notes",
        relation: "can_select",
        subjectType: "role_c3s",
        subjectId: "engineer",
        subjectRelation: "member",
      },
      false,
    );
  });

  // --- The write gate ---

  test("31: a user may hold a table select grant", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: "orders",
        relation: "select_grant",
        subjectType: "user_c3s",
        subjectId: "erin",
      },
      "accepted",
    );
  });

  test("32: but not a database usage grant — roles only", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "database_c3s",
        objectId: "dev",
        relation: "usage_grant",
        subjectType: "user_c3s",
        subjectId: "erin",
      },
      "refused",
    );
  });

  test("33: a bare role is not a role's members", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "database_c3s",
        objectId: "dev",
        relation: "usage_grant",
        subjectType: "role_c3s",
        subjectId: "analyst",
      },
      "refused",
    );
  });

  test("34: a table may not be a schema's database", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "schema_c3s",
        objectId: "sales",
        relation: "database",
        subjectType: "table_c3s",
        subjectId: "orders",
      },
      "refused",
    );
  });

  test("35: the intersection relation takes no tuple", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: "orders",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: "erin",
      },
      "refused",
    );
  });

  test("36: the grant from test 31 is still gated by usage", async () => {
    await can("table_c3s", "orders", "local_select", "erin", true);
    await can("table_c3s", "orders", "can_select", "erin", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./c3-snowflake/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
