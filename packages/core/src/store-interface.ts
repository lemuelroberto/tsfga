import type {
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "./types.ts";
import type { GatedRelationConfig, GatedTuple } from "./write-gate.ts";

export interface TupleStore {
  // === Read ===

  /**
   * Read the tuples one check node needs: the subject's direct
   * tuple, the `subjectType:*` wildcard tuple, and the usersets
   * assigned to the relation.
   *
   * These three are asked for together because a check issues
   * them together, at every node it visits — serving them in one
   * round-trip is the single largest thing an adapter can do for
   * check latency. An implementation is free to run three queries
   * instead; it just gives that up.
   *
   * The three ref sets are there so a store can **narrow** its
   * query — that is where the saving is. They are not a contract
   * you can breach dangerously: the check algorithm re-clamps
   * every reply against the query it sent, so returning a part
   * that was not asked for, or filing a row under the wrong slot,
   * loses that row. It cannot widen what the model admits.
   *
   * **`null` and `[]` are opposites, and this is the one place an
   * adapter can get it catastrophically wrong.** `null` is
   * *unrestricted* — return every row of that shape. `[]` is
   * *excluded* — return none. A store that treats a missing or
   * empty list as "no filter" answers a query that asked for
   * nothing with everything, and while the clamp then drops those
   * rows, the store has done unbounded work to produce them.
   *
   * Matching a ref means matching all four of its fields — type,
   * userset relation, wildcard, **and condition**. A row whose
   * `condition_name` is not among those the ref set names is not a
   * row this relation admits, exactly as a wrong type is not.
   *
   * Slots are exact. `direct` is the tuple for this subject with
   * no subject relation; `wildcard` holds the rows for
   * `subjectType:*`, likewise with no subject relation; every row
   * in `usersets` has a subject relation. Anything else is
   * discarded.
   *
   * **`direct` is one row and `wildcard` is a list**, and the
   * asymmetry is upstream's rather than a convenience.
   * `CombinedTupleReader` overrides a stored row with a contextual
   * one only in `ReadUserTuple`, the exact-subject lookup;
   * everything else is a scan, and `Read` concatenates the
   * contextual rows with the stored ones with no dedup at all
   * (`pkg/storage/storagewrappers/combinedtuplereader.go:63-103`).
   * A store holding one row per natural key returns at most one
   * wildcard row and simply wraps it; the list exists because the
   * contextual overlay adds to it.
   */
  findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples>;

  /** Find tuples by object + relation (for tuple-to-userset tupleset lookup) */
  findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]>;

  /** Get relation config for an object_type + relation */
  findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null>;

  /** Get a condition definition by name */
  findConditionDefinition(name: string): Promise<ConditionDefinition | null>;

  /**
   * Whether the model defines this type at all.
   *
   * A type is defined when some relation config names it as its
   * `objectType`, **or** when some config's `directlyAssignable`
   * names it as a `TypeRestriction` type. The second half is not an
   * optimisation: a type with no relations of its own — upstream's
   * `type user` — has no relation config anywhere, and is defined
   * only by the restrictions that admit it. Answering the first
   * half alone refuses every check whose subject is such a type,
   * which is most of them.
   *
   * Asked once per check, before any of it is resolved: a subject
   * naming a type the model does not define is refused rather than
   * answered `false`, which is upstream's `ValidateUser`
   * (`internal/validation/validation.go:362`). The scope's caching
   * store memoises it per type, so a `listObjects` or `checkMany`
   * call pays for one type once.
   *
   * Deliberately narrow. `listDefinedTypes()` is the shape a
   * whole-model validator will want and it puts a table scan on the
   * check path; this answers the only question the check path asks,
   * and the broad read can be added beside it when there is a
   * caller for it.
   *
   * The two wrong answers are not symmetric. `true` for an
   * undefined type loses one refusal; `false` for a defined type
   * refuses checks the model admits, across the board. A store that
   * cannot decide should answer `true`.
   */
  hasTypeDefinition(type: string): Promise<boolean>;

  // === Write ===

  /**
   * Insert a tuple, reporting whether it was new.
   *
   * `true` when a row was inserted; `false` when the natural key
   * already exists, in which case **nothing may be written** — the
   * stored row keeps the condition and the context it already had.
   * `addTuple` turns `false` into a `DuplicateTupleError`, matching
   * upstream's `on_duplicate: "error"` default
   * (`pkg/server/commands/write.go:58-67`).
   *
   * The natural key is upstream's `TupleKeyWithoutCondition`:
   * object type, object id, relation, subject type, subject id and
   * subject relation, where an absent subject relation is one key
   * value rather than an unknown. **The condition is not part of
   * it.** Do not add it: two rows for one edge is a state upstream
   * cannot represent and the check path would read as a union, and
   * the way to change a grant's condition is to delete the row and
   * write it again.
   *
   * This was an upsert until the semantics were narrowed. A store
   * that can only upsert cannot implement the upstream default:
   * rewriting a live grant silently replaced its condition, in the
   * widening direction as readily as the narrowing one, and
   * reported nothing.
   */
  insertTuple(tuple: GatedTuple): Promise<boolean>;

  /** Delete a tuple by natural key */
  deleteTuple(tuple: RemoveTupleRequest): Promise<boolean>;

  // === Query ===

  /**
   * List candidate object IDs for `listObjects` (pre-filter, check
   * still required).
   *
   * Deliberately ungated, unlike `listSubjects`. Every candidate is
   * re-checked through the gated path before `listObjects` returns
   * it, so over-returning here costs work and cannot grant —
   * whereas under-returning would silently drop objects the subject
   * really can reach.
   */
  listCandidateObjectIds(objectType: string): Promise<string[]>;

  // === Config management ===

  /** Insert or update a relation config */
  upsertRelationConfig(config: GatedRelationConfig): Promise<void>;

  /** Delete a relation config */
  deleteRelationConfig(objectType: string, relation: string): Promise<boolean>;

  /** Insert or update a condition definition */
  upsertConditionDefinition(condition: ConditionDefinition): Promise<void>;

  /** Delete a condition definition */
  deleteConditionDefinition(name: string): Promise<boolean>;
}
