/**
 * Runtime-agnostic smoke test for @tsfga/core.
 *
 * Validates that the built package can be imported and used from
 * Node.js and Deno (ESM resolution via package.json exports).
 *
 * Run after `bun run build`:
 *   node tests/smoke/smoke-test.mjs
 *   deno run --allow-all tests/smoke/smoke-test.mjs
 */

import { createTsfga, check } from "../../packages/core/dist/index.js";

// Verify exports are functions
assert(typeof createTsfga === "function", "createTsfga should be a function");
assert(typeof check === "function", "check should be a function");

// Minimal mock store (only methods used by a simple direct-tuple check)
const mockStore = {
  findDirectTuple: async (_objectType, _objectId, _relation, _subjectType, _subjectId) => ({
    objectType: "doc",
    objectId: "1",
    relation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
  }),
  findUsersetTuples: async () => [],
  findTuplesByRelation: async () => [],
  findRelationConfig: async () => null,
  findConditionDefinition: async () => null,
  insertTuple: async () => {},
  deleteTuple: async () => false,
  listCandidateObjectIds: async () => [],
  listDirectSubjects: async () => [],
  upsertRelationConfig: async () => {},
  deleteRelationConfig: async () => false,
  upsertConditionDefinition: async () => {},
  deleteConditionDefinition: async () => false,
};

const client = createTsfga(mockStore);

// Direct tuple match — should return true
const allowed = await client.check({
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "alice",
});
assert(allowed === true, `expected true, got ${allowed}`);

// No matching tuple — should return false
const notAllowedStore = {
  ...mockStore,
  findDirectTuple: async () => null,
};
const notAllowedClient = createTsfga(notAllowedStore);
const denied = await notAllowedClient.check({
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "bob",
});
assert(denied === false, `expected false, got ${denied}`);

console.log("smoke test passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
