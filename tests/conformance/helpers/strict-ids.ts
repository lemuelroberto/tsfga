import {
  type CheckTuples,
  type CheckTuplesQuery,
  type ConditionDefinition,
  type GatedRelationConfig,
  type GatedTuple,
  type IdDomain,
  OPAQUE_IDS,
  type RelationConfig,
  type RemoveTupleRequest,
  type Tuple,
  type TupleStore,
} from "@tsfga/core";

/**
 * Exactly 8-4-4-4-12 lower-case hexadecimal digits, hyphenated —
 * the one spelling of a UUID that a `uuid` column stores back
 * unchanged.
 *
 * Nothing about the version or the variant digits is checked. The
 * conformance corpus assigns its own prefixes and most of them are
 * not RFC 4122 variants; a validator that checked them would refuse
 * the fixtures it exists to police.
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Raised when an id reaches the store that a `uuid` column could
 * not hold.
 *
 * Deliberately **not** a `TsfgaError`: `expectConformance` reads a
 * `TsfgaError` as the outcome "refused", which is a thing a test
 * may legitimately expect. A residual slug is not an outcome, it
 * is a defect in the test file, and it must be impossible to
 * satisfy an expectation with it.
 */
export class IdResidueError extends Error {
  constructor(position: string, id: string) {
    super(
      `strictIdStore: ${position} id ${JSON.stringify(id)} is not a ` +
        `canonical lower-case hyphenated UUID. A conformance file ` +
        `under this wrapper has a slug left in an id position.`,
    );
    this.name = "IdResidueError";
  }
}

function requireUuid(position: string, id: string): void {
  if (!CANONICAL_UUID.test(id)) {
    throw new IdResidueError(position, id);
  }
}

/** The typed wildcard is a subject shape, not an id. */
function requireSubject(id: string): void {
  if (id === "*") return;
  requireUuid("subject", id);
}

/**
 * A store that refuses any id a `uuid` column could not hold.
 *
 * This is the residue detector for the conformance id rewrite, and
 * it is the only *total* one. A slug missed at a check call site
 * leaves both engines looking up an object that exists in neither,
 * both answer `false`, `expectConformance` asserts agreement, and
 * the test passes while asserting nothing. Under this wrapper the
 * same slug raises before the read, in the commit that created it.
 *
 * A text search cannot replace it: an id produced by a generator
 * function is quoted nowhere, and an id the discovery never found
 * is in no list to search for.
 *
 * An explicit forwarding class rather than a `Proxy` or a spread —
 * a spread loses the prototype methods, and every signature stays
 * visible here.
 */
class StrictIdStore implements TupleStore {
  /**
   * Opaque, deliberately — **not** `CANONICAL_UUID_IDS`.
   *
   * Declaring the narrow domain would move the refusal into core,
   * where it becomes a `TsfgaError` and therefore the outcome
   * "refused", which a conformance assertion is allowed to expect.
   * A residual slug is not an outcome; it is a defect in the test
   * file, and it must be impossible to satisfy an expectation
   * with. So the domain stays opaque, core's gate passes the id
   * through, and `IdResidueError` — which is not a `TsfgaError` —
   * is what the file gets.
   */
  readonly idDomain: IdDomain = OPAQUE_IDS;

  constructor(private readonly inner: TupleStore) {}

  findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    requireUuid("object", query.objectId);
    requireSubject(query.subjectId);
    return this.inner.findCheckTuples(query);
  }

  findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    requireUuid("object", objectId);
    return this.inner.findTuplesByRelation(objectType, objectId, relation);
  }

  findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    return this.inner.findRelationConfig(objectType, relation);
  }

  findConditionDefinition(name: string): Promise<ConditionDefinition | null> {
    return this.inner.findConditionDefinition(name);
  }

  hasTypeDefinition(type: string): Promise<boolean> {
    return this.inner.hasTypeDefinition(type);
  }

  insertTuple(tuple: GatedTuple): Promise<boolean> {
    requireUuid("object", tuple.objectId);
    requireSubject(tuple.subjectId);
    return this.inner.insertTuple(tuple);
  }

  deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    requireUuid("object", tuple.objectId);
    requireSubject(tuple.subjectId);
    return this.inner.deleteTuple(tuple);
  }

  listCandidateObjectIds(objectType: string): Promise<string[]> {
    return this.inner.listCandidateObjectIds(objectType);
  }

  upsertRelationConfig(config: GatedRelationConfig): Promise<void> {
    return this.inner.upsertRelationConfig(config);
  }

  deleteRelationConfig(objectType: string, relation: string): Promise<boolean> {
    return this.inner.deleteRelationConfig(objectType, relation);
  }

  upsertConditionDefinition(condition: ConditionDefinition): Promise<void> {
    return this.inner.upsertConditionDefinition(condition);
  }

  deleteConditionDefinition(name: string): Promise<boolean> {
    return this.inner.deleteConditionDefinition(name);
  }
}

export function strictIdStore(inner: TupleStore): TupleStore {
  return new StrictIdStore(inner);
}
