import { InvalidRelationConfigError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { RelationConfig } from "./types.ts";

/**
 * Validate a relation config against the rules OpenFGA's
 * typesystem applies when it validates a model.
 *
 * Eight shapes are refused, each measured against v1.18.2 as an
 * `invalid_authorization_model` upstream and, before this,
 * accepted here — several of them changing an answer rather than
 * merely widening the write surface:
 *
 * - **an `intersection` with fewer than two operands.** Upstream:
 *   `as intersection has less than 2 children`. tsfga resolved a
 *   single-operand intersection to whatever that operand said, so
 *   a config that means nothing granted.
 * - **a tupleset relation admitting a userset.** Upstream: `the
 *   relation type 'folder#owner' on 'parent' in object type 'doc'
 *   is not valid`. tsfga admitted the row and then dispatched on
 *   its object while **discarding its subject relation**, landing
 *   on a different relation of the linked object and granting.
 * - **a tupleset relation admitting a wildcard.** Refused the same
 *   way upstream; here it resolved to `false` rather than
 *   granting, so it is a write-surface gap only.
 * - **a type restriction naming a condition the store does not
 *   define.** Upstream: `condition nope is undefined for relation
 *   viewer`.
 * - **a tupleset relation that is not a direct relation.**
 *   Upstream: `the 'doc#alias' relation is referenced in at least
 *   one tupleset and thus must be a direct relation`.
 *   `resolveTupleset` reads a tupleset by tuples alone, with no
 *   rewrite expansion, so a computed one finds nothing and the
 *   relation answers `false` for every subject, forever.
 * - **type restrictions on a relation that admits no direct
 *   assignment.** Upstream: `the non-assignable relation 'viewer'
 *   in object type 'doc' should not contain a relation type`. The
 *   restrictions are dead weight with one live effect: a tuple can
 *   be *written* against them and is then invisible to every
 *   check.
 * - **a relation that admits nothing and rewrites nothing.**
 *   Upstream: `the assignable relation 'viewer' in object type
 *   'doc' must contain at least one relation type`. Inert in both
 *   directions, and there is no model it corresponds to.
 * - **a relation with no entrypoint**, in the one form a single
 *   config decides — see below.
 *
 * ## The stated gap: write order
 *
 * A model is one document upstream, so its relations are validated
 * together. Here configs arrive one at a time, and several rules
 * are properties of a **different** relation than the one being
 * written — the relation named as `tupleset`, or a relation on a
 * linked type. When that relation's config has not been written
 * yet there is nothing to read, and this **skips the check**
 * rather than guessing.
 *
 * So a config declaring a tuple-to-userset **before** its tupleset
 * relation's config exists is not validated, and neither is a later
 * widening of that tupleset relation. Closing either would need a
 * reverse lookup — "which configs name me as a tupleset" — that
 * `TupleStore` does not have and that is not worth adding for this.
 * A validator that fired on write order would be worse than one
 * with a gap written down: it would refuse correct models for
 * arriving in an order nothing documents.
 *
 * ### Two rules this gap keeps out entirely
 *
 * Upstream also refuses a rewrite naming a relation that does not
 * exist, and a tuple-to-userset whose computed relation **no**
 * tupleset type defines. Neither can be decided from one config,
 * and not for want of trying: both premises are *always* absent
 * for a forward reference, so "skip when absent" degenerates into
 * "never check", while checking strictly refuses correct models.
 *
 * That is measured, not assumed. Run warn-only over this repo's
 * own conformance corpus, the strict forms refuse 43 config writes
 * across `deep-rewrite`, `a5-nested-folders`, `a5-ttu-chains`,
 * `a7-recursion`, `a8-*` and `theopenlane.*` — every one of them
 * an ordinary model whose relations happen to be written in
 * definition order rather than dependency order. `viewer: a but
 * not banned` written before `banned`, and `blocked: nblocked from
 * parent` written before `nblocked`, are not defects.
 *
 * Both belong to a validator that sees the whole model at once —
 * a batch config write, or a `validateModel()` pass — and both are
 * left open deliberately rather than half-closed here. The
 * check-time behaviour is already correct for the first (a check
 * reaching an undefined relation is refused, as upstream refuses
 * it); what is missing is only the earlier, cheaper refusal that
 * names the actual mistake.
 *
 * The condition rule has no such gap, because the absence of a
 * condition definition *is* the defect rather than a missing
 * premise. It does mean conditions must be defined before the
 * configs that name them, which is the order upstream's atomic
 * model write imposes anyway.
 *
 * ## The names themselves
 *
 * Ahead of all eight, and ahead of every store read, the config's
 * own `objectType` and `relation` are checked for
 * well-formedness. It is the cheapest rule here and the earliest
 * one upstream applies — see `isWellFormedName` below.
 */
export async function validateRelationConfigWrite(
  store: TupleStore,
  config: RelationConfig,
): Promise<void> {
  const refuse = (
    cause: ConstructorParameters<typeof InvalidRelationConfigError>[0],
    detail?: string,
  ): never => {
    throw new InvalidRelationConfigError(
      cause,
      config.objectType,
      config.relation,
      detail,
    );
  };

  if (!isWellFormedName(config.objectType, MAX_TYPE_NAME_LENGTH)) {
    refuse("malformed type name", describeName(config.objectType));
  }

  if (!isWellFormedName(config.relation, MAX_RELATION_NAME_LENGTH)) {
    refuse("malformed relation name", describeName(config.relation));
  }

  if (config.intersection !== null && config.intersection.length < 2) {
    refuse(
      "intersection has fewer than two operands",
      `${config.intersection.length}`,
    );
  }

  if (config.directlyAssignable.length === 0 && !hasRewrite(config)) {
    refuse("relation admits nothing and rewrites nothing");
  }

  // An `intersection` with no `direct` operand is upstream's
  // `intersection(...)` with no `This` child: the relation admits
  // no direct assignment at all, so restrictions on it describe
  // nothing. The converse is *not* a defect -- `directlyAssignable`
  // beside `impliedBy` / `computedUserset` / `tupleToUserset` /
  // `excludedBy` is `union(This, ...)` and `difference(This, ...)`,
  // both valid and both all over the corpus.
  if (
    config.directlyAssignable.length > 0 &&
    config.intersection !== null &&
    !config.intersection.some((operand) => operand.type === "direct")
  ) {
    refuse(
      "type restrictions on a non-assignable relation",
      config.directlyAssignable.map((each) => each.type).join(", "),
    );
  }

  for (const restriction of config.directlyAssignable) {
    if (restriction.condition === undefined) continue;
    const definition = await store.findConditionDefinition(
      restriction.condition,
    );
    if (!definition) refuse("undefined condition", restriction.condition);
  }

  for (const tupleset of tuplesetRelations(config)) {
    const linked = await store.findRelationConfig(config.objectType, tupleset);
    // Not yet written: see the write-order gap above.
    if (!linked) continue;
    if (hasRewrite(linked)) {
      refuse(
        "tupleset relation is not a direct relation",
        `${tupleset} is computed`,
      );
    }
    for (const restriction of linked.directlyAssignable) {
      if (restriction.relation !== undefined) {
        refuse(
          "tupleset relation admits a userset",
          `${tupleset} admits ${restriction.type}#${restriction.relation}`,
        );
      }
      if (restriction.wildcard) {
        refuse(
          "tupleset relation admits a wildcard",
          `${tupleset} admits ${restriction.type}:*`,
        );
      }
    }
  }

  if (await hasNoEntrypoint(store, config)) {
    refuse("relation has no entrypoint");
  }
}

/**
 * The characters neither a type name nor a relation name may
 * hold, measured against v1.18.2 rather than read off a Go file.
 *
 * The model write path is guarded by protobuf field patterns, not
 * by the typesystem and not by `pkg/tuple`'s `IsValidRelation`:
 * `^[^:#@\s]{1,254}$` on `TypeDefinition.Type` and
 * `^[^:#@\s]{1,50}$` on each key of `TypeDefinition.Relations`.
 * Both classes are identical, so this is one predicate under two
 * bounds rather than two predicates — including `@`, which
 * `IsValidRelation` refuses and which the type pattern refuses
 * too.
 *
 * `\s` is Go's, so it is exactly `[\t\n\f\r ]` — five characters,
 * not the Unicode space property. Probed: a vertical tab (U+000B),
 * a no-break space (U+00A0), U+2028 and an ideographic space are
 * all **accepted** by both fields, and so is every other control
 * character outside that set (U+0001, U+007F, U+0085 measured).
 * This deliberately does not reuse `tuple-validation.ts`'s
 * control-character rule: that one is the tuple write path's, and
 * applying it here would refuse names upstream stores.
 */
const NAME_RESERVED: ReadonlySet<string> = new Set([
  ":",
  "#",
  "@",
  " ",
  "\t",
  "\n",
  "\f",
  "\r",
]);

/**
 * 254, measured by bisecting model writes against the container:
 * accepted at 254, `type_invalid_pattern` at 255.
 */
const MAX_TYPE_NAME_LENGTH = 254;

/**
 * 50, bisected the same way; 51 is `relations_invalid_pattern`.
 * Note the code is plural — there is no `relation_invalid_pattern`
 * and no `*_invalid_length` on either field, because the bound
 * lives in the pattern.
 */
const MAX_RELATION_NAME_LENGTH = 50;

/**
 * Whether a name is one the model can carry.
 *
 * The bound counts **code points**, as a Go regexp quantifier
 * does: a 254-character name of `é` is accepted at 508 bytes, and
 * 254 astral code points are accepted at 508 UTF-16 units. So
 * neither `Buffer.byteLength` nor `String.length` is the measure —
 * hence the spread.
 */
function isWellFormedName(name: string, maxLength: number): boolean {
  const codePoints = [...name];
  if (codePoints.length === 0) return false;
  if (codePoints.length > maxLength) return false;
  return !codePoints.some((char) => NAME_RESERVED.has(char));
}

/** Why the name was refused, for the error's `detail`. */
function describeName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length === 0) return "empty";
  const offending = codePoints.find((char) => NAME_RESERVED.has(char));
  if (offending !== undefined) {
    const code = offending.codePointAt(0) ?? 0;
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    return `reserved character U+${hex}`;
  }
  return `${codePoints.length} characters`;
}

