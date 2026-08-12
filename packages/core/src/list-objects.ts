import {
  createCheckScope,
  onSubjectRow,
  runCheck,
  validateCheckSubject,
  validateContextualTuples,
} from "./check.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import {
  ConditionEvaluationError,
  DepthExceededError,
  RelationConfigNotFoundError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { CheckOptions, ListObjectsRequest } from "./types.ts";

/**
 * List object IDs of a type for which the subject passes a full
 * check.
 *
 * Candidates come from `listCandidateObjectIds` (a pre-filter —
 * every candidate is still checked). All of them are checked in
 * one `CheckScope`, so the relation-config cache and the node memo
 * span the whole call: the shared subtree behind N documents is
 * resolved once rather than N times.
 *
 * Concurrency is bounded by `maxBreadth`. That is the same knob as
 * per-node branch fanout by design, not by accident: upstream
 * sizes its ListObjects worker pool at
 * `1 + resolveNodeBreadthLimit` and hands the same limit down to
 * the reverse-expand query
 * (`pkg/server/commands/list_objects.go`).
 *
 * The target relation is gated up front, before the candidate
 * pool is read, so an undefined relation is refused whether or not
 * any row happens to name an object of that type. Upstream orders
 * the same two gates this way — contextual tuples first, then
 * `GetRelation` on the target
 * (`pkg/server/commands/list_objects.go`) — and the order is
 * observable, so it is kept. The subject is gated third, after
 * both.
 *
 * The subject may be a userset (`request.subjectRelation`), and
 * then the objects returned are the ones that whole userset
 * reaches — not the ones its members reach. See `CheckRequest`.
 *
 * Errors: the first failing candidate *in candidate order* is
 * thrown, not the first to fail in wall-clock order — no candidate
 * after a failure is started, but every candidate before one is
 * awaited, so the error a broken model produces is reproducible.
 *
 * Two error classes are exceptions to that rule, and they are
 * exceptions in different ways.
 *
 * A `ConditionEvaluationError` is **deferred** rather than raised
 * at once — but only when it was raised on a read that does not
 * name the request subject, which is what `check.ts`'s
 * `onSubjectRow` predicate records. Then the
 * candidate counts as `false`, the call keeps going, and the
 * lowest-index such error is raised only if **no** candidate was
 * granted.
 *
 * The split is the whole point, and it is not a heuristic.
 * Upstream reverse-expands `ListObjects` from the subject, and the
 * first query it issues is for the rows whose subject *is* the
 * request subject on that relation. So a condition on such a row
 * is one upstream always evaluates too: an error there refuses on
 * both engines, and deferring it would answer where upstream
 * refuses. That is `findCheckTuples`' direct row and its
 * `subjectType:*` wildcard row, and those abort here exactly as
 * any other error does.
 *
 * Every other read — a tupleset scan, a userset scan — sits behind
 * at least one hop, and upstream materialises it only if some path
 * from the subject leads there. tsfga checks every candidate
 * forward and cannot know, so it defers: a tuple hanging off an
 * object the subject reaches nothing through must not cost the
 * whole answer. Where the erroring candidate really was the
 * subject's only path, nothing is granted and the error is raised
 * after all, so both engines still refuse. That residual is the
 * approximation, and it is the safe direction.
 *
 * This is the per-read rule `raiseUnlessOneHeld` states in
 * `check.ts` — a read whose row conditions threw raises only if no
 * row's condition held — lifted to call scope for a deferred
 * error, and to call scope *only*: the read-scoped rule inside
 * `check.ts` is unchanged, so per-object `check` still refuses
 * exactly where upstream's `Check` does.
 *
 * `DepthExceededError` is the other exception: a candidate whose
 * resolution exhausts the budget is dropped, exactly as a
 * candidate answering `false` is, and the rest of the call still
 * answers. Upstream's stated policy is the opposite — a
 * depth-exceeded candidate fails the whole ListObjects
 * (`reverse_expand.go`,
 * `ErrAuthorizationModelResolutionTooComplex`) — but upstream
 * reverse-expands over a job queue instead of recursing per hop,
 * so its boundary sits far enough out that it almost never reaches
 * its own abort. Dropping the candidate is therefore closer to
 * upstream on every shape upstream can answer, and further from it
 * only where upstream genuinely aborts. The policy is local to
 * `listObjects`: `check` still raises, in every set position, and
 * so does it for a deferred condition error.
 *
 * Every other error — a missing relation config above all — still
 * aborts the call in candidate order. A relation with no config is
 * refused, never turned into an empty list.
 *
 * The returned array is in candidate order. That is a tsfga
 * determinism choice rather than parity — upstream streams objects
 * in completion order from its pool.
 *
 * Contextual tuples are applied **once, to the whole call**, not
 * per candidate. `runCheck` gives a request carrying them its own
 * memo, because a result resolved over them is not shareable with
 * one resolved without; here every candidate sees the same overlay,
 * so the scope memo stays shared and the saving this function
 * exists for survives.
 */
