import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type ConditionParameterType,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
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
 * What CEL does with a value once it has been read — arithmetic,
 * conversion and comparison — as opposed to how the value was read
 * out of the context, which `condition-grammar` covers.
 *
 * `packages/core/README.md` states that every integer cell agrees
 * apart from the two `uint` representation rows, "including the
 * arithmetic operators, exact comparison past 2^53, saturation at
 * the int64 bounds, and overflow past them". The cells below are
 * the ones where it does not hold. They fall in three families:
 *
 * - **overflow that upstream detects and cel-js does not** —
 *   unary negation of int64's minimum, `int64min / -1`,
 *   `int(1e19)`, `double('1e400')`, and duration addition and
 *   subtraction past the int64 nanosecond range. Every one of them
 *   is the granting direction: OpenFGA declines to answer and
 *   tsfga returns a boolean. The binary `+`, `-` and `*` operators
 *   *are* checked by cel-js, which is why they appear here as
 *   controls rather than as gaps.
 * - **overflow cel-js detects and upstream does not** — a `uint`
 *   parameter is carried as CEL's `int`, so its arithmetic is
 *   bounded by int64 rather than uint64 and a product upstream
 *   computes happily is an error here.
 * - **`string()` and `<` on non-numeric types** — cel-js has no
 *   `string(duration)` or `string(timestamp)` overload, and it
 *   orders strings by UTF-16 code unit where Go orders the UTF-8
 *   bytes, so the two disagree on any comparison that crosses
 *   U+FFFF.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d410-000000000011"],
  ["doc", "00000000-0000-4000-d410-000000000012"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** One row per relation in `a2-cel-numeric/model.dsl`. */
const CELLS: ReadonlyArray<
  readonly [string, Record<string, ConditionParameterType>, string]
> = [
  ["neg_min_a2", { n: "int" }, "-n > 0"],
  ["div_min_a2", { n: "int" }, "n / -1 > 0"],
  ["int_of_dbl_a2", { x: "double" }, "int(x) > 0"],
  ["int_of_dbl_neg_a2", { x: "double" }, "int(x) < 0"],
  ["dbl_of_str_a2", { s: "string" }, "double(s) > 0.0"],
  ["dur_plus_a2", { d: "duration" }, "d + duration('2400000h') > d"],
  ["dur_minus_a2", { d: "duration" }, "duration('-2400000h') - d < d"],
  ["uint_add_a2", { n: "uint" }, "n + 1u > 0u"],
  ["uint_mul_a2", { n: "uint" }, "n * n > 0u"],
  ["str_of_dur_a2", { d: "duration" }, "string(d) == '3600s'"],
  ["str_of_ts_a2", { t: "timestamp" }, "string(t) == '2026-01-02T00:00:00Z'"],
  ["str_order_a2", { s: "string" }, "s < '�'"],
  ["int_add_a2", { n: "int" }, "n + 9223372036854775807 > 0"],
  ["int_mul_a2", { n: "int" }, "n * n > 0"],
  ["uint_sub_a2", { n: "uint" }, "n - 5u == 0u"],
  ["str_order_ascii_a2", { s: "string" }, "s < 'b'"],
  ["str_of_dbl_a2", { x: "double" }, "string(x) == '1.5'"],
  ["ts_plus_a2", { t: "timestamp" }, "t + duration('2400000h') > t"],
];

const INT64_MIN = "-9223372036854775808";
const UINT64_MAX = "18446744073709551615";

describe("CEL arithmetic and conversion conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    for (const [relation, parameters, expression] of CELLS) {
      await tsfgaClient.writeConditionDefinition({
        name: `${relation}_c`,
        expression,
        parameters,
      });
      await tsfgaClient.writeRelationConfig({
        objectType: "doc_a2",
        relation,
        directlyAssignable: [{ type: "user_a2", condition: `${relation}_c` }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc_a2",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_a2",
        subjectId: uuid("alice"),
        conditionName: `${relation}_c`,
      });
    }

    storeId = await fgaCreateStore("a2-cel-numeric");
    modelId = await fgaWriteModel(storeId, "./a2-cel-numeric/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CELLS.map(([relation]) => ({
        user: `user_a2:${uuid("alice")}`,
        relation,
        object: `doc_a2:${uuid("doc")}`,
        condition: { name: `${relation}_c` },
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const check = (
    relation: string,
    context: Record<string, unknown>,
    expected: CheckOutcome,
  ) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_a2",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_a2",
        subjectId: uuid("alice"),
        context,
      },
      expected,
    );

  describe("GAP-023: overflow upstream detects and cel-js does not", () => {
    test("GAP-023: negating int64's minimum", async () => {
      await check("neg_min_a2", { n: INT64_MIN }, "refused");
    });

    test("GAP-023: dividing int64's minimum by -1", async () => {
      await check("div_min_a2", { n: INT64_MIN }, "refused");
    });

    test("GAP-023: int() of a double past int64", async () => {
      await check("int_of_dbl_a2", { x: 1e19 }, "refused");
    });

    test("GAP-023: int() of a double past int64's floor", async () => {
      await check("int_of_dbl_neg_a2", { x: -1e19 }, "refused");
    });

    test("GAP-023: double() of a string past float64", async () => {
      await check("dbl_of_str_a2", { s: "1e400" }, "refused");
    });

    test("GAP-023: duration addition past the int64 nanoseconds", async () => {
      await check("dur_plus_a2", { d: "2400000h" }, "refused");
    });

    test("GAP-023: duration subtraction past it", async () => {
      await check("dur_minus_a2", { d: "2400000h" }, "refused");
    });
  });

  describe("GAP-024: uint arithmetic is bounded by int64", () => {
    test("GAP-024: a uint sum past int64 but inside uint64", async () => {
      await check("uint_add_a2", { n: UINT64_MAX }, true);
    });

    test("GAP-024: a uint product past int64 but inside uint64", async () => {
      await check("uint_mul_a2", { n: 4000000000 }, true);
    });
  });

  describe("GAP-021: string() of a duration or a timestamp", () => {
    test("GAP-021: string(duration)", async () => {
      await check("str_of_dur_a2", { d: "1h" }, true);
    });

    test("GAP-021: string(timestamp)", async () => {
      await check("str_of_ts_a2", { t: "2026-01-02T00:00:00Z" }, true);
    });
  });

  describe("GAP-022: string ordering past U+FFFF", () => {
    test("GAP-022: an astral character sorts after U+FFFD", async () => {
      // Go compares the UTF-8 bytes, so U+1F600 (`F0 9F 98 80`)
      // sorts after U+FFFD (`EF BF BD`). JavaScript compares UTF-16
      // code units, and the high surrogate `D83D` sorts before
      // `FFFD`, so the two engines answer opposite booleans with no
      // error on either side.
      await check("str_order_a2", { s: "\u{1F600}" }, false);
    });
  });

  /**
   * Controls. Each gap family also has a neighbouring cell that
   * must still agree, so a fix that made every one of these
   * expressions refuse would not pass.
   */
  describe("what already agrees still agrees", () => {
    test("an int sum past int64 is refused by both", async () => {
      await check("int_add_a2", { n: 1 }, "refused");
    });

    test("an int product past int64 is refused by both", async () => {
      await check("int_mul_a2", { n: 4000000000 }, "refused");
    });

    test("a uint difference below zero is refused by both", async () => {
      await check("uint_sub_a2", { n: 1 }, "refused");
    });

    test("ASCII string ordering agrees", async () => {
      await check("str_order_ascii_a2", { s: "a" }, true);
    });

    test("string() of a double agrees", async () => {
      await check("str_of_dbl_a2", { x: 1.5 }, true);
    });

    test("a timestamp past year 9999 saturates the same way", async () => {
      await check("ts_plus_a2", { t: "2026-01-01T00:00:00Z" }, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./a2-cel-numeric/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