/** Whether the config rewrites at all, in any of the five arms. */
function hasRewrite(config: RelationConfig): boolean {
  return (
    (config.impliedBy ?? []).length > 0 ||
    config.computedUserset !== null ||
    (config.tupleToUserset ?? []).length > 0 ||
    config.excludedBy !== null ||
    (config.intersection ?? []).length > 0
  );
}

/**
 * The one form of "no entrypoint" a single config decides.
 *
 * Upstream applies `hasEntrypoints` to every relation of a whole
 * model: a relation is invalid when nothing can ever satisfy it.
 * That is a whole-model property and `writeRelationConfig` sees one
 * config, so only the closed case is decidable here — the relation
 * whose *sole* arm is a tuple-to-userset onto itself, over a
 * tupleset that admits its own object type and nothing else:
 *
 *     define parent: [doc]
 *     define viewer: viewer from parent      # never `[user] or ...`
 *
 * Every check on it walks the parent chain and answers `false`, or
 * — on a chain longer than the depth budget — raises, which is a
 * *refusal* for a model upstream would never have stored.
 *
 * The three narrowings are each load-bearing. A directly
 * assignable arm, or any second arm, is an entrypoint. A tupleset
 * admitting some *other* type is not a cycle at all: that type's
 * relation may well have one, which is why `adoc#viewer: viewer
 * from bparent` over `bdoc` is ordinary. And a tupleset relation
 * with no restrictions at all is not evidence of a cycle either;
 * it is a config not yet written the way it will be.
 *
 * The general rule stays open beside the write-order gap above,
 * rather than being closed half-way.
 */
