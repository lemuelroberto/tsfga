import type { SubjectShape } from "./tuple-validation.ts";
import type { TypeRestriction } from "./types.ts";

export class TsfgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsfgaError";
  }
}

export class RelationConfigNotFoundError extends TsfgaError {
  constructor(objectType: string, relation: string) {
    super(`No relation config found for ${objectType}.${relation}`);
    this.name = "RelationConfigNotFoundError";
  }
}

/**
 * A type restriction in OpenFGA's own notation — `user`,
 * `user:*`, `team#member`, `user with weekday_only`.
 *
 * Only for messages. Everything that decides anything matches the
 * structured fields; rendering to a string is the last step, so
 * nothing is ever re-parsed out of one.
 */
export function formatRestriction(restriction: TypeRestriction): string {
  const base = restriction.wildcard
    ? `${restriction.type}:*`
    : restriction.relation !== undefined
      ? `${restriction.type}#${restriction.relation}`
      : restriction.type;
  return restriction.condition === undefined
    ? base
    : `${base} with ${restriction.condition}`;
}

/**
 * Every way a subject ref can be refused before its condition is
 * ever considered.
 *
 * `undefined` — no cause at all — is the ordinary case: the type is
 * well-formed and defined, and simply not among the ones the
 * relation admits. The named causes are the two refusals upstream
 * reports on the `user` field ahead of any type restriction, in
 * `ValidateUser` (`internal/validation/validation.go:357-380`).
 *
 * They are causes on `InvalidSubjectTypeError` rather than classes
 * of their own, and rather than `ConditionalTupleCause` values,
 * because both are decided without reading the condition.
 */
export type SubjectDefect =
  /**
   * The ref is not well-formed at all — `team:*#member`, a wildcard
   * id carrying a subject relation — which upstream refuses in
   * `IsValidUser` before the type is looked up at all
   * (`pkg/tuple/tuple.go:477-517`).
   */
  | "malformed subject"
  /**
   * The ref is well-formed, but its type is not one the model
   * defines. Upstream's `TypeNotFoundError` on the `user` field,
   * raised immediately after the well-formedness check and before
   * any type restriction is consulted.
   *
   * Distinct from the ordinary no-cause refusal, which is about a
   * type the model *does* define and this relation does not admit.
   */
  | "undefined subject type";

/**
 * The subject's *type* is not assignable here, whatever condition
 * it might carry.
 *
 * Deliberately condition-blind, and raised before the condition is
 * considered at all. The condition dimension has its own error —
 * see `InvalidConditionalTupleError` — because reporting it here
 * would render as `Subject type 'user with weekday_only' is not
 * allowed`, naming a type that does not exist.
 */
export class InvalidSubjectTypeError extends TsfgaError {
  /**
   * Why the subject was refused, when the reason is not simply
   * "the relation does not admit this type".
   *
   * `undefined` is the ordinary case, so every refusal that names
   * no cause keeps its original message. See `SubjectDefect` for
   * the named ones.
   */
  override readonly cause?: SubjectDefect;
  /** The subject ref the write named. */
  readonly subject: SubjectShape;
  readonly objectType: string;
  readonly relation: string;
  /**
   * Everything the relation admits.
   *
   * Deliberately not in the message. `addTuple`'s errors are the
   * ones a service is most likely to hand back to whoever
   * attempted the write, and the list names every admitted type,
   * every userset relation and every condition -- a description of
   * the authorization model, disclosed to anyone who can attempt a
   * write and get the message back. OpenFGA names only the
   * offending type. A caller with a legitimate reason to see the
   * list reads it here.
   *
   * `[]` on a refusal that names a `SubjectDefect` means the
   * restrictions were never consulted, not that the relation
   * admits nothing: those causes are decided ahead of them, and
   * the list is carried only where the caller already held the
   * config.
   */
  readonly allowed: readonly TypeRestriction[];

  constructor(
    subject: SubjectShape,
    objectType: string,
    relation: string,
    allowed: readonly TypeRestriction[],
    cause?: SubjectDefect,
    detail?: string,
  ) {
    super(
      cause === undefined
        ? `Subject type '${formatRestriction(subject)}' is not allowed for ` +
            `${objectType}.${relation}`
        : `Invalid subject for ${objectType}.${relation}: ${cause}` +
            (detail === undefined ? "" : ` (${detail})`),
    );
    this.name = "InvalidSubjectTypeError";
    if (cause !== undefined) this.cause = cause;
    this.subject = subject;
    this.objectType = objectType;
    this.relation = relation;
    this.allowed = allowed;
  }
}

/**
 * Every way a tuple's condition can fail against the model.
 *
 * OpenFGA raises one error type for all of them and discriminates
 * by a cause string (`internal/validation/validation.go`), so
 * tsfga does the same rather than inventing a class per cause —
 * one upstream error, one tsfga error.
 */
