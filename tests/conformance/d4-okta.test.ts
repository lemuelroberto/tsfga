import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import {
  type AddTupleRequest,
  type ConditionDefinition,
  createTsfga,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  fgaBatchCheck,
  fgaListUsers,
  renderSubject,
} from "./c4-batch/upstream.ts";
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
 * An Okta/Entra-shaped identity provider: org units, nested
 * groups, app assignments, and admin roles scoped to an OU.
 *
 * Two seams are the reason this fixture exists.
 *
 * First, **an assignment names a userset on a relation that is
 * itself a rewrite**. `group_d4o.member` is `direct_member but not
 * excluded`, and every grant in the model is written against
 * `group_d4o#member` — never against the direct relation
 * underneath it. So each app assignment has to expand a nested
 * userset (`g_eng#direct_member` inside `g_all`) and then apply an
 * exclusion *on top of the resolved set*: bob is a direct member
 * of `g_eng`, is therefore carried into `g_all`, and is then taken
 * back out by one `excluded` row. Groups in a real directory
 * behave exactly this way, and it is the shape issue 300 broke on.
 *
 * Second, **contextual tuples that meet a stored row on the same
 * key**. `frank`'s assignment is conditioned on MFA and `dan`'s is
 * not; a request that sends the opposite row for the same
 * object/relation/subject is asking whether contextual tuples join
 * the stored ones or replace them, in both directions — the
 * question issue 342 answered for wildcards and this asks for
 * ordinary and conditioned rows.
 *
 * Around them: an admin role inherited down a three-level OU tree
 * with a per-OU suspension cutting it, a wildcard deprovision that
 * closes an app to everyone, two intersections (one of two
 * rewrites, one of a rewrite with a TTU), and a device-trust
 * pattern whose RE2 uses a bounded repetition.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "mfa_ok_d4o",
    expression: "mfa_level in required_levels",
    parameters: { mfa_level: "string", required_levels: "list<string>" },
  },
  {
    name: "device_trusted_d4o",
    expression: 'device_id.startsWith("dev-") && size(device_id) == 12',
    parameters: { device_id: "string" },
  },
];

const FIDO = { mfa_level: "fido" };
const SMS = { mfa_level: "sms" };
const GOOD_DEVICE = { device_id: "dev-0a1b2c3d" };
const BAD_DEVICE = { device_id: "dev-0a1b2c" };