async function hasNoEntrypoint(
  store: TupleStore,
  config: RelationConfig,
): Promise<boolean> {
  const entries = config.tupleToUserset ?? [];
  if (entries.length === 0) return false;
  if (config.directlyAssignable.length > 0) return false;
  if (
    (config.impliedBy ?? []).length > 0 ||
    config.computedUserset !== null ||
    config.excludedBy !== null ||
    (config.intersection ?? []).length > 0
  ) {
    return false;
  }

  for (const entry of entries) {
    if (entry.computedUserset !== config.relation) return false;
    const linked = await store.findRelationConfig(
      config.objectType,
      entry.tupleset,
    );
    // Not yet written: see the write-order gap above.
    if (!linked) return false;
    if (linked.directlyAssignable.length === 0) return false;
    const selfOnly = linked.directlyAssignable.every(
      (restriction) => restriction.type === config.objectType,
    );
    if (!selfOnly) return false;
  }
  return true;
}

/**
 * Every relation this config reads as a tupleset.
 *
 * Both places one can appear: the plain `tupleToUserset` entries
 * of step 5 and an `intersection` operand of that type. The second
 * is the one a fix applied to the first alone would leave open,
 * which is the same pairing `resolveTupleset` exists for.
 */
function tuplesetRelations(config: RelationConfig): Set<string> {
  const relations = new Set<string>();
  for (const entry of config.tupleToUserset ?? []) {
    relations.add(entry.tupleset);
  }
  for (const operand of config.intersection ?? []) {
    if (operand.type === "tupleToUserset") relations.add(operand.tupleset);
  }
  return relations;
}