export type ConditionalTupleCause =
  /** No condition on the tuple, but every matching restriction has one. */
  | "condition is missing"
  /** A condition the matching restrictions do not name. */
  | "invalid condition for type restriction"
  /** The condition is not defined in the store. */
  | "undefined condition"
  /** A context value cannot be read as its declared parameter type. */
  | "parameter type error"
  /** A context key the condition does not declare. */
  | "invalid context parameter"
  /**
   * The context is larger than the write limit.
   *
   * Upstream measures a serialised protobuf `Struct` against
   * `DefaultWriteContextByteLimit` (32 KiB,
   * `pkg/server/config/config.go:36`); tsfga cannot reproduce that
   * encoding, so it measures the JSON. The rule is the same; the
   * measure diverges, and only near the boundary.
   */
  | "context size limit exceeded"
  /**
   * A key or string value holds a Unicode control character.
   *
   * Go's `unicode.IsControl` — `U+0000`-`U+001F` and
   * `U+007F`-`U+009F` (`internal/utils/sanitize.go:8-11`). Nested
   * lists and structs are in scope, and so is the condition name.
   */
  | "context contains forbidden characters";

/**
 * The subject's type is assignable, but not with the condition the
 * tuple carries — or without one.
 */
export class InvalidConditionalTupleError extends TsfgaError {
  override readonly cause: ConditionalTupleCause;
  /** The subject ref the write named. */
  readonly subject: TypeRestriction;
  readonly objectType: string;
  readonly relation: string;
  /**
   * Everything the relation admits.
   *
   * On the error, not in the message, for the reason given on
   * `InvalidSubjectTypeError`: rendering it would disclose the
   * relation's whole type restriction list -- every admitted type,
   * every userset relation, every condition name -- to whoever can
   * attempt a write and read the response.
   */
  readonly allowed: readonly TypeRestriction[];

  constructor(
    cause: ConditionalTupleCause,
    subject: TypeRestriction,
    objectType: string,
    relation: string,
    allowed: readonly TypeRestriction[],
    detail?: string,
  ) {
    super(
      `Invalid conditional tuple for ${objectType}.${relation}: ${cause}` +
        (detail === undefined ? "" : ` (${detail})`) +
        `. Subject: '${formatRestriction(subject)}'`,
    );
    this.name = "InvalidConditionalTupleError";
    this.cause = cause;
    this.subject = subject;
    this.objectType = objectType;
    this.relation = relation;
    this.allowed = allowed;
  }
}

/**
 * The tuple says only what the model already says.
 *
 * `doc:1#blocked@doc:1#blocked` asserts that the relation contains
 * itself, which is true by definition, so upstream refuses to
 * store it: `Reason: cannot write a tuple that is implicit`.
 *
 * Refused on the **write** path only. A contextual tuple of the
 * same shape is accepted upstream — measured on v1.18.2, with a
 * control proving the field was honoured — so the asymmetry is
 * deliberate, not an oversight about where the check belongs.
 */
export class ImplicitTupleError extends TsfgaError {
  readonly objectType: string;
  readonly objectId: string;
  readonly relation: string;

  constructor(objectType: string, objectId: string, relation: string) {
    const ref = `${objectType}:${objectId}#${relation}`;
    super(`Cannot write a tuple that is implicit: ${ref}@${ref}`);
    this.name = "ImplicitTupleError";
    this.objectType = objectType;
    this.objectId = objectId;
    this.relation = relation;
  }
}

/**
 * The tuple is already stored.
 *
 * Upstream's `on_duplicate` defaults to `error`
 * (`pkg/server/commands/write.go:58-67`), so a second write of the
 * same edge is refused rather than absorbed. The natural key is
 * upstream's `TupleKeyWithoutCondition`: **the condition is not
 * part of it**, so rewriting a live grant with a different
 * condition is a duplicate too, not a second row.
 */
export class DuplicateTupleError extends TsfgaError {
  readonly objectType: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation: string | null;

  constructor(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
    subjectRelation: string | null,
  ) {
    const subject =
      subjectRelation === null
        ? `${subjectType}:${subjectId}`
        : `${subjectType}:${subjectId}#${subjectRelation}`;
    super(
      `Cannot write a tuple which already exists: ` +
        `${objectType}:${objectId}#${relation}@${subject}`,
    );
    this.name = "DuplicateTupleError";
    this.objectType = objectType;
    this.objectId = objectId;
    this.relation = relation;
    this.subjectType = subjectType;
    this.subjectId = subjectId;
    this.subjectRelation = subjectRelation;
  }
}

/**
 * Every way a relation config can be malformed against the rules
 * OpenFGA's typesystem enforces when it validates a model.
 *
 * A cause string rather than a class each, for the same reason
 * `ConditionalTupleCause` is: upstream reports these as one
 * invalid-model error discriminated by its message.
 */