describe("Okta Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fgaClient: OpenFgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    expected: CheckOutcome,
    extra?: {
      context?: Record<string, unknown>;
      contextualTuples?: AddTupleRequest[];
    },
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId,
        relation,
        subjectType: "user_d4o",
        subjectId: subject,
        ...(extra?.context ? { context: extra.context } : {}),
        ...(extra?.contextualTuples
          ? { contextualTuples: extra.contextualTuples }
          : {}),
      },
      expected,
    );
  }

  function userRef(tuple: {
    subjectType: string;
    subjectId: string;
    subjectRelation?: string | null;
  }): string {
    return tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`;
  }

  /** Take a row out of both engines, asserting both had it. */
  async function revoke(tuple: RemoveTupleRequest): Promise<void> {
    const [removed] = await Promise.all([
      tsfga.removeTuple(tuple),
      fgaClient
        .deleteTuples(
          [
            {
              user: userRef(tuple),
              relation: tuple.relation,
              object: `${tuple.objectType}:${tuple.objectId}`,
            },
          ],
          { authorizationModelId },
        )
        .then(() => "deleted")
        .catch((error: unknown) => {
          if (
            error instanceof FgaApiValidationError &&
            error.apiErrorCode === ErrorCode.WriteFailedDueToInvalidInput
          ) {
            return "missing";
          }
          throw error;
        })
        .then((outcome) => expect(outcome).toBe("deleted")),
    ]);
    expect(removed).toBe(true);
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    for (const condition of CONDITIONS) {
      await tsfga.writeConditionDefinition(condition);
    }

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const person = { type: "user_d4o" } as const;
    const anyone = { type: "user_d4o", wildcard: true } as const;
    const groupMember = { type: "group_d4o", relation: "member" } as const;

    // --- group ---
    await tsfga.writeRelationConfig({
      objectType: "group_d4o",
      relation: "direct_member",
      directlyAssignable: [
        person,
        { type: "group_d4o", relation: "direct_member" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "group_d4o",
      relation: "excluded",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "group_d4o",
      relation: "member",
      directlyAssignable: [],
      ...plain,
      computedUserset: "direct_member",
      excludedBy: "excluded",
    });

    // --- ou ---
    await tsfga.writeRelationConfig({
      objectType: "ou_d4o",
      relation: "parent_ou",
      directlyAssignable: [{ type: "ou_d4o" }],
      ...plain,
    });
    for (const relation of ["admin", "helpdesk"]) {
      await tsfga.writeRelationConfig({
        objectType: "ou_d4o",
        relation,
        directlyAssignable: [person, groupMember],
        ...plain,
        tupleToUserset: [{ tupleset: "parent_ou", computedUserset: relation }],
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "ou_d4o",
      relation: "suspended",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "ou_d4o",
      relation: "can_administer",
      directlyAssignable: [],
      ...plain,
      computedUserset: "admin",
      excludedBy: "suspended",
    });
    await tsfga.writeRelationConfig({
      objectType: "ou_d4o",
      relation: "can_reset_password",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["admin", "helpdesk"],
      excludedBy: "suspended",
    });

    // --- app ---
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "owner_ou",
      directlyAssignable: [{ type: "ou_d4o" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "assigned",
      directlyAssignable: [
        person,
        groupMember,
        { type: "user_d4o", condition: "mfa_ok_d4o" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "deprovisioned",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "admin_access",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [
        { tupleset: "owner_ou", computedUserset: "can_administer" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "can_use",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["assigned", "admin_access"],
      excludedBy: "deprovisioned",
    });
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "can_configure",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "admin_access" },
        { type: "computedUserset", relation: "can_use" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "app_d4o",
      relation: "can_audit",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "assigned" },
        {
          type: "tupleToUserset",
          tupleset: "owner_ou",
          computedUserset: "helpdesk",
        },
      ],
    });

    // --- session ---
    await tsfga.writeRelationConfig({
      objectType: "session_d4o",
      relation: "app",
      directlyAssignable: [{ type: "app_d4o" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "session_d4o",
      relation: "principal",
      directlyAssignable: [
        { type: "user_d4o", condition: "device_trusted_d4o" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "session_d4o",
      relation: "can_open",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "principal" },
        { type: "tupleToUserset", tupleset: "app", computedUserset: "can_use" },
      ],
    });

    // === Tuples (mirroring ./d4-okta/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "group_d4o",
        objectId: "g_eng",
        relation: "direct_member",
        subjectType: "user_d4o",
        subjectId: "alice",
      },
      {
        objectType: "group_d4o",
        objectId: "g_eng",
        relation: "direct_member",
        subjectType: "user_d4o",
        subjectId: "bob",
      },
      {
        objectType: "group_d4o",
        objectId: "g_all",
        relation: "direct_member",
        subjectType: "group_d4o",
        subjectId: "g_eng",
        subjectRelation: "direct_member",
      },
      {
        objectType: "group_d4o",
        objectId: "g_all",
        relation: "direct_member",
        subjectType: "user_d4o",
        subjectId: "carol",
      },
      {
        objectType: "group_d4o",
        objectId: "g_all",
        relation: "excluded",
        subjectType: "user_d4o",
        subjectId: "bob",
      },
      {
        objectType: "ou_d4o",
        objectId: "ou_eu",
        relation: "parent_ou",
        subjectType: "ou_d4o",
        subjectId: "ou_root",
      },
      {
        objectType: "ou_d4o",
        objectId: "ou_eu_sales",
        relation: "parent_ou",
        subjectType: "ou_d4o",
        subjectId: "ou_eu",
      },
      {
        objectType: "ou_d4o",
        objectId: "ou_root",
        relation: "admin",
        subjectType: "group_d4o",
        subjectId: "g_all",
        subjectRelation: "member",
      },
      {
        objectType: "ou_d4o",
        objectId: "ou_eu",
        relation: "helpdesk",
        subjectType: "user_d4o",
        subjectId: "dan",
      },
      {
        objectType: "ou_d4o",
        objectId: "ou_eu_sales",
        relation: "suspended",
        subjectType: "user_d4o",
        subjectId: "carol",
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "owner_ou",
        subjectType: "ou_d4o",
        subjectId: "ou_eu_sales",
      },
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "owner_ou",
        subjectType: "ou_d4o",
        subjectId: "ou_root",
      },
      {
        objectType: "app_d4o",
        objectId: "app_wiki",
        relation: "owner_ou",
        subjectType: "ou_d4o",
        subjectId: "ou_eu",
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "assigned",
        subjectType: "group_d4o",
        subjectId: "g_all",
        subjectRelation: "member",
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "assigned",
        subjectType: "user_d4o",
        subjectId: "dan",
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "assigned",
        subjectType: "user_d4o",
        subjectId: "frank",
        conditionName: "mfa_ok_d4o",
        conditionContext: { required_levels: ["otp", "fido"] },
      },
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "assigned",
        subjectType: "group_d4o",
        subjectId: "g_all",
        subjectRelation: "member",
      },
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "deprovisioned",
        subjectType: "user_d4o",
        subjectId: "carol",
      },
      {
        objectType: "app_d4o",
        objectId: "app_wiki",
        relation: "assigned",
        subjectType: "group_d4o",
        subjectId: "g_all",
        subjectRelation: "member",
      },
      {
        objectType: "app_d4o",
        objectId: "app_wiki",
        relation: "deprovisioned",
        subjectType: "user_d4o",
        subjectId: "*",
      },
      {
        objectType: "session_d4o",
        objectId: "s1",
        relation: "app",
        subjectType: "app_d4o",
        subjectId: "app_crm",
      },
      {
        objectType: "session_d4o",
        objectId: "s1",
        relation: "principal",
        subjectType: "user_d4o",
        subjectId: "alice",
        conditionName: "device_trusted_d4o",
      },
      {
        objectType: "session_d4o",
        objectId: "s2",
        relation: "app",
        subjectType: "app_d4o",
        subjectId: "app_wiki",
      },
      {
        objectType: "session_d4o",
        objectId: "s2",
        relation: "principal",
        subjectType: "user_d4o",
        subjectId: "alice",
        conditionName: "device_trusted_d4o",
      },
    ];
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("d4-okta");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(storeId, "./d4-okta/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./d4-okta/tuples.yaml",
      authorizationModelId,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The group whose membership is itself a rewrite ---

  test("1: the nested userset carries alice into the outer group", async () => {
    await can("group_d4o", "g_all", "direct_member", "alice", true);
    await can("group_d4o", "g_all", "member", "alice", true);
  });

  test("2: bob arrives the same way and is then taken back out", async () => {
    await can("group_d4o", "g_all", "direct_member", "bob", true);
    await can("group_d4o", "g_all", "excluded", "bob", true);
    await can("group_d4o", "g_all", "member", "bob", false);
  });

  test("3: the exclusion is local to the outer group", async () => {
    await can("group_d4o", "g_eng", "member", "bob", true);
  });

  test("4: a direct member of the outer group is unaffected", async () => {
    await can("group_d4o", "g_all", "member", "carol", true);
  });

  // --- The admin role, inherited down the OU tree ---

  test("5: the group's members administer the root OU", async () => {
    await can("ou_d4o", "ou_root", "can_administer", "alice", true);
    await can("ou_d4o", "ou_root", "can_administer", "carol", true);
  });

  test("6: and bob does not, because the userset excluded him", async () => {
    await can("ou_d4o", "ou_root", "admin", "bob", false);
    await can("ou_d4o", "ou_root", "can_administer", "bob", false);
  });

  test("7: the role reaches two levels down", async () => {
    await can("ou_d4o", "ou_eu", "can_administer", "alice", true);
    await can("ou_d4o", "ou_eu_sales", "can_administer", "alice", true);
  });

  test("8: a per-OU suspension cuts it at one level only", async () => {
    await can("ou_d4o", "ou_eu_sales", "admin", "carol", true);
    await can("ou_d4o", "ou_eu_sales", "can_administer", "carol", false);
    await can("ou_d4o", "ou_eu", "can_administer", "carol", true);
  });

  test("9: helpdesk inherits down but not up", async () => {
    await can("ou_d4o", "ou_eu", "can_reset_password", "dan", true);
    await can("ou_d4o", "ou_eu_sales", "can_reset_password", "dan", true);
    await can("ou_d4o", "ou_root", "can_reset_password", "dan", false);
  });

  test("10: the suspension applies to the helpdesk union too", async () => {
    await can("ou_d4o", "ou_eu_sales", "can_reset_password", "carol", false);
  });

  // --- App assignment ---

  test("11: the group assignment reaches the app", async () => {
    await can("app_d4o", "app_crm", "can_use", "alice", true);
    await can("app_d4o", "app_crm", "can_use", "carol", true);
  });

  test("12: and the excluded member does not reach it", async () => {
    await can("app_d4o", "app_crm", "can_use", "bob", false);
  });

  test("13: a per-user deprovision beats the group assignment", async () => {
    await can("app_d4o", "app_hr", "assigned", "carol", true);
    await can("app_d4o", "app_hr", "can_use", "carol", false);
    await can("app_d4o", "app_hr", "can_use", "alice", true);
  });

  test("14: a wildcard deprovision closes the app to everyone", async () => {
    await can("app_d4o", "app_wiki", "assigned", "alice", true);
    await can("app_d4o", "app_wiki", "can_use", "alice", false);
    await can("app_d4o", "app_wiki", "can_use", "carol", false);
  });

  // --- MFA on one arm of a relation that admits three ---

  test("15: frank reaches the app with an accepted factor", async () => {
    await can("app_d4o", "app_crm", "can_use", "frank", true, {
      context: FIDO,
    });
  });

  test("16: and not with an unlisted one", async () => {
    await can("app_d4o", "app_crm", "can_use", "frank", false, {
      context: SMS,
    });
  });

  test("17: a missing factor refuses rather than denying", async () => {
    await can("app_d4o", "app_crm", "can_use", "frank", "refused");
  });

  test("18: the unconditioned arms need no MFA context at all", async () => {
    await can("app_d4o", "app_crm", "can_use", "dan", true);
  });

  // --- The two intersections ---

  test("19: configuring needs both the admin path and the use", async () => {
    await can("app_d4o", "app_crm", "can_configure", "alice", true);
    await can("app_d4o", "app_crm", "can_configure", "dan", false);
  });

  test("20: the suspension breaks one operand and so the whole", async () => {
    await can("app_d4o", "app_crm", "admin_access", "carol", false);
    await can("app_d4o", "app_crm", "can_configure", "carol", false);
  });

  test("21: the wildcard deprovision breaks the other operand", async () => {
    await can("app_d4o", "app_wiki", "admin_access", "alice", true);
    await can("app_d4o", "app_wiki", "can_configure", "alice", false);
  });

  test("22: auditing pairs an assignment with a TTU operand", async () => {
    await can("app_d4o", "app_crm", "can_audit", "dan", true);
    await can("app_d4o", "app_crm", "can_audit", "alice", false);
    await can("app_d4o", "app_hr", "can_audit", "dan", false);
  });

  // --- Sessions: an intersection of a conditioned arm with a TTU ---

  test("23: a trusted device opens a session on a live app", async () => {
    await can("session_d4o", "s1", "can_open", "alice", true, {
      context: GOOD_DEVICE,
    });
  });

  test("24: the length rejects a short id", async () => {
    await can("session_d4o", "s1", "can_open", "alice", false, {
      context: BAD_DEVICE,
    });
    // Added negative: the right length with no `dev-` prefix. The
    // old pattern rejected it and so must the rewrite, otherwise
    // the size test is doing all the work on its own.
    await can("session_d4o", "s1", "can_open", "alice", false, {
      context: { device_id: "tmp-0a1b2c3d" },
    });
  });

  test("25: a trusted device does not open a closed app", async () => {
    await can("session_d4o", "s2", "principal", "alice", true, {
      context: GOOD_DEVICE,
    });
    await can("session_d4o", "s2", "can_open", "alice", false, {
      context: GOOD_DEVICE,
    });
  });

  test("26: a missing device id refuses", async () => {
    await can("session_d4o", "s1", "can_open", "alice", "refused");
  });

  test("27: somebody else's session opens for nobody", async () => {
    await can("session_d4o", "s1", "can_open", "dan", false, {
      context: GOOD_DEVICE,
    });
  });

  // --- Contextual tuples, in every shape ---

  test("28: a bare contextual assignment grants", async () => {
    await can("app_d4o", "app_crm", "can_use", "zed", false);
    await can("app_d4o", "app_crm", "can_use", "zed", true, {
      contextualTuples: [
        {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "assigned",
          subjectType: "user_d4o",
          subjectId: "zed",
        },
      ],
    });
  });

  test("29: a contextual userset row grants through the group", async () => {
    await can("app_d4o", "app_hr", "can_use", "bob", false);
    await can("app_d4o", "app_hr", "can_use", "bob", true, {
      contextualTuples: [
        {
          objectType: "app_d4o",
          objectId: "app_hr",
          relation: "assigned",
          subjectType: "group_d4o",
          subjectId: "g_eng",
          subjectRelation: "member",
        },
      ],
    });
  });

  test("30: a conditioned contextual row answers on the request", async () => {
    const tuple: AddTupleRequest = {
      objectType: "app_d4o",
      objectId: "app_hr",
      relation: "assigned",
      subjectType: "user_d4o",
      subjectId: "zed",
      conditionName: "mfa_ok_d4o",
      conditionContext: { required_levels: ["fido"] },
    };
    await can("app_d4o", "app_hr", "can_use", "zed", true, {
      context: FIDO,
      contextualTuples: [tuple],
    });
    await can("app_d4o", "app_hr", "can_use", "zed", false, {
      context: SMS,
      contextualTuples: [tuple],
    });
  });

  test("31: a contextual wildcard on the subtract side denies", async () => {
    await can("app_d4o", "app_crm", "can_use", "alice", false, {
      contextualTuples: [
        {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "deprovisioned",
          subjectType: "user_d4o",
          subjectId: "*",
        },
      ],
    });
  });

  test("32: a contextual row the model does not admit refuses", async () => {
    await can("app_d4o", "app_crm", "can_use", "zed", "refused", {
      contextualTuples: [
        {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "assigned",
          subjectType: "user_d4o",
          subjectId: "*",
        },
      ],
    });
  });

  test("33: an unconditioned contextual row over a conditioned stored one", async () => {
    // frank's stored assignment demands MFA; the request sends an
    // unconditioned row on the same key. Whether that joins the
    // stored row or replaces it, the answer must be the same on
    // both engines — and with no MFA context at all it can only
    // come from the contextual row.
    await can("app_d4o", "app_crm", "can_use", "frank", true, {
      contextualTuples: [
        {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "assigned",
          subjectType: "user_d4o",
          subjectId: "frank",
        },
      ],
    });
  });

  test("34: a conditioned contextual row over an unconditioned stored one", async () => {
    // The mirror image: dan's stored assignment is unconditioned,
    // and the request sends a conditioned row on the same key
    // whose condition is false. If contextual tuples *replace*,
    // this denies; if they join, it grants. Both engines must say
    // the same thing.
    await can("app_d4o", "app_crm", "can_use", "dan", false, {
      context: SMS,
      contextualTuples: [
        {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "assigned",
          subjectType: "user_d4o",
          subjectId: "dan",
          conditionName: "mfa_ok_d4o",
          conditionContext: { required_levels: ["fido"] },
        },
      ],
    });
  });

  test("35: a contextual OU parent extends the admin chain", async () => {
    await can("ou_d4o", "ou_root", "can_administer", "alice", true);
    await can("app_d4o", "app_hr", "can_configure", "alice", true);
    await can("ou_d4o", "ou_eu_sales", "can_administer", "dan", false, {
      contextualTuples: [
        {
          objectType: "ou_d4o",
          objectId: "ou_root",
          relation: "admin",
          subjectType: "group_d4o",
          subjectId: "g_eng",
          subjectRelation: "member",
        },
      ],
    });
    await can("ou_d4o", "ou_eu_sales", "can_administer", "bob", true, {
      contextualTuples: [
        {
          objectType: "ou_d4o",
          objectId: "ou_root",
          relation: "admin",
          subjectType: "group_d4o",
          subjectId: "g_eng",
          subjectRelation: "member",
        },
      ],
    });
  });

  // --- listObjects ---

  test("36: the apps alice may use", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "alice",
      },
      ["app_crm", "app_hr"],
    );
  });

  test("37: the apps carol may use, after her deprovision", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "carol",
      },
      ["app_crm"],
    );
  });

  test("38: the apps bob may use, after his exclusion", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "bob",
      },
      [],
    );
  });

  test("39: the apps frank may use, by factor", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "frank",
        context: FIDO,
      },
      ["app_crm"],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "frank",
        context: SMS,
      },
      [],
    );
  });

  test("40: the OUs dan may reset passwords in", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "ou_d4o",
        relation: "can_reset_password",
        subjectType: "user_d4o",
        subjectId: "dan",
      },
      ["ou_eu", "ou_eu_sales"],
    );
  });

  test("41: a contextual assignment widens the app list", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "zed",
        contextualTuples: [
          {
            objectType: "app_d4o",
            objectId: "app_crm",
            relation: "assigned",
            subjectType: "user_d4o",
            subjectId: "zed",
          },
          {
            objectType: "app_d4o",
            objectId: "app_wiki",
            relation: "assigned",
            subjectType: "user_d4o",
            subjectId: "zed",
          },
        ],
      },
      ["app_crm"],
    );
  });

  // --- listSubjects ---

  test("42: the direct rows on an assignment", async () => {
    const ours = (
      await tsfga.listSubjects("app_d4o", "app_crm", "assigned", {
        context: FIDO,
      })
    )
      .map(renderSubject)
      .sort();
    expect(ours).toEqual([
      "group_d4o:g_all#member",
      "user_d4o:dan",
      "user_d4o:frank",
    ]);
    // Upstream resolves the userset rather than reporting it, so
    // the comparison is a containment over both filters.
    const upstream = new Set([
      ...(
        await fgaListUsers(storeId, authorizationModelId, {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "assigned",
          filters: [{ type: "user_d4o" }],
          context: FIDO,
        })
      ).map(renderSubject),
      ...(
        await fgaListUsers(storeId, authorizationModelId, {
          objectType: "app_d4o",
          objectId: "app_crm",
          relation: "assigned",
          filters: [{ type: "group_d4o", relation: "member" }],
          context: FIDO,
        })
      ).map(renderSubject),
    ]);
    for (const row of ours) expect(upstream.has(row)).toBe(true);
  });

  test("43: a factor the condition rejects drops the conditioned row", async () => {
    const ours = (
      await tsfga.listSubjects("app_d4o", "app_crm", "assigned", {
        context: SMS,
      })
    )
      .map(renderSubject)
      .sort();
    expect(ours).toEqual(["group_d4o:g_all#member", "user_d4o:dan"]);
    const upstream = (
      await fgaListUsers(storeId, authorizationModelId, {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "assigned",
        filters: [{ type: "user_d4o" }],
        context: SMS,
      })
    ).map(renderSubject);
    expect(upstream).not.toContain("user_d4o:frank");
  });

  test("44: the wildcard row on a subtrahend is reported as one", async () => {
    const ours = (
      await tsfga.listSubjects("app_d4o", "app_wiki", "deprovisioned")
    ).map(renderSubject);
    expect(ours).toEqual(["user_d4o:*"]);
    const upstream = (
      await fgaListUsers(storeId, authorizationModelId, {
        objectType: "app_d4o",
        objectId: "app_wiki",
        relation: "deprovisioned",
        filters: [{ type: "user_d4o" }],
      })
    ).map(renderSubject);
    expect(upstream).toEqual(["user_d4o:*"]);
  });

  // --- checkMany over one scope ---

  test("45: a batch mixing subject shapes, contexts and refusals", async () => {
    const items = [
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "alice",
      },
      {
        objectType: "app_d4o",
        objectId: "app_wiki",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "alice",
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "frank",
        context: FIDO,
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "frank",
        context: SMS,
      },
      {
        objectType: "group_d4o",
        objectId: "g_all",
        relation: "member",
        subjectType: "user_d4o",
        subjectId: "bob",
      },
      {
        objectType: "ou_d4o",
        objectId: "ou_eu_sales",
        relation: "can_administer",
        subjectType: "user_d4o",
        subjectId: "carol",
      },
      {
        objectType: "session_d4o",
        objectId: "s1",
        relation: "can_open",
        subjectType: "user_d4o",
        subjectId: "alice",
        context: GOOD_DEVICE,
      },
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "can_audit",
        subjectType: "user_d4o",
        subjectId: "dan",
      },
    ];
    const [ours, theirs] = await Promise.all([
      tsfga.checkMany(items),
      fgaBatchCheck(storeId, authorizationModelId, items),
    ]);
    const mine = ours.map((outcome) =>
      outcome.error === undefined ? outcome.allowed : "refused",
    );
    const upstream = theirs.map((outcome) =>
      "error" in outcome ? "refused" : outcome.allowed,
    );
    expect(mine).toEqual(upstream);
    expect(mine).toEqual([true, false, true, false, false, false, true, true]);
  });

  // --- The write gate ---

  test("46: an assignment may be bare, or carry its own condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "assigned",
        subjectType: "user_d4o",
        subjectId: "zed",
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "assigned",
        subjectType: "user_d4o",
        subjectId: "yara",
        conditionName: "mfa_ok_d4o",
        conditionContext: { required_levels: ["otp"] },
      },
      "accepted",
    );
  });

  test("47: but not one borrowing the other condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "assigned",
        subjectType: "user_d4o",
        subjectId: "yara",
        conditionName: "device_trusted_d4o",
      },
      "refused",
    );
  });

  test("48: a principal must carry the device condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "session_d4o",
        objectId: "s1",
        relation: "principal",
        subjectType: "user_d4o",
        subjectId: "zed",
      },
      "refused",
    );
  });

  test("49: assignment admits no wildcard, deprovision does", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        objectId: "app_hr",
        relation: "assigned",
        subjectType: "user_d4o",
        subjectId: "*",
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "deprovisioned",
        subjectType: "user_d4o",
        subjectId: "*",
      },
      "accepted",
    );
  });

  test("50: an OU admin may name #member, never #direct_member", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "ou_d4o",
        objectId: "ou_eu",
        relation: "admin",
        subjectType: "group_d4o",
        subjectId: "g_eng",
        subjectRelation: "direct_member",
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "ou_d4o",
        objectId: "ou_eu",
        relation: "admin",
        subjectType: "group_d4o",
        subjectId: "g_eng",
        subjectRelation: "member",
      },
      "accepted",
    );
  });

  test("51: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "app_d4o",
        objectId: "app_crm",
        relation: "can_use",
        subjectType: "user_d4o",
        subjectId: "zed",
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "group_d4o",
        objectId: "g_all",
        relation: "member",
        subjectType: "user_d4o",
        subjectId: "zed",
      },
      "refused",
    );
  });

  test("52: the writes just made are visible to a check", async () => {
    await can("app_d4o", "app_hr", "can_use", "zed", true);
    await can("app_d4o", "app_hr", "can_use", "yara", true, {
      context: { mfa_level: "otp" },
    });
    await can("app_d4o", "app_crm", "can_use", "alice", false);
    await can("ou_d4o", "ou_eu", "can_administer", "bob", true);
  });

  // --- Revocation ---

  test("53: revoking the exclusion restores bob everywhere", async () => {
    await revoke({
      objectType: "group_d4o",
      objectId: "g_all",
      relation: "excluded",
      subjectType: "user_d4o",
      subjectId: "bob",
    });
    await can("group_d4o", "g_all", "member", "bob", true);
    await can("ou_d4o", "ou_root", "can_administer", "bob", true);
    await can("app_d4o", "app_hr", "can_use", "bob", true);
  });

  test("54: revoking the nested userset edge cuts alice's group path", async () => {
    await revoke({
      objectType: "group_d4o",
      objectId: "g_all",
      relation: "direct_member",
      subjectType: "group_d4o",
      subjectId: "g_eng",
      subjectRelation: "direct_member",
    });
    await can("group_d4o", "g_all", "member", "alice", false);
    await can("app_d4o", "app_hr", "can_use", "alice", false);
    await can("group_d4o", "g_all", "member", "carol", true);
  });

  test("55: revoking the wildcard deprovision reopens the app", async () => {
    await revoke({
      objectType: "app_d4o",
      objectId: "app_wiki",
      relation: "deprovisioned",
      subjectType: "user_d4o",
      subjectId: "*",
    });
    await can("app_d4o", "app_wiki", "can_use", "carol", true);
  });

  test("56: revoking the TTU parent link cuts the inherited role", async () => {
    await revoke({
      objectType: "ou_d4o",
      objectId: "ou_eu_sales",
      relation: "parent_ou",
      subjectType: "ou_d4o",
      subjectId: "ou_eu",
    });
    await can("ou_d4o", "ou_eu_sales", "can_administer", "carol", false);
    await can("app_d4o", "app_crm", "admin_access", "carol", false);
    await can("ou_d4o", "ou_eu", "can_administer", "carol", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./d4-okta/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
