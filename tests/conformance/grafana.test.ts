import { afterAll, beforeAll, describe, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTsfga, type TsfgaClient } from "src/index.ts";
import { KyselyTupleStore } from "src/store/kysely/adapter.ts";
import type { DB } from "src/store/kysely/schema.ts";
import { expectConformance } from "tests/helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "tests/helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "tests/helpers/openfga.ts";

// Ref: Grafana Zanzana authorization schema
// Tests folder parent TTU cascade, deep impliedBy hierarchy,
// userset subjects (team#member, role#assignee), CEL conditions
// with string equality and list membership (`in` operator),
// and hyphenated type names (service-account)

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-c100-000000000001"],
  ["bob", "00000000-0000-4000-c100-000000000002"],
  ["charlie", "00000000-0000-4000-c100-000000000003"],
  ["diana", "00000000-0000-4000-c100-000000000004"],
  ["eve", "00000000-0000-4000-c100-000000000005"],
  ["bot", "00000000-0000-4000-c100-000000000006"],
  ["platform", "00000000-0000-4000-c100-000000000007"],
  ["viewer", "00000000-0000-4000-c100-000000000008"],
  ["root", "00000000-0000-4000-c100-000000000009"],
  ["dashboards", "00000000-0000-4000-c100-00000000000a"],
  ["alerts", "00000000-0000-4000-c100-00000000000b"],
  ["res_dashboards", "00000000-0000-4000-c100-00000000000c"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Grafana Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // === Condition definitions ===
    await tsfgaClient.writeConditionDefinition({
      name: "group_filter",
      expression: "requested_group == group_resource",
      parameters: {
        requested_group: "string",
        group_resource: "string",
      },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "subresource_filter",
      expression: "subresource in subresources",
      parameters: {
        subresource: "string",
        subresources: "list",
      },
    });

    // === Relation configs ===

    // role.assignee
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "assignee",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // team.admin
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "admin",
      directlyAssignableTypes: ["user", "service-account"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // team.member: [user, service-account] or admin
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "member",
      directlyAssignableTypes: ["user", "service-account"],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // team.get: [user, service-account, team#member, role#assignee] or member
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "get",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: ["member"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "parent",
      directlyAssignableTypes: ["folder"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // folder.admin: [user, service-account, team#member, role#assignee] or admin from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "admin",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.edit: [user, service-account, team#member, role#assignee] or edit from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "edit",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "edit" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.view: [user, service-account, team#member, role#assignee] or view from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "view",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "view" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.get: [user, service-account, team#member, role#assignee] or get from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "get",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "get" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.create: [user, service-account, team#member, role#assignee] or create from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "create",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "create" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.delete: [user, service-account, team#member, role#assignee] or delete from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "delete",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "delete" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.get_permissions: [user, service-account, team#member, role#assignee] or get_permissions from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "get_permissions",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "get_permissions" },
      ],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.set_permissions: [user, service-account, team#member, role#assignee] or set_permissions from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "set_permissions",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "set_permissions" },
      ],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.can_get: admin or edit or view or get
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_get",
      directlyAssignableTypes: null,
      impliedBy: ["admin", "edit", "view", "get"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // folder.can_create: admin or edit or create
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_create",
      directlyAssignableTypes: null,
      impliedBy: ["admin", "edit", "create"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // folder.can_delete: admin or edit or delete
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_delete",
      directlyAssignableTypes: null,
      impliedBy: ["admin", "edit", "delete"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // folder.can_get_permissions: admin or get_permissions
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_get_permissions",
      directlyAssignableTypes: null,
      impliedBy: ["admin", "get_permissions"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // folder.can_set_permissions: admin or set_permissions
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_set_permissions",
      directlyAssignableTypes: null,
      impliedBy: ["admin", "set_permissions"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // folder.resource_get: [... with subresource_filter] or resource_get from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_get",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "resource_get" }],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // folder.resource_create: [... with subresource_filter] or resource_create from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_create",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_create" },
      ],
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // resource.admin: [... with group_filter]
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "admin",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // resource.edit: [... with group_filter] or admin
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "edit",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // resource.view: [... with group_filter] or edit
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "view",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // resource.get: [... with group_filter] or view
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "get",
      directlyAssignableTypes: ["user", "service-account", "team", "role"],
      impliedBy: ["view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // === Tuples ===

    // Team membership
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });

    // Role assignment
    await tsfgaClient.addTuple({
      objectType: "role",
      objectId: uuid("viewer"),
      relation: "assignee",
      subjectType: "user",
      subjectId: uuid("diana"),
    });

    // Folder hierarchy: root -> dashboards -> alerts
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("root"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("alerts"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("dashboards"),
    });

    // Folder permissions
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "edit",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "view",
      subjectType: "role",
      subjectId: uuid("viewer"),
      subjectRelation: "assignee",
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "get",
      subjectType: "service-account",
      subjectId: uuid("bot"),
    });

    // Folder subresource permissions (with condition)
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "resource_create",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "subresource_filter",
      conditionContext: { subresources: ["dashboard", "library-panel"] },
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "resource_get",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
      conditionName: "subresource_filter",
      conditionContext: { subresources: ["dashboard"] },
    });

    // Resource permissions (with group_filter condition)
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "group_filter",
      conditionContext: { group_resource: "grafana" },
    });
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "view",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
      conditionName: "group_filter",
      conditionContext: { group_resource: "grafana" },
    });
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "get",
      subjectType: "user",
      subjectId: uuid("eve"),
      conditionName: "group_filter",
      conditionContext: { group_resource: "prometheus" },
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("grafana-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/grafana/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/grafana/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Group 1: Team membership ---
  test("1: alice has get on team:platform (admin implies member implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("2: bob has get on team:platform (member implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("3: diana does not have get on team:platform", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 2: Folder admin cascade via parent TTU ---
  test("4: alice can_get folder:root (direct admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("5: alice can_get folder:dashboards (admin from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("6: alice can_get folder:alerts (admin from grandparent, 2-hop TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("7: alice can_create folder:alerts (admin via TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("8: alice can_set_permissions folder:dashboards (admin via TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_set_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 3: Team userset + TTU ---
  test("9: bob can_get folder:dashboards (team:platform#member has edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("10: bob can_create folder:dashboards (edit implies can_create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("11: bob can_get folder:alerts (edit from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("12: bob does not can_get folder:root (no relation on root)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("13: charlie can_get folder:dashboards (team:platform#member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  // --- Group 4: Role assignee userset ---
  test("14: diana can_get folder:root (role:viewer#assignee has view)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  test("15: diana can_get folder:dashboards (view from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  test("16: diana can_get folder:alerts (view from grandparent, 2-hop)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  test("17: diana does not can_create folder:root (view does not imply create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 5: Service account access ---
  test("18: bot can_get folder:dashboards (direct get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      true,
    );
  });

  test("19: bot can_get folder:alerts (get from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      true,
    );
  });

  test("20: bot does not can_get folder:root (no relation on root)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      false,
    );
  });

  // --- Group 6: Computed can_* hierarchy ---
  test("21: alice can_delete folder:root (admin implies can_delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("22: alice can_get_permissions folder:root (admin implies can_get_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("23: bob can_delete folder:dashboards (edit implies can_delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("24: bob does not can_set_permissions folder:dashboards (edit does not imply set_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_set_permissions",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("25: bob does not can_get_permissions folder:dashboards (edit does not imply get_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get_permissions",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  // --- Group 7: Subresource filter with CEL `in` operator ---
  test("26: alice resource_create folder:root {subresource:dashboard} -> true", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("27: alice resource_create folder:root {subresource:library-panel} -> true", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "library-panel" },
      },
      true,
    );
  });

  test("28: alice resource_create folder:root {subresource:alert-rule} -> false", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "alert-rule" },
      },
      false,
    );
  });

  test("29: alice resource_create folder:dashboards {subresource:dashboard} -> true (parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("30: bob resource_get folder:dashboards {subresource:dashboard} -> true (team#member + condition)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("31: bob resource_get folder:dashboards {subresource:alert-rule} -> false (not in list)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "alert-rule" },
      },
      false,
    );
  });

  test("32: bob resource_get folder:alerts {subresource:dashboard} -> true (parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  // --- Group 8: Resource group_filter condition ---
  test("33: alice get resource:dashboards {requested_group:grafana} -> true (admin implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("34: alice get resource:dashboards {requested_group:prometheus} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("35: bob get resource:dashboards {requested_group:grafana} -> true (team#member view implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("36: bob get resource:dashboards {requested_group:prometheus} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("37: eve get resource:dashboards {requested_group:prometheus} -> true (matching group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { requested_group: "prometheus" },
      },
      true,
    );
  });

  test("38: eve get resource:dashboards {requested_group:grafana} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { requested_group: "grafana" },
      },
      false,
    );
  });

  // --- Group 9: Negative / cross-cutting ---
  test("39: eve does not can_get folder:root (no folder relation)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      false,
    );
  });

  test("40: eve does not edit resource:dashboards {requested_group:prometheus} (only has get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "edit",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("41: diana does not get resource:dashboards {requested_group:grafana} (no resource relation)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { requested_group: "grafana" },
      },
      false,
    );
  });

  test("42: bob does not resource_get folder:root {subresource:dashboard} (no resource_get on root for team)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "dashboard" },
      },
      false,
    );
  });

  test("43: diana does not can_delete folder:dashboards (view does not imply delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  test("44: charlie can_create folder:alerts (team member, edit from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("45: bot does not can_create folder:dashboards (get does not imply create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_create",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      false,
    );
  });
});
