import {
  createCheckScope,
  runCheck,
  validateCheckSubject,
  validateContextualTuples,
} from "./check.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import { DepthExceededError, RelationConfigNotFoundError } from "./errors.ts";
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
 * `DepthExceededError` is the one exception: a candidate whose
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
 * `listObjects`: `check` still raises, in every set position.
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
      // error: every other one still aborts the call in candidate
      // order, which is what a broken model should do.
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

    const record = (index: number, error: unknown) => {
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
      } else {
        resolve(candidateIds.filter((_, index) => allowed[index]));
      }
    };

    launch();
  });
}
