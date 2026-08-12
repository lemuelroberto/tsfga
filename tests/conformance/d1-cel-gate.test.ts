import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import {
  type ConditionParameterType,
  createTsfga,
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
 * The other side of round 3's declaration gate and type check
 * (issues 381 / 388): expressions **upstream accepts**.
 *
 * A gate written to refuse what cel-go never declared is only
 * correct if cel-js's checker agrees with cel-go's about the
 * declarations they *share*. Where it is stricter, a model OpenFGA
 * stores cannot be written here at all — which is an outage, and
 * one no amount of check-path testing would find, because the
 * write never lands.
 *
 * Same shape as `c5-cel-typecheck.test.ts`, run the other way
 * round: upstream must accept, and tsfga must too.
 */

const DSL_TYPE_NAMES: Readonly<Record<string, string>> = {
  string: "string",
  int: "int",
  uint: "uint",
  bool: "bool",
  double: "double",
  duration: "duration",
  timestamp: "timestamp",
  "list<string>": "list<string>",
  "list<int>": "list<int>",
  "map<int>": "map<int>",
  "map<string>": "map<string>",
};

function modelWith(
  name: string,
  parameters: Record<string, ConditionParameterType>,
  expression: string,
): WriteAuthorizationModelRequest {
  const declared = Object.entries(parameters)
    .map(([key, type]) => {
      const spelled = DSL_TYPE_NAMES[type];
      if (spelled === undefined) throw new Error(`no DSL spelling for ${type}`);
      return `${key}: ${spelled}`;
    })
    .join(", ");
  const dsl = `model
  schema 1.1

type user_d1

type doc_d1
  relations
    define ${name}: [user_d1 with ${name}_c]

condition ${name}_c(${declared}) {
  ${expression}
}
`;
  return transformer.transformDSLToJSONObject(dsl);
}

interface Cell {
  readonly name: string;
  readonly parameters: Record<string, ConditionParameterType>;
  readonly expression: string;
}

/**
 * Expressions a real model carries. Macros, comprehensions, `dyn`,
 * and one use of every parameter type tsfga declares.
 */
const LEGITIMATE: readonly Cell[] = [
  { name: "g01", parameters: { s: "string" }, expression: "s.size() > 0" },
  {
    name: "g02",
    parameters: { l: "list<string>" },
    expression: "l.exists(x, x == 'a')",
  },
  {
    name: "g03",
    parameters: { l: "list<int>" },
    expression: "l.all(x, x > 0)",
  },
  {
    name: "g04",
    parameters: { l: "list<int>" },
    expression: "l.filter(x, x > 1).size() > 0",
  },
  {
    name: "g05",
    parameters: { l: "list<int>" },
    expression: "l.map(x, x + 1).exists(y, y > 2)",
  },
  {
    name: "g06",
    parameters: { l: "list<int>" },
    expression: "l.all(x, l.exists(y, y >= x))",
  },
  {
    name: "g07",
    parameters: { m: "map<int>" },
    expression: "m.all(k, m[k] > 0)",
  },
  { name: "g08", parameters: { m: "map<int>" }, expression: "has(m.a)" },
  {
    name: "g09",
    parameters: { a: "string", b: "string" },
    expression: "dyn(a) == dyn(b)",
  },
  { name: "g10", parameters: { u: "uint" }, expression: "u > 0u" },
  { name: "g11", parameters: { d: "double" }, expression: "d > 1.5" },
  { name: "g12", parameters: { b: "bool" }, expression: "b && !b" },
  {
    name: "g13",
    parameters: { t: "timestamp" },
    expression: "t.getDayOfWeek('UTC') > 1",
  },
  {
    name: "g14",
    parameters: { du: "duration" },
    expression: "du.getSeconds() > 1",
  },
  {
    name: "g15",
    parameters: { t: "timestamp", du: "duration" },
    expression: "t + du > t",
  },
  {
    name: "g16",
    parameters: { t1: "timestamp", t2: "timestamp" },
    expression: "t2 - t1 > duration('1h')",
  },
  {
    name: "g17",
    parameters: { s: "string", l: "list<string>" },
    expression: "!(s in l)",
  },
  {
    name: "g18",
    parameters: { i: "int" },
    expression: "timestamp(i) > timestamp(0)",
  },
  {
    name: "g19",
    parameters: { s: "string" },
    expression: "bytes(s).size() > 0",
  },
  { name: "g20", parameters: { s: "string" }, expression: "type(s) == string" },
];

/**
 * Where cel-js's checker is stricter than cel-go's on a
 * declaration both environments have.
 */
const SUSPECTED: readonly Cell[] = [
  {
    name: "h01",
    parameters: { i: "int" },
    expression: "duration(i) > duration('1s')",
  },
  { name: "h02", parameters: { s: "string" }, expression: "s != null" },
  { name: "h03", parameters: { s: "string" }, expression: "s == null" },
];

describe("CEL write gate: over-refusal sweep", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("d1-cel-gate");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function tsfgaWrite(cell: Cell): Promise<"accepted" | "refused"> {
    try {
      await tsfgaClient.writeConditionDefinition({
        name: `${cell.name}_c`,
        expression: cell.expression,
        parameters: cell.parameters,
      });
      return "accepted";
    } catch (error) {
      if (error instanceof TsfgaError) return "refused";
      throw error;
    }
  }

  async function upstreamWrite(cell: Cell): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(
      storeId,
      modelWith(cell.name, cell.parameters, cell.expression),
    );
    return outcome === "accepted" ? "accepted" : "refused";
  }

  describe("expressions upstream stores are still writable here", () => {
    for (const cell of LEGITIMATE) {
      test(`${cell.expression}`, async () => {
        const [tsfga, upstream] = await Promise.all([
          tsfgaWrite(cell),
          upstreamWrite(cell),
        ]);
        expect(upstream).toBe("accepted");
        expect(tsfga).toBe(upstream);
      });
    }
  });

  describe("cells where cel-js may be stricter than cel-go", () => {
    for (const cell of SUSPECTED) {
      test(`${cell.expression}`, async () => {
        const [tsfga, upstream] = await Promise.all([
          tsfgaWrite(cell),
          upstreamWrite(cell),
        ]);
        expect(tsfga).toBe(upstream);
      });
    }
  });
});
