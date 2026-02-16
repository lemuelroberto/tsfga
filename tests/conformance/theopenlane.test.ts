import { afterAll, beforeAll, describe, test } from "bun:test";
import type { Kysely } from "kysely";
import type { RelationConfig } from "src/core/types.ts";
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

// Ref: TheOpenLane authorization model
// https://github.com/theopenlane/core/blob/b678367/fga/model/model.fga
//
// Tests 21 representative types covering all 6 authorization patterns:
// A) Exclusion in union (program, control, campaign, etc.)
// B) Intersection in union (organization can_edit)
// C) Intersection + TTU (audit_log_viewer)
// D) Contact intersection in union
// E) Evidence nested exclusion
// F) Program intersection with TTU (admin, member)

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-c200-000000000001"],
  ["bob", "00000000-0000-4000-c200-000000000002"],
  ["charlie", "00000000-0000-4000-c200-000000000003"],
  ["diana", "00000000-0000-4000-c200-000000000004"],
  ["eve", "00000000-0000-4000-c200-000000000005"],
  ["frank", "00000000-0000-4000-c200-000000000006"],
  ["grace", "00000000-0000-4000-c200-000000000007"],
  ["henry", "00000000-0000-4000-c200-000000000008"],
  ["svc_api", "00000000-0000-4000-c200-000000000009"],
  ["svc_monitor", "00000000-0000-4000-c200-00000000000a"],
  ["acme", "00000000-0000-4000-c200-00000000000b"],
  ["subsidiary", "00000000-0000-4000-c200-00000000000c"],
  ["engineering", "00000000-0000-4000-c200-00000000000d"],
  ["editors_grp", "00000000-0000-4000-c200-00000000000e"],
  ["auditors_grp", "00000000-0000-4000-c200-00000000000f"],
  ["sys_main", "00000000-0000-4000-c200-000000000010"],
  ["feat_sso", "00000000-0000-4000-c200-000000000011"],
  ["prog_compliance", "00000000-0000-4000-c200-000000000012"],
  ["ctrl_soc2", "00000000-0000-4000-c200-000000000013"],
  ["sub_access", "00000000-0000-4000-c200-000000000014"],
  ["policy_data", "00000000-0000-4000-c200-000000000015"],
  ["contact_vendor", "00000000-0000-4000-c200-000000000016"],
  ["task_review", "00000000-0000-4000-c200-000000000017"],
  ["note_ctrl", "00000000-0000-4000-c200-000000000018"],
  ["evidence_doc", "00000000-0000-4000-c200-000000000019"],
  ["std_iso", "00000000-0000-4000-c200-00000000001a"],
  ["tc_acme", "00000000-0000-4000-c200-00000000001b"],
  ["tc_doc_public", "00000000-0000-4000-c200-00000000001c"],
  ["tc_doc_private", "00000000-0000-4000-c200-00000000001d"],
  ["export_data", "00000000-0000-4000-c200-00000000001e"],
  ["file_logo", "00000000-0000-4000-c200-00000000001f"],
  ["file_ctrl", "00000000-0000-4000-c200-000000000020"],
  ["wf_def", "00000000-0000-4000-c200-000000000021"],
  ["wf_instance", "00000000-0000-4000-c200-000000000022"],
  ["assess_q1", "00000000-0000-4000-c200-000000000023"],
  ["camp_onboard", "00000000-0000-4000-c200-000000000024"],
]);

const WILDCARD = "*";

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Shorthand for RelationConfig with defaults */
function rc(
  partial: Partial<RelationConfig> &
    Pick<RelationConfig, "objectType" | "relation">,
): RelationConfig {
  return {
    directlyAssignableTypes: null,
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    allowsUsersetSubjects: false,
    ...partial,
  };
}

