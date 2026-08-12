import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import {
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModelOutcome } from "./helpers/openfga.ts";

/**
 * tsfga's config write gate versus OpenFGA's model validation.
 *
 * `writeRelationConfig` is the only place tsfga can refuse a shape
 * OpenFGA's typesystem refuses: there is no model document, so a
 * defect that upstream catches once, atomically, has to be caught
 * per config or not at all. Where it is not caught, tsfga answers
 * `false` for a model upstream will not even store — a silent
 * disagreement, because nothing on the check path ever says the
 * model was never valid.
 *
 * Each shape below is written to OpenFGA as JSON (the DSL cannot
 * express most of them — the transformer refuses first) and to
 * tsfga as the equivalent `RelationConfig`s. Parity means both
 * refuse.
 *
 * The two write-order gaps `config-validation.ts` documents are
 * deliberately avoided: every config here is written in an order
 * where the premise it would be validated against already exists.
 */

const USER: WriteAuthorizationModelRequest["type_definitions"][number] = {
  type: "user_a7g",
  relations: {},
  metadata: { relations: {} },
};

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

describe("Model-shape write gate conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("a7-model-gate");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /** Whether OpenFGA stores the model. */
  async function openfga(
    model: WriteAuthorizationModelRequest,
  ): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(storeId, model);
    return outcome === "accepted" ? "accepted" : "refused";
  }

  /**
   * Whether tsfga stores every config of the equivalent model.
   *
   * Written in order, so a config whose validation depends on
   * another is written second — the write-order gap is not what
   * this file is about.
   */
  async function tsfga(
    configs: readonly RelationConfig[],
  ): Promise<"accepted" | "refused"> {
    for (const relationConfig of configs) {
      try {
        await tsfgaClient.writeRelationConfig(relationConfig);
      } catch (error) {
        if (error instanceof TsfgaError) return "refused";
        throw error;
      }
    }
    return "accepted";
  }

  test("control: a valid intersection model is stored by both", async () => {
    const type = "doc_a7g0";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              a: { this: {} },
              b: { this: {} },
              viewer: {
                intersection: {
                  child: [
                    { computedUserset: { relation: "a" } },
                    { computedUserset: { relation: "b" } },
                  ],
                },
              },
            },
            metadata: {
              relations: {
                a: { directly_related_user_types: [{ type: "user_a7g" }] },
                b: { directly_related_user_types: [{ type: "user_a7g" }] },
                viewer: { directly_related_user_types: [] },
              },
            },
          },
        ],
      }),
    ).toBe("accepted");
    expect(
      await tsfga([
        config(type, "a", { directlyAssignable: [{ type: "user_a7g" }] }),
        config(type, "b", { directlyAssignable: [{ type: "user_a7g" }] }),
        config(type, "viewer", {
          intersection: [
            { type: "computedUserset", relation: "a" },
            { type: "computedUserset", relation: "b" },
          ],
        }),
      ]),
    ).toBe("accepted");
  });

  test("GAP-150: a computed tupleset relation is refused", async () => {
    const type = "doc_a7g1";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type: "folder_a7g1",
            relations: { viewer: { this: {} } },
            metadata: {
              relations: {
                viewer: { directly_related_user_types: [{ type: "user_a7g" }] },
              },
            },
          },
          {
            type,
            relations: {
              parent: { this: {} },
              alias: { computedUserset: { relation: "parent" } },
              viewer: {
                tupleToUserset: {
                  tupleset: { relation: "alias" },
                  computedUserset: { relation: "viewer" },
                },
              },
            },
            metadata: {
              relations: {
                parent: {
                  directly_related_user_types: [{ type: "folder_a7g1" }],
                },
                alias: { directly_related_user_types: [] },
                viewer: { directly_related_user_types: [] },
              },
            },
          },
        ],
      }),
    ).toBe("refused");
    // tsfga's `resolveTupleset` reads the tupleset relation by
    // tuples alone, so a computed one always finds nothing and the
    // relation silently answers `false` for every subject.
    expect(
      await tsfga([
        config("folder_a7g1", "viewer", {
          directlyAssignable: [{ type: "user_a7g" }],
        }),
        config(type, "parent", {
          directlyAssignable: [{ type: "folder_a7g1" }],
        }),
        config(type, "alias", { computedUserset: "parent" }),
        config(type, "viewer", {
          tupleToUserset: [{ tupleset: "alias", computedUserset: "viewer" }],
        }),
      ]),
    ).toBe("refused");
  });

  test("GAP-151: type restrictions on a non-assignable relation are refused", async () => {
    const type = "doc_a7g2";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              a: { this: {} },
              b: { this: {} },
              viewer: {
                intersection: {
                  child: [
                    { computedUserset: { relation: "a" } },
                    { computedUserset: { relation: "b" } },
                  ],
                },
              },
            },
            metadata: {
              relations: {
                a: { directly_related_user_types: [{ type: "user_a7g" }] },
                b: { directly_related_user_types: [{ type: "user_a7g" }] },
                // The relation admits no direct assignment, so
                // restrictions on it describe nothing.
                viewer: {
                  directly_related_user_types: [{ type: "user_a7g" }],
                },
              },
            },
          },
        ],
      }),
    ).toBe("refused");
    expect(
      await tsfga([
        config(type, "a", { directlyAssignable: [{ type: "user_a7g" }] }),
        config(type, "b", { directlyAssignable: [{ type: "user_a7g" }] }),
        config(type, "viewer", {
          directlyAssignable: [{ type: "user_a7g" }],
          intersection: [
            { type: "computedUserset", relation: "a" },
            { type: "computedUserset", relation: "b" },
          ],
        }),
      ]),
    ).toBe("refused");
  });

  test("GAP-152: an assignable relation with no type restrictions is refused", async () => {
    const type = "doc_a7g3";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: { viewer: { this: {} } },
            metadata: {
              relations: { viewer: { directly_related_user_types: [] } },
            },
          },
        ],
      }),
    ).toBe("refused");
    // A config with an empty `directlyAssignable` and no rewrite of
    // any kind is exactly that relation: it can never grant, and
    // there is no shape of model it can have come from.
    expect(await tsfga([config(type, "viewer")])).toBe("refused");
  });

  test("GAP-153: a relation with no entrypoint is refused", async () => {
    const type = "doc_a7g4";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              parent: { this: {} },
              viewer: {
                tupleToUserset: {
                  tupleset: { relation: "parent" },
                  computedUserset: { relation: "viewer" },
                },
              },
            },
            metadata: {
              relations: {
                parent: { directly_related_user_types: [{ type }] },
                viewer: { directly_related_user_types: [] },
              },
            },
          },
        ],
      }),
    ).toBe("refused");
    expect(
      await tsfga([
        config(type, "parent", { directlyAssignable: [{ type }] }),
        config(type, "viewer", {
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
      ]),
    ).toBe("refused");
  });

  test("GAP-154: a TTU whose computed relation no tupleset type defines is refused", async () => {
    const type = "doc_a7g5";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type: "folder_a7g5",
            relations: { owner: { this: {} } },
            metadata: {
              relations: {
                owner: { directly_related_user_types: [{ type: "user_a7g" }] },
              },
            },
          },
          {
            type,
            relations: {
              parent: { this: {} },
              viewer: {
                tupleToUserset: {
                  tupleset: { relation: "parent" },
                  computedUserset: { relation: "viewer" },
                },
              },
            },
            metadata: {
              relations: {
                parent: {
                  directly_related_user_types: [{ type: "folder_a7g5" }],
                },
                viewer: { directly_related_user_types: [] },
              },
            },
          },
        ],
      }),
    ).toBe("refused");
    // `resolveTupleset` skips a row whose type does not define the
    // computed relation — correct per-row behaviour for a model
    // where *some* type defines it, but here no type does, and
    // upstream refuses the model outright rather than answering.
    expect(
      await tsfga([
        config("folder_a7g5", "owner", {
          directlyAssignable: [{ type: "user_a7g" }],
        }),
        config(type, "parent", {
          directlyAssignable: [{ type: "folder_a7g5" }],
        }),
        config(type, "viewer", {
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
      ]),
    ).toBe("refused");
  });

  test("GAP-155: a rewrite naming an undefined relation is refused", async () => {
    const type = "doc_a7g6";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              a: { this: {} },
              viewer: {
                difference: {
                  base: { computedUserset: { relation: "a" } },
                  subtract: { computedUserset: { relation: "nope_a7g" } },
                },
              },
            },
            metadata: {
              relations: {
                a: { directly_related_user_types: [{ type: "user_a7g" }] },
                viewer: { directly_related_user_types: [] },
              },
            },
          },
        ],
      }),
    ).toBe("refused");
    expect(
      await tsfga([
        config(type, "a", { directlyAssignable: [{ type: "user_a7g" }] }),
        config(type, "viewer", { impliedBy: ["a"], excludedBy: "nope_a7g" }),
      ]),
    ).toBe("refused");
  });
});