export async function listObjects(
  store: TupleStore,
  request: ListObjectsRequest,
  options: CheckOptions = {},
): Promise<string[]> {
  const { objectType, relation, subjectType, subjectId, context } = request;
  const subjectRelation = request.subjectRelation;
  const contextualTuples = request.contextualTuples ?? [];
  if (contextualTuples.length > 0) {
    await validateContextualTuples(store, contextualTuples);
  }
  const resolutionStore =
    contextualTuples.length > 0
      ? new ContextualTupleStore(store, contextualTuples)
      : store;
  const scope = createCheckScope(resolutionStore, options);
  // Read through the scope's caching store, so the per-candidate
  // checks take this config back out of the cache rather than
  // paying for a second round trip.
  const config = await scope.store.findRelationConfig(objectType, relation);
  if (config === null) {
    throw new RelationConfigNotFoundError(objectType, relation);
  }
  // Last of the three gates, which is upstream's order: contextual
  // tuples, then the target relation, then the subject
  // (`pkg/server/commands/list_objects.go:534-555`). Check orders
  // the subject *first* instead — the two commands genuinely
  // differ, and both orders are observable, so neither is
  // normalised away. Doing it here rather than leaving it to the
  // per-candidate `runCheck` is what makes a malformed subject a
  // refusal even when the candidate pool is empty.
  await validateCheckSubject(scope.store, request);
  const candidateIds = await resolutionStore.listCandidateObjectIds(objectType);

  return resolveCandidates(candidateIds, scope.maxBreadth, (objectId) =>
    runCheck(scope, {
      objectType,
      objectId,
      relation,
      subjectType,
      subjectId,
      subjectRelation,
      context,
    }).catch((error: unknown) => {
      // A candidate the budget could not resolve is dropped, not
      // propagated -- see the note on this function. Only this
      // error is dropped here: a deferrable condition error has to
      // reach `resolveCandidates`, which is the only place that
      // can see whether any *other* candidate was granted.
      if (error instanceof DepthExceededError) return false;
      throw error;
    }),
  );
}

/**
 * Run `check` over candidates with at most `maxBreadth` in flight,
 * preserving candidate order in the result.
 *
 * Same pull model as the node combinator in `check.ts`: handlers
 * launch in order while there is a free slot, and each settlement
 * pulls the next. It cannot share that combinator because this one
 * collects every result instead of short-circuiting on the first
 * decisive one.
 *
 * On failure it stops launching but still awaits what is already
 * in flight, then rejects with the lowest-index failure seen. That
 * is deterministic: launching is in index order, so when a
 * candidate at index `f` fails, every index below `f` has already
 * been launched and will be awaited — including the true lowest
 * failing index, which is therefore always the one reported,
 * whatever the completion order was.
 *
 * A deferrable failure is held in a second slot instead. It never
 * stops the launch loop and never becomes the cut-off: the
 * candidate is simply not granted, and the lowest-index such error
 * is raised at the end only when the granted set is empty. That
 * slot keeps the lowest index exactly as the hard one does, so
 * which error a caller sees is still independent of completion
 * order. A hard failure wins over a deferred one whatever their
 * indices: it aborts the call, which is the stronger outcome.
 */
function resolveCandidates(
  candidateIds: readonly string[],
  maxBreadth: number,
  run: (objectId: string) => Promise<boolean>,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const allowed = new Array<boolean>(candidateIds.length).fill(false);
    let next = 0;
    let active = 0;
    let settled = false;
    // Also the launch cut-off: nothing at or beyond it is started.
    let failedIndex = candidateIds.length;
    let failure: unknown;
    // The deferred slot. Not a cut-off: the loop runs on.
    let deferredIndex = candidateIds.length;
    let deferred: unknown;

    const record = (index: number, error: unknown) => {
      if (isDeferrable(error)) {
        if (index < deferredIndex) {
          deferredIndex = index;
          deferred = error;
        }
        return;
      }
      if (index < failedIndex) {
        failedIndex = index;
        failure = error;
      }
    };

    const launch = () => {
      while (
        !settled &&
        active < maxBreadth &&
        next < candidateIds.length &&
        next < failedIndex
      ) {
        const index = next;
        next++;
        const objectId = candidateIds[index];
        if (objectId === undefined) continue;
        active++;
        let candidate: Promise<boolean>;
        try {
          candidate = run(objectId);
        } catch (error) {
          // A synchronous throw counts as a failed candidate;
          // without this its slot would leak and the pool could
          // stall with nothing in flight.
          active--;
          record(index, error);
          continue;
        }
        candidate.then(
          (result) => {
            if (settled) return;
            allowed[index] = result;
            onCandidateDone();
          },
          (error) => {
            if (settled) return;
            record(index, error);
            onCandidateDone();
          },
        );
      }
      // No candidates, holes, and synchronous throws can exhaust
      // the launch loop with nothing in flight; settle here so the
      // returned promise can never stall.
      if (!settled && active === 0) {
        settleExhausted();
      }
    };

    const onCandidateDone = () => {
      active--;
      if (next < candidateIds.length && next < failedIndex) {
        launch();
      } else if (active === 0) {
        settleExhausted();
      }
    };

    const settleExhausted = () => {
      settled = true;
      if (failedIndex < candidateIds.length) {
        reject(failure);
        return;
      }
      const granted = candidateIds.filter((_, index) => allowed[index]);
      // Nothing held, so a condition that could not be evaluated
      // may be the reason -- raise it rather than answer `[]`.
      if (granted.length === 0 && deferredIndex < candidateIds.length) {
        reject(deferred);
        return;
      }
      resolve(granted);
    };

    launch();
  });
}

/**
 * Whether a candidate's failure is held back to the end of the
 * call instead of aborting it. See the note on `listObjects`: only
 * a condition error raised on a read that does not name the
 * request subject, because that is the only read upstream's
 * reverse expansion may never reach.
 */
function isDeferrable(error: unknown): boolean {
  return error instanceof ConditionEvaluationError && !onSubjectRow(error);
}