describe("TheOpenLane Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store, { maxDepth: 25 });

    // === Condition definitions ===
    await tsfgaClient.writeConditionDefinition({
      name: "public_group",
      expression: "public == true",
      parameters: { public: "bool" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "time_based_grant",
      expression: "current_time < grant_time + grant_duration",
      parameters: {
        current_time: "timestamp",
        grant_time: "timestamp",
        grant_duration: "duration",
      },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "email_domains_allowed",
      expression:
        'allowed_domains == [] || email_domain == "" || email_domain in allowed_domains',
      parameters: {
        email_domain: "string",
        allowed_domains: "list",
      },
    });

    // === Relation configs ===

    // --- user ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "user",
        relation: "_self",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "user",
        relation: "can_view",
        computedUserset: "_self",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "user",
        relation: "can_edit",
        computedUserset: "_self",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "user",
        relation: "can_delete",
        computedUserset: "_self",
      }),
    );

    // --- service ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "service",
        relation: "_self",
        directlyAssignableTypes: ["service"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "service",
        relation: "can_view",
        computedUserset: "_self",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "service",
        relation: "can_edit",
        computedUserset: "_self",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "service",
        relation: "can_delete",
        computedUserset: "_self",
      }),
    );

    // --- system ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "system",
        relation: "system_admin",
        directlyAssignableTypes: ["user", "service"],
      }),
    );

    // --- feature ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "feature",
        relation: "enabled",
        directlyAssignableTypes: ["organization"],
      }),
    );

    // --- organization ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "owner",
        directlyAssignableTypes: ["user"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "admin",
        directlyAssignableTypes: ["user"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "admin" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "member",
        directlyAssignableTypes: ["user"],
        impliedBy: ["owner", "admin"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "access",
        directlyAssignableTypes: ["organization"],
        allowsUsersetSubjects: true,
      }),
    );
    // helper: admin and access
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "_admin_and_access",
        intersection: [
          { type: "computedUserset", relation: "admin" },
          { type: "computedUserset", relation: "access" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_delete",
        directlyAssignableTypes: ["service"],
        impliedBy: ["owner"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_edit",
        directlyAssignableTypes: ["service"],
        impliedBy: ["_admin_and_access", "owner"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    // helper: member and access
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "_member_and_access",
        intersection: [
          { type: "computedUserset", relation: "member" },
          { type: "computedUserset", relation: "access" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_view",
        directlyAssignableTypes: ["service", "user"],
        impliedBy: ["_member_and_access", "owner", "can_edit"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["owner"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_invite_members",
        impliedBy: ["can_view", "can_edit"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "can_invite_members" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_invite_admins",
        impliedBy: ["can_edit"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "can_invite_admins" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "standard_creator",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_create_standard",
        impliedBy: ["can_edit", "standard_creator"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "group_creator",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_create_group",
        impliedBy: ["can_edit", "group_creator"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "trust_center_admin",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "organization",
        relation: "can_manage_trust_center",
        impliedBy: ["trust_center_admin", "owner"],
      }),
    );

    // --- group ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "admin",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "member",
        directlyAssignableTypes: ["user"],
        impliedBy: ["admin"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "parent_admin",
        directlyAssignableTypes: ["organization"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "parent_viewer",
        impliedBy: ["parent_admin"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "parent_editor",
        impliedBy: ["parent_admin"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "can_manage_groups" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "parent_deleter",
        impliedBy: ["parent_admin"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "can_manage_groups" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "can_delete",
        directlyAssignableTypes: ["service"],
        impliedBy: ["admin", "parent_deleter"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "can_edit",
        directlyAssignableTypes: ["service"],
        impliedBy: ["admin", "parent_editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "can_view",
        directlyAssignableTypes: ["service"],
        impliedBy: ["can_edit", "member", "parent_viewer"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "group",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- file ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "parent",
        directlyAssignableTypes: ["user", "program", "organization", "control"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "tc_doc_parent",
        directlyAssignableTypes: ["trust_center_doc"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "parent_viewer",
        impliedBy: ["can_delete", "can_edit"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "parent_editor",
        impliedBy: ["can_delete"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "parent_deleter",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "tc_doc_viewer",
        tupleToUserset: [
          { tupleset: "tc_doc_parent", computedUserset: "nda_signed" },
          { tupleset: "tc_doc_parent", computedUserset: "member" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "tc_doc_editor",
        tupleToUserset: [
          { tupleset: "tc_doc_parent", computedUserset: "can_edit" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "tc_doc_deleter",
        tupleToUserset: [
          { tupleset: "tc_doc_parent", computedUserset: "can_delete" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "can_view",
        directlyAssignableTypes: [
          "user:*",
          "service:*",
          "user",
          "service",
          "organization",
        ],
        impliedBy: ["parent_viewer", "tc_doc_viewer"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["parent_editor", "tc_doc_editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["parent_deleter", "tc_doc_deleter"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "file",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- program ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "admin",
        directlyAssignableTypes: ["user"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "member",
          },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "member",
        directlyAssignableTypes: ["user"],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "member",
          },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "auditor",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "editor",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "viewer",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "parent_viewer",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "parent_editor",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "parent_deleter",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "_editor_or_viewer_not_blocked",
        impliedBy: ["editor", "viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "can_delete",
        directlyAssignableTypes: ["service"],
        impliedBy: ["admin", "parent_deleter"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "can_edit",
        directlyAssignableTypes: ["service"],
        impliedBy: ["admin", "parent_editor", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "can_view",
        directlyAssignableTypes: ["service"],
        impliedBy: [
          "member",
          "can_edit",
          "parent_viewer",
          "_editor_or_viewer_not_blocked",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["admin"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "can_invite_members",
        impliedBy: ["member", "can_edit"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "program",
        relation: "can_invite_admins",
        computedUserset: "can_edit",
      }),
    );

    // --- control ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "parent",
        directlyAssignableTypes: [
          "user",
          "service",
          "organization",
          "program",
          "standard",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "system",
        directlyAssignableTypes: ["system"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "owner",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "delegate",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "viewer",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "member" },
          { tupleset: "parent", computedUserset: "can_view" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "editor",
        directlyAssignableTypes: ["group", "organization"],
        allowsUsersetSubjects: true,
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "admin" },
          { tupleset: "parent", computedUserset: "can_edit" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["owner", "_editor_not_blocked"],
        tupleToUserset: [
          { tupleset: "system", computedUserset: "system_admin" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["owner", "delegate", "_editor_not_blocked"],
        tupleToUserset: [
          { tupleset: "system", computedUserset: "system_admin" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit", "_viewer_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "control",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- subcontrol ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "parent",
        directlyAssignableTypes: ["user", "service", "control"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "owner",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "delegate",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "viewer",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "editor",
        directlyAssignableTypes: ["group", "organization"],
        allowsUsersetSubjects: true,
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["owner", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["owner", "delegate", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit", "_viewer_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "subcontrol",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- internal_policy ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "admin",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "editor",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "viewer",
        directlyAssignableTypes: ["program", "group"],
        allowsUsersetSubjects: true,
        impliedBy: ["editor"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "approver",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "delegate",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["admin", "approver", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["admin", "approver", "delegate", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit", "_viewer_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "internal_policy",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- contact ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "editor",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "viewer",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
        impliedBy: ["editor"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    // Pattern D: ([user, service] and member from parent)
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "_direct_and_parent_member_view",
        directlyAssignableTypes: ["user", "service"],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "member",
          },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "_direct_and_parent_member_edit",
        directlyAssignableTypes: ["user", "service"],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "member",
          },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "_direct_user_and_parent_member",
        directlyAssignableTypes: ["user"],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "member",
          },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "can_view",
        impliedBy: [
          "can_edit",
          "_viewer_not_blocked",
          "_direct_and_parent_member_view",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "can_edit",
        impliedBy: ["_editor_not_blocked", "_direct_and_parent_member_edit"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "can_delete",
        impliedBy: ["_editor_not_blocked", "_direct_user_and_parent_member"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "contact",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- task ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "parent",
        directlyAssignableTypes: [
          "user",
          "service",
          "program",
          "control",
          "procedure",
          "internal_policy",
          "subcontrol",
          "control_objective",
          "risk",
          "task",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "assignee",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "assigner",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "viewer",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "editor",
        directlyAssignableTypes: ["organization"],
        allowsUsersetSubjects: true,
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["assigner"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["assignee", "assigner", "editor", "can_delete"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["assignee", "assigner", "can_delete", "can_edit", "viewer"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "task",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- note ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "parent",
        directlyAssignableTypes: [
          "program",
          "control",
          "procedure",
          "internal_policy",
          "subcontrol",
          "control_objective",
          "task",
          "trust_center",
          "risk",
          "evidence",
          "discussion",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "owner",
        directlyAssignableTypes: ["user", "service"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "editor",
        directlyAssignableTypes: ["organization"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["owner", "editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "note",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- evidence (Pattern E: nested exclusion) ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "parent",
        directlyAssignableTypes: [
          "user",
          "service",
          "program",
          "control",
          "procedure",
          "internal_policy",
          "subcontrol",
          "control_objective",
          "task",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "editor",
        directlyAssignableTypes: ["group", "organization"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "viewer",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
        impliedBy: ["editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    // ((can_delete from parent or editor) but not blocked)
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "_delete_not_blocked",
        impliedBy: ["editor"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
        excludedBy: "blocked",
      }),
    );
    // ((can_edit from parent or editor) but not blocked)
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "_edit_not_blocked",
        impliedBy: ["editor"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
        excludedBy: "blocked",
      }),
    );
    // ((can_view from parent or viewer) but not blocked)
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "_view_not_blocked",
        impliedBy: ["viewer"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["_delete_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_delete", "_edit_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit", "_view_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "evidence",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- standard ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "associated_with",
        directlyAssignableTypes: ["trust_center"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "editor",
        directlyAssignableTypes: ["user", "service"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "viewer",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["editor"],
        tupleToUserset: [
          { tupleset: "associated_with", computedUserset: "can_view" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "parent_viewer",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "parent_editor",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "admin" },
          { tupleset: "parent", computedUserset: "owner" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "can_view",
        directlyAssignableTypes: ["user:*", "service:*"],
        impliedBy: ["viewer", "parent_viewer"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "can_edit",
        impliedBy: ["editor", "parent_editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "can_delete",
        impliedBy: ["editor", "parent_editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "standard",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- trust_center ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "system",
        directlyAssignableTypes: ["system"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "nda_signed",
        directlyAssignableTypes: ["user"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "editor",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "viewer",
        computedUserset: "editor",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "member",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "parent_viewer",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "can_edit" },
          { tupleset: "parent", computedUserset: "can_view" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "parent_editor",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "can_edit" },
          {
            tupleset: "parent",
            computedUserset: "can_manage_trust_center",
          },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "parent_deleter",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "can_view",
        directlyAssignableTypes: ["user:*", "service:*"],
        impliedBy: ["parent_viewer", "viewer"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["parent_editor", "editor"],
        tupleToUserset: [
          { tupleset: "system", computedUserset: "system_admin" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["parent_deleter"],
      }),
    );

    // --- trust_center_doc ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "parent",
        directlyAssignableTypes: ["trust_center", "user", "service"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "editor",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "viewer",
        computedUserset: "editor",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "nda_signed",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "nda_signed" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "member",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "parent_viewer",
        impliedBy: ["can_delete", "can_edit"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "parent_editor",
        impliedBy: ["can_delete"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "parent_deleter",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service", "user:*", "service:*"],
        impliedBy: ["parent_viewer", "viewer"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["parent_editor", "editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "trust_center_doc",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["parent_deleter", "editor"],
      }),
    );

    // --- export ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "export",
        relation: "system",
        directlyAssignableTypes: ["system"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "export",
        relation: "can_delete",
        tupleToUserset: [
          { tupleset: "system", computedUserset: "system_admin" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "export",
        relation: "can_edit",
        directlyAssignableTypes: ["service"],
        tupleToUserset: [
          { tupleset: "system", computedUserset: "system_admin" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "export",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit"],
      }),
    );

    // --- workflow_definition ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "parent",
        directlyAssignableTypes: ["user", "service", "organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "admin",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_delete" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "editor",
        directlyAssignableTypes: ["group", "organization"],
        allowsUsersetSubjects: true,
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "viewer",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
        impliedBy: ["editor"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["admin", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["admin", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit", "_viewer_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_definition",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- workflow_instance ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "parent",
        directlyAssignableTypes: [
          "user",
          "service",
          "organization",
          "workflow_definition",
          "control",
          "internal_policy",
          "evidence",
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "viewer",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "can_view",
        directlyAssignableTypes: ["service"],
        impliedBy: ["_viewer_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "can_edit",
        directlyAssignableTypes: ["service"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "can_delete",
        directlyAssignableTypes: ["service"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "workflow_instance",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // --- assessment ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "parent",
        directlyAssignableTypes: ["organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "owner",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "delegate",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "editor",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "admin" },
          { tupleset: "parent", computedUserset: "owner" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "viewer",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
        impliedBy: ["editor"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "can_delete",
        directlyAssignableTypes: ["user"],
        impliedBy: ["owner", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "can_edit",
        directlyAssignableTypes: ["user"],
        impliedBy: ["owner", "delegate", "_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "assessment",
        relation: "can_view",
        directlyAssignableTypes: ["user"],
        impliedBy: ["can_edit", "_viewer_not_blocked"],
      }),
    );

    // --- campaign ---
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "parent",
        directlyAssignableTypes: ["user", "service", "organization"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "editor",
        directlyAssignableTypes: ["group", "organization"],
        allowsUsersetSubjects: true,
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_edit" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "viewer",
        directlyAssignableTypes: ["group"],
        allowsUsersetSubjects: true,
        impliedBy: ["editor"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "blocked",
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "_editor_not_blocked",
        impliedBy: ["editor"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "_viewer_not_blocked",
        impliedBy: ["viewer"],
        excludedBy: "blocked",
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "can_delete",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "can_edit",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["_editor_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "can_view",
        directlyAssignableTypes: ["user", "service"],
        impliedBy: ["can_edit", "_viewer_not_blocked"],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      rc({
        objectType: "campaign",
        relation: "audit_log_viewer",
        directlyAssignableTypes: ["user", "service"],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "audit_log_viewer" },
        ],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "can_view" },
        ],
      }),
    );

    // === Tuples ===

    // Self-referencing tuples for user/service types
    await tsfgaClient.addTuple({
      objectType: "user",
      objectId: uuid("alice"),
      relation: "_self",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "service",
      objectId: uuid("svc_api"),
      relation: "_self",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });

    // Organization: acme
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "owner",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("grace"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "access",
      subjectType: "organization",
      subjectId: uuid("acme"),
      subjectRelation: "member",
      conditionName: "email_domains_allowed",
      conditionContext: { allowed_domains: ["acme.com"] },
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "can_edit",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "can_delete",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "audit_log_viewer",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "trust_center_admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "standard_creator",
      subjectType: "group",
      subjectId: uuid("editors_grp"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "group_creator",
      subjectType: "group",
      subjectId: uuid("editors_grp"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "can_view",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "time_based_grant",
      conditionContext: {
        grant_time: "2025-01-01T00:00:00Z",
        grant_duration: "3600s",
      },
    });

    // Organization: subsidiary
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("subsidiary"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });

    // System: sys_main
    await tsfgaClient.addTuple({
      objectType: "system",
      objectId: uuid("sys_main"),
      relation: "system_admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "system",
      objectId: uuid("sys_main"),
      relation: "system_admin",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });

    // Feature: feat_sso
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("feat_sso"),
      relation: "enabled",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });

    // Groups
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("eve"),
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("frank"),
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
      conditionName: "public_group",
      conditionContext: { public: true },
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "parent_admin",
      subjectType: "organization",
      subjectId: uuid("acme"),
      subjectRelation: "owner",
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("editors_grp"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("auditors_grp"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("henry"),
    });

    // Program: prog_compliance
    await tsfgaClient.addTuple({
      objectType: "program",
      objectId: uuid("prog_compliance"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("grace"),
    });
    await tsfgaClient.addTuple({
      objectType: "program",
      objectId: uuid("prog_compliance"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "program",
      objectId: uuid("prog_compliance"),
      relation: "editor",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "program",
      objectId: uuid("prog_compliance"),
      relation: "blocked",
      subjectType: "user",
      subjectId: uuid("frank"),
    });
    await tsfgaClient.addTuple({
      objectType: "program",
      objectId: uuid("prog_compliance"),
      relation: "can_edit",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });

    // Control: ctrl_soc2
    await tsfgaClient.addTuple({
      objectType: "control",
      objectId: uuid("ctrl_soc2"),
      relation: "parent",
      subjectType: "program",
      subjectId: uuid("prog_compliance"),
    });
    await tsfgaClient.addTuple({
      objectType: "control",
      objectId: uuid("ctrl_soc2"),
      relation: "owner",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "control",
      objectId: uuid("ctrl_soc2"),
      relation: "delegate",
      subjectType: "group",
      subjectId: uuid("auditors_grp"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "control",
      objectId: uuid("ctrl_soc2"),
      relation: "system",
      subjectType: "system",
      subjectId: uuid("sys_main"),
    });

    // Subcontrol: sub_access
    await tsfgaClient.addTuple({
      objectType: "subcontrol",
      objectId: uuid("sub_access"),
      relation: "parent",
      subjectType: "control",
      subjectId: uuid("ctrl_soc2"),
    });

    // Internal policy: policy_data
    await tsfgaClient.addTuple({
      objectType: "internal_policy",
      objectId: uuid("policy_data"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "internal_policy",
      objectId: uuid("policy_data"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "internal_policy",
      objectId: uuid("policy_data"),
      relation: "editor",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "internal_policy",
      objectId: uuid("policy_data"),
      relation: "approver",
      subjectType: "group",
      subjectId: uuid("auditors_grp"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "internal_policy",
      objectId: uuid("policy_data"),
      relation: "blocked",
      subjectType: "user",
      subjectId: uuid("frank"),
    });

    // Contact: contact_vendor
    await tsfgaClient.addTuple({
      objectType: "contact",
      objectId: uuid("contact_vendor"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "contact",
      objectId: uuid("contact_vendor"),
      relation: "_direct_and_parent_member_view",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "contact",
      objectId: uuid("contact_vendor"),
      relation: "_direct_and_parent_member_view",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "contact",
      objectId: uuid("contact_vendor"),
      relation: "editor",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "contact",
      objectId: uuid("contact_vendor"),
      relation: "blocked",
      subjectType: "user",
      subjectId: uuid("frank"),
    });

    // Task: task_review
    await tsfgaClient.addTuple({
      objectType: "task",
      objectId: uuid("task_review"),
      relation: "parent",
      subjectType: "control",
      subjectId: uuid("ctrl_soc2"),
    });
    await tsfgaClient.addTuple({
      objectType: "task",
      objectId: uuid("task_review"),
      relation: "assignee",
      subjectType: "user",
      subjectId: uuid("eve"),
    });
    await tsfgaClient.addTuple({
      objectType: "task",
      objectId: uuid("task_review"),
      relation: "assigner",
      subjectType: "user",
      subjectId: uuid("grace"),
    });

    // Note: note_ctrl
    await tsfgaClient.addTuple({
      objectType: "note",
      objectId: uuid("note_ctrl"),
      relation: "parent",
      subjectType: "control",
      subjectId: uuid("ctrl_soc2"),
    });
    await tsfgaClient.addTuple({
      objectType: "note",
      objectId: uuid("note_ctrl"),
      relation: "owner",
      subjectType: "user",
      subjectId: uuid("grace"),
    });

    // Evidence: evidence_doc
    await tsfgaClient.addTuple({
      objectType: "evidence",
      objectId: uuid("evidence_doc"),
      relation: "parent",
      subjectType: "program",
      subjectId: uuid("prog_compliance"),
    });
    await tsfgaClient.addTuple({
      objectType: "evidence",
      objectId: uuid("evidence_doc"),
      relation: "editor",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "evidence",
      objectId: uuid("evidence_doc"),
      relation: "blocked",
      subjectType: "user",
      subjectId: uuid("frank"),
    });

    // Standard: std_iso
    await tsfgaClient.addTuple({
      objectType: "standard",
      objectId: uuid("std_iso"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "standard",
      objectId: uuid("std_iso"),
      relation: "editor",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "standard",
      objectId: uuid("std_iso"),
      relation: "can_view",
      subjectType: "user",
      subjectId: WILDCARD,
    });

    // Trust center: tc_acme
    await tsfgaClient.addTuple({
      objectType: "trust_center",
      objectId: uuid("tc_acme"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "trust_center",
      objectId: uuid("tc_acme"),
      relation: "nda_signed",
      subjectType: "user",
      subjectId: uuid("diana"),
    });
    await tsfgaClient.addTuple({
      objectType: "trust_center",
      objectId: uuid("tc_acme"),
      relation: "editor",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "trust_center",
      objectId: uuid("tc_acme"),
      relation: "system",
      subjectType: "system",
      subjectId: uuid("sys_main"),
    });

    // Trust center docs
    await tsfgaClient.addTuple({
      objectType: "trust_center_doc",
      objectId: uuid("tc_doc_public"),
      relation: "parent",
      subjectType: "trust_center",
      subjectId: uuid("tc_acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "trust_center_doc",
      objectId: uuid("tc_doc_private"),
      relation: "parent",
      subjectType: "trust_center",
      subjectId: uuid("tc_acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "trust_center_doc",
      objectId: uuid("tc_doc_public"),
      relation: "can_view",
      subjectType: "user",
      subjectId: WILDCARD,
    });
    await tsfgaClient.addTuple({
      objectType: "trust_center_doc",
      objectId: uuid("tc_doc_public"),
      relation: "can_view",
      subjectType: "service",
      subjectId: WILDCARD,
    });

    // File: file_logo
    await tsfgaClient.addTuple({
      objectType: "file",
      objectId: uuid("file_logo"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "file",
      objectId: uuid("file_logo"),
      relation: "can_view",
      subjectType: "user",
      subjectId: WILDCARD,
    });

    // File: file_ctrl
    await tsfgaClient.addTuple({
      objectType: "file",
      objectId: uuid("file_ctrl"),
      relation: "parent",
      subjectType: "control",
      subjectId: uuid("ctrl_soc2"),
    });
    await tsfgaClient.addTuple({
      objectType: "file",
      objectId: uuid("file_ctrl"),
      relation: "tc_doc_parent",
      subjectType: "trust_center_doc",
      subjectId: uuid("tc_doc_private"),
    });

    // Export: export_data
    await tsfgaClient.addTuple({
      objectType: "export",
      objectId: uuid("export_data"),
      relation: "system",
      subjectType: "system",
      subjectId: uuid("sys_main"),
    });
    await tsfgaClient.addTuple({
      objectType: "export",
      objectId: uuid("export_data"),
      relation: "can_edit",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });

    // Workflow definition: wf_def
    await tsfgaClient.addTuple({
      objectType: "workflow_definition",
      objectId: uuid("wf_def"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "workflow_definition",
      objectId: uuid("wf_def"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // Workflow instance: wf_instance
    await tsfgaClient.addTuple({
      objectType: "workflow_instance",
      objectId: uuid("wf_instance"),
      relation: "parent",
      subjectType: "workflow_definition",
      subjectId: uuid("wf_def"),
    });
    await tsfgaClient.addTuple({
      objectType: "workflow_instance",
      objectId: uuid("wf_instance"),
      relation: "can_view",
      subjectType: "service",
      subjectId: uuid("svc_api"),
    });

    // Assessment: assess_q1
    await tsfgaClient.addTuple({
      objectType: "assessment",
      objectId: uuid("assess_q1"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "assessment",
      objectId: uuid("assess_q1"),
      relation: "owner",
      subjectType: "user",
      subjectId: uuid("grace"),
    });
    await tsfgaClient.addTuple({
      objectType: "assessment",
      objectId: uuid("assess_q1"),
      relation: "delegate",
      subjectType: "user",
      subjectId: uuid("eve"),
    });
    await tsfgaClient.addTuple({
      objectType: "assessment",
      objectId: uuid("assess_q1"),
      relation: "blocked",
      subjectType: "user",
      subjectId: uuid("frank"),
    });

    // Campaign: camp_onboard
    await tsfgaClient.addTuple({
      objectType: "campaign",
      objectId: uuid("camp_onboard"),
      relation: "parent",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "campaign",
      objectId: uuid("camp_onboard"),
      relation: "editor",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "campaign",
      objectId: uuid("camp_onboard"),
      relation: "blocked",
      subjectType: "user",
      subjectId: uuid("frank"),
    });

    // === Setup OpenFGA ===
    storeId = await fgaCreateStore("theopenlane-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/theopenlane/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/theopenlane/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Group 1: User & Service — computed userset ---
  test("1: alice can_view user:alice (self)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("alice"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("2: bob cannot can_view user:alice", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("alice"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });
  test("3: svc_api can_view service:svc_api (self)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "service",
        objectId: uuid("svc_api"),
        relation: "can_view",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });

  // --- Group 2: System & Feature ---
  test("4: alice system_admin sys_main", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "system",
        objectId: uuid("sys_main"),
        relation: "system_admin",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("5: svc_api system_admin sys_main", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "system",
        objectId: uuid("sys_main"),
        relation: "system_admin",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("6: bob not system_admin sys_main", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "system",
        objectId: uuid("sys_main"),
        relation: "system_admin",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });
  test("7: acme enabled feat_sso", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("feat_sso"),
        relation: "enabled",
        subjectType: "organization",
        subjectId: uuid("acme"),
      },
      true,
    );
  });

  // --- Group 3: Organization — core access ---
  test("8: alice can_edit acme (owner bypasses intersection)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("9: bob can_edit acme (admin ∩ access)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("10: bob cannot can_edit acme (wrong domain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "evil.com" },
      },
      false,
    );
  });
  test("11: charlie can_view acme (member ∩ access)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("12: charlie cannot can_view acme (wrong domain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "evil.com" },
      },
      false,
    );
  });
  test("13: diana cannot can_view acme (not member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("14: svc_api can_edit acme (service direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_edit",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("15: alice can_delete acme (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("16: bob cannot can_delete acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });
  test("17: bob can_view subsidiary (parent chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("subsidiary"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });

  // --- Group 4: Organization — creators ---
  test("18: charlie can_create_standard acme (editors_grp member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_standard",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("19: charlie can_create_group acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_group",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("20: eve cannot can_create_standard acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_standard",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("21: alice can_create_standard acme (owner → can_edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_create_standard",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("22: alice can_manage_trust_center acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_manage_trust_center",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("23: charlie cannot can_manage_trust_center acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_manage_trust_center",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });

  // --- Group 5: Organization — audit & invite ---
  test("24: alice audit_log_viewer acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("25: diana cannot audit_log_viewer acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("26: charlie can_invite_members acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_invite_members",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("27: charlie cannot can_invite_admins acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_invite_admins",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });

  // --- Group 6: Organization — time_based_grant ---
  test("28: alice can_view acme (within time window)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { current_time: "2025-01-01T00:30:00Z" },
      },
      true,
    );
  });
  test("29: alice can_view acme even past time window (owner path)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { current_time: "2025-01-01T02:00:00Z" },
      },
      true,
    );
  });
  test("30: svc_api can_view acme (service direct via can_edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "organization",
        objectId: uuid("acme"),
        relation: "can_view",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });

  // --- Group 7: Group — public_group condition ---
  test("31: eve can_view engineering (member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("32: alice can_edit engineering (admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("33: charlie can_view engineering (parent_viewer, public)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { public: true, email_domain: "acme.com" },
      },
      true,
    );
  });
  test("34: diana cannot can_view engineering (not org member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { public: true, email_domain: "acme.com" },
      },
      false,
    );
  });
  test("35: alice audit_log_viewer engineering (public)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { public: true, email_domain: "acme.com" },
      },
      true,
    );
  });
  test("36: frank can_view engineering (member, not blocked on group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group",
        objectId: uuid("engineering"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      true,
    );
  });

  // --- Group 8: File — wildcards & chains ---
  test("37: diana can_view file_logo (wildcard)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_logo"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });
  test("38: alice can_edit file_logo (parent_editor via org)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_logo"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("39: eve can_view file_ctrl (parent_viewer via ctrl)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_ctrl"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("40: diana can_view file_ctrl (NDA chain via tc_doc)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_ctrl"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });
  test("41: diana cannot can_edit file_ctrl", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "file",
        objectId: uuid("file_ctrl"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 9: Program — intersection & exclusion ---
  test("42: grace can_edit prog (admin: user ∩ member from parent)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("grace"),
      },
      true,
    );
  });
  test("43: eve can_edit prog (editor, not blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("44: frank cannot can_edit prog (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });
  test("45: frank cannot can_view prog (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });
  test("46: alice can_view prog (parent_viewer: owner from parent)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("47: charlie cannot can_view prog (not member/editor)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });
  test("48: svc_api can_edit prog (service direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "can_edit",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("49: grace audit_log_viewer prog (admin ∩ can_view)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "program",
        objectId: uuid("prog_compliance"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("grace"),
      },
      true,
    );
  });

  // --- Group 10: Control — owner/delegate/system ---
  test("50: eve can_edit ctrl (engineering owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("51: henry can_edit ctrl (auditors delegate)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("henry"),
      },
      true,
    );
  });
  test("52: eve can_delete ctrl (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("53: henry cannot can_delete ctrl (delegate only)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("henry"),
      },
      false,
    );
  });
  test("54: alice can_edit ctrl (system_admin from system)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("55: diana cannot can_view ctrl", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });
  test("56: alice audit_log_viewer ctrl", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "audit_log_viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("57: alice can_delete ctrl (system_admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "control",
        objectId: uuid("ctrl_soc2"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 11: Subcontrol — parent chain ---
  test("58: eve can_view sub_access (parent ctrl chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "subcontrol",
        objectId: uuid("sub_access"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("59: diana cannot can_view sub_access", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "subcontrol",
        objectId: uuid("sub_access"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });
  test("60: alice can_edit sub_access (system_admin chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "subcontrol",
        objectId: uuid("sub_access"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 12: Internal policy ---
  test("61: alice can_edit policy (admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "internal_policy",
        objectId: uuid("policy_data"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("62: eve can_edit policy (editor, not blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "internal_policy",
        objectId: uuid("policy_data"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("63: henry can_view policy (approver → can_edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "internal_policy",
        objectId: uuid("policy_data"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("henry"),
      },
      true,
    );
  });
  test("64: frank cannot can_view policy (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "internal_policy",
        objectId: uuid("policy_data"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });
  test("65: alice can_delete policy (admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "internal_policy",
        objectId: uuid("policy_data"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 13: Contact — intersection ---
  test("66: alice can_view contact (direct ∩ member from parent)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "contact",
        objectId: uuid("contact_vendor"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("67: bob can_view contact (direct ∩ member from parent)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "contact",
        objectId: uuid("contact_vendor"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("68: diana cannot can_view contact (not member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "contact",
        objectId: uuid("contact_vendor"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });
  test("69: eve can_view contact (editor, not blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "contact",
        objectId: uuid("contact_vendor"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("70: frank cannot can_view contact (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "contact",
        objectId: uuid("contact_vendor"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });
  test("71: charlie cannot can_edit contact (no direct tuple)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "contact",
        objectId: uuid("contact_vendor"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      false,
    );
  });

  // --- Group 14: Task ---
  test("72: eve can_edit task (assignee)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "task",
        objectId: uuid("task_review"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("73: grace can_delete task (assigner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "task",
        objectId: uuid("task_review"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("grace"),
      },
      true,
    );
  });
  test("74: alice can_view task (viewer from parent chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "task",
        objectId: uuid("task_review"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("75: diana cannot can_edit task", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "task",
        objectId: uuid("task_review"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 15: Note ---
  test("76: grace can_edit note (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "note",
        objectId: uuid("note_ctrl"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("grace"),
      },
      true,
    );
  });
  test("77: alice can_view note (can_view from parent chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "note",
        objectId: uuid("note_ctrl"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("78: diana cannot can_edit note", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "note",
        objectId: uuid("note_ctrl"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 16: Evidence — nested exclusion ---
  test("79: eve can_view evidence (editor, not blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "evidence",
        objectId: uuid("evidence_doc"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("80: frank cannot can_view evidence (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "evidence",
        objectId: uuid("evidence_doc"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });
  test("81: alice can_edit evidence (org owner → editor)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "evidence",
        objectId: uuid("evidence_doc"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("82: grace can_view evidence (can_view from parent prog)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "evidence",
        objectId: uuid("evidence_doc"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("grace"),
      },
      true,
    );
  });
  test("83: diana cannot can_view evidence", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "evidence",
        objectId: uuid("evidence_doc"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 17: Standard — wildcards & parent ---
  test("84: diana can_view std_iso (user:* wildcard)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "standard",
        objectId: uuid("std_iso"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });
  test("85: alice can_edit std_iso (editor direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "standard",
        objectId: uuid("std_iso"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("86: charlie cannot can_edit std_iso", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "standard",
        objectId: uuid("std_iso"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });
  test("87: charlie can_view std_iso (member from parent)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "standard",
        objectId: uuid("std_iso"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });
  test("88: bob can_view std_iso (admin → member → parent_viewer)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "standard",
        objectId: uuid("std_iso"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Group 18: Trust center & docs ---
  test("89: charlie can_view tc_acme (parent_viewer)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center",
        objectId: uuid("tc_acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { email_domain: "acme.com" },
      },
      true,
    );
  });
  test("90: alice can_edit tc_acme (parent_editor)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center",
        objectId: uuid("tc_acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("91: eve can_edit tc_acme (editor = engineering)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center",
        objectId: uuid("tc_acme"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("92: diana cannot can_view tc_acme", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center",
        objectId: uuid("tc_acme"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });
  test("93: diana can_view tc_doc_public (wildcard)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center_doc",
        objectId: uuid("tc_doc_public"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });
  test("94: diana cannot can_view tc_doc_private", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center_doc",
        objectId: uuid("tc_doc_private"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });
  test("95: eve can_edit tc_doc_public (editor via tc_acme)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center_doc",
        objectId: uuid("tc_doc_public"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("96: alice can_delete tc_doc_public (parent_deleter chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "trust_center_doc",
        objectId: uuid("tc_doc_public"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 19: Export — system ---
  test("97: svc_api can_edit export (service direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "export",
        objectId: uuid("export_data"),
        relation: "can_edit",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("98: alice can_delete export (system_admin from system)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "export",
        objectId: uuid("export_data"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("99: bob cannot can_edit export", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "export",
        objectId: uuid("export_data"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  // --- Group 20: Workflow instance ---
  test("100: svc_api can_view wf_instance (service direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workflow_instance",
        objectId: uuid("wf_instance"),
        relation: "can_view",
        subjectType: "service",
        subjectId: uuid("svc_api"),
      },
      true,
    );
  });
  test("101: bob can_view wf_instance (viewer from parent wf_def)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workflow_instance",
        objectId: uuid("wf_instance"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });
  test("102: diana cannot can_view wf_instance", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workflow_instance",
        objectId: uuid("wf_instance"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });
  test("103: frank cannot can_view wf_instance", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workflow_instance",
        objectId: uuid("wf_instance"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });

  // --- Group 21: Assessment ---
  test("104: grace can_edit assessment (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "assessment",
        objectId: uuid("assess_q1"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("grace"),
      },
      true,
    );
  });
  test("105: eve can_edit assessment (delegate)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "assessment",
        objectId: uuid("assess_q1"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("106: frank cannot can_view assessment (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "assessment",
        objectId: uuid("assess_q1"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });
  test("107: alice can_view assessment (owner from parent)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "assessment",
        objectId: uuid("assess_q1"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
  test("108: diana cannot can_view assessment", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "assessment",
        objectId: uuid("assess_q1"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 22: Campaign ---
  test("109: eve can_edit campaign (editor, not blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "campaign",
        objectId: uuid("camp_onboard"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      true,
    );
  });
  test("110: frank cannot can_edit campaign (blocked)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "campaign",
        objectId: uuid("camp_onboard"),
        relation: "can_edit",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      false,
    );
  });
  test("111: alice can_view campaign (org owner chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "campaign",
        objectId: uuid("camp_onboard"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });
});