export type RelationConfigDefect =
  /**
   * The object type's own name is not one the model can carry.
   *
   * Upstream refuses it at the API boundary, before the typesystem
   * ever sees the model — `type_invalid_pattern` for a name holding
   * `:`, `#`, `@`, a space or a control character, and
   * `type_invalid_length` for an empty or over-long one
   * (`pkg/server/errors/encoded_errors.go:190-198`). One cause
   * covers both: upstream's own split is between two proto
   * constraints on the same field, not between two defects.
   */
  | "malformed type name"
  /**
   * The relation's own name is not one the model can carry.
   *
   * `relation_invalid_pattern` / `relation_invalid_length`, the
   * same pair on the relation field. The predicate is upstream's
   * `IsValidRelation` (`pkg/tuple/tuple.go:440-457`) — no `:`,
   * `#`, `@`, space or control character — under a shorter length
   * bound than a type name's.
   */
  | "malformed relation name"
  /** A set operation with fewer than two children. */
  | "intersection has fewer than two operands"
  /** A tupleset relation may not be assignable to a userset. */
  | "tupleset relation admits a userset"
  /** A tupleset relation may not be assignable to a wildcard. */
  | "tupleset relation admits a wildcard"
  /** A type restriction names a condition the store has not got. */
  | "undefined condition"
  /**
   * A tupleset relation must be directly assignable and nothing
   * else — upstream requires its rewrite to be exactly
   * `Userset_This` (`pkg/typesystem/typesystem.go:1301-1304`).
   */
  | "tupleset relation is not a direct relation"
  /**
   * Type restrictions on a relation that admits no direct
   * assignment at all (`pkg/typesystem/error.go:147-150`).
   *
   * Not the converse: `directlyAssignable` beside `impliedBy`,
   * `computedUserset`, `tupleToUserset` or `excludedBy` is
   * upstream's `union(This, …)` / `difference(This, …)`, and both
   * are valid.
   */
  | "type restrictions on a non-assignable relation"
  /**
   * The relation admits nothing and rewrites nothing, so it can
   * never grant (`pkg/typesystem/error.go:142-145`). An empty
   * `directlyAssignable` on its own is *not* this — that is how a
   * purely computed relation is spelled.
   */
  | "relation admits nothing and rewrites nothing"
  /**
   * Nothing can ever enter the relation: its only arm is a
   * tuple-to-userset whose computed relation is itself.
   */
  | "relation has no entrypoint"
  /**
   * No type the tupleset relation admits defines the computed
   * relation (`pkg/typesystem/typesystem.go:1306-1318`). *Some*
   * type failing to define it is fine and stays fine — that is the
   * per-row skip `resolveTupleset` makes.
   */
  | "computed relation undefined on every tupleset type"
  /** A rewrite names a relation the object type does not define. */
  | "undefined relation";

/** A relation config the model would not admit. */
export class InvalidRelationConfigError extends TsfgaError {
  override readonly cause: RelationConfigDefect;
  readonly objectType: string;
  readonly relation: string;

  constructor(
    cause: RelationConfigDefect,
    objectType: string,
    relation: string,
    detail?: string,
  ) {
    super(
      `Invalid relation config for ${objectType}.${relation}: ${cause}` +
        (detail === undefined ? "" : ` (${detail})`),
    );
    this.name = "InvalidRelationConfigError";
    this.cause = cause;
    this.objectType = objectType;
    this.relation = relation;
  }
}

export class ConditionNotFoundError extends TsfgaError {
  constructor(conditionName: string) {
    super(`Condition definition not found: ${conditionName}`);
    this.name = "ConditionNotFoundError";
  }
}

/**
 * The expression does not compile.
 *
 * Distinct from `ConditionEvaluationError`, which is a condition
 * that compiled and then could not be *evaluated* against a
 * context. This one has no context and no tuple: the definition is
 * unusable on its own, and OpenFGA refuses the model write that
 * carries it rather than deferring to the first check.
 */
export class ConditionCompileError extends TsfgaError {
  override readonly cause: unknown;
  constructor(conditionName: string, cause: unknown) {
    super(`Failed to compile condition '${conditionName}': ${cause}`);
    this.name = "ConditionCompileError";
    this.cause = cause;
  }
}

export class ConditionEvaluationError extends TsfgaError {
  override cause: unknown;
  constructor(conditionName: string, cause: unknown) {
    super(`Failed to evaluate condition '${conditionName}': ${cause}`);
    this.name = "ConditionEvaluationError";
    this.cause = cause;
  }
}

export class DepthExceededError extends TsfgaError {
  constructor(detail: string) {
    super(`Check resolution too complex: ${detail}`);
    this.name = "DepthExceededError";
  }
}

export class InvalidStoredDataError extends TsfgaError {
  constructor(table: string, column: string, detail: string) {
    super(`Invalid data in ${table}.${column}: ${detail}`);
    this.name = "InvalidStoredDataError";
  }
}
