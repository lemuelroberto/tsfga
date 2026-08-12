# @tsfga/core

OpenFGA-compatible relationship-based access control for
TypeScript.

Part of the [tsfga](../../README.md) monorepo.

## Installation

```bash
npm install @tsfga/core
```

## Quick start

```typescript
import { createTsfga, type TupleStore } from "@tsfga/core";

// Use any TupleStore implementation (e.g. @tsfga/kysely)
const store: TupleStore = /* your store */;
```

<!-- sample: core-quick-start -->
```typescript
const fga = createTsfga(store);

// Write a relation config
await fga.writeRelationConfig({
  objectType: "document",
  relation: "viewer",
  // What the relation admits, one entry per entry of OpenFGA's
  // `directly_related_user_types`: `{ type }` for a bare type,
  // `{ type, wildcard: true }` for `user:*`, `{ type, relation }`
  // for a userset, and `condition` on any of them. `[]` means the
  // relation admits no direct assignment at all.
  directlyAssignable: [{ type: "user" }],
  // The rewrite fields. A relation that is only directly
  // assignable names none of them, but all are required, so a
  // config cannot silently omit one it meant to set.
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
});

// Add a tuple
await fga.addTuple({
  objectType: "document",
  objectId: "550e8400-e29b-41d4-a716-446655440000",
  relation: "viewer",
  subjectType: "user",
  subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
});

// Check access
const allowed = await fga.check({
  objectType: "document",
  objectId: "550e8400-e29b-41d4-a716-446655440000",
  relation: "viewer",
  subjectType: "user",
  subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
});
```

## API

`createTsfga(store, options?)` returns a `TsfgaClient`:

| Method | Description |
|---|---|
| `check(request)` | Check if a subject has a relation on an object; the subject may be a userset via `subjectRelation` |
| `checkMany(requests)` | Check several requests in one shared resolution scope; outcomes in request order |
| `addTuple(request)` | Insert a relationship tuple; a tuple that already exists throws `DuplicateTupleError` |
| `removeTuple(request)` | Delete a relationship tuple |
| `listObjects(request)` | List object IDs the subject can access, in candidate order; the request takes `subjectRelation`, `context` and `contextualTuples` |
| `listSubjects(objectType, objectId, relation)` | List direct subjects for an object + relation (no expansion) |
| `writeRelationConfig(config)` | Insert or update a relation configuration |
| `deleteRelationConfig(objectType, relation)` | Delete a relation configuration |
| `writeConditionDefinition(condition)` | Insert or update a CEL condition definition |
| `deleteConditionDefinition(name)` | Delete a CEL condition definition |

## Depth limits and cycles

`check()` resolves relations recursively with a configurable
recursion budget (`maxDepth`, default 25, via the second
argument of `createTsfga`). The default matches OpenFGA's
`OPENFGA_RESOLVE_NODE_LIMIT` (25) in value, but **not in reach** —
see below.

### Known divergence: the depth boundary

At the same numeric limit, tsfga exhausts one dispatch earlier
than OpenFGA on most shapes. Upstream resolves the *terminal* hop
in place instead of dispatching for it: its weight-2 resolvers
require the target node to have weight 1 to the user type, which
is true only of the last hop. tsfga has no weighted relation
graph, so it dispatches for every hop.

At the default 25, an n-hop chain answers for `n <= 25` upstream
and `n <= 24` here; deeper, upstream answers where tsfga raises
`DepthExceededError`. The direction is conservative — tsfga
refuses where upstream answers — but it is a divergence.

**The offset is not uniform, which is why the budget is not simply
raised.** Give the leaf relation a second arm and it is no longer
weight 1, upstream declines its own resolver, dispatches for the
terminal hop as tsfga does, and the two agree exactly. A uniform
`+1` would make tsfga answer on that shape where upstream returns
`authorization_model_resolution_too_complex` — a *granting*
divergence introduced by a parity fix, which is worse than the
fail-closed one it would replace.

The correct fix is to implement upstream's weight computation, and
it is deferred to its own round. Both rows — the offset and its
absence on a weight-2 leaf — are pinned two-sided in
`tests/conformance/depth-boundary.test.ts`, so this goes red if
the gap widens or closes.

The same offset is visible through `listObjects`, where it costs
one *object* rather than one answer: on a 25-hop chain upstream
returns all 26 objects and tsfga returns 25, missing only the one
whose distance from the grant is the whole chain. A 24-hop chain
agrees exactly on both engines. See the section below for what
happens when the chain is much longer than the budget.

**Only hops to another object spend the budget.** Userset
expansion and tuple-to-userset expansion each cost one depth;
rewrites of the same object — `impliedBy`, `computedUserset`,
`excludedBy`, and intersection operands — cost none. This
matches OpenFGA, which increments resolution depth solely when
it dispatches to a child object. A rewrite ladder can therefore
be arbitrarily long without exhausting the budget; it is
bounded instead by cycle detection, since one object has a
finite set of relations. A budget of `maxDepth` admits a root
node plus `maxDepth - 1` dispatches.

- When the budget is exhausted, `check()` throws
  `DepthExceededError` — mirroring OpenFGA's "resolution too
  complex" error. Prior to 0.3.0 exhaustion silently resolved to
  `false`, which could fail open: a truncated `excludedBy`
  sub-check read as "not excluded" and granted access.
- **A cycle is not an error.** When the resolution path revisits
  a node it already contains, that subtree resolves `false`, and
  `check()` returns `false` to the caller. This matches OpenFGA,
  which errors only on depth exhaustion and returns
  `Allowed:false` with an internal `CycleDetected` flag for a
  cycle. tsfga tracks the same flag internally; like OpenFGA it
  is not exposed on the public result. See "Cycles and
  indeterminacy" below for why it is not simply a `false`.
- Union-style branches (direct, userset, implied_by, computed
  userset, tuple-to-userset) are resolved concurrently: a
  branch that resolves `true` wins even if a sibling branch
  threw `DepthExceededError` or was truncated by a cycle. If no
  branch grants and at least one errored, the error propagates.
- Exclusion (`excludedBy`) and intersection branches fail
  closed: an errored branch never counts as satisfied or as
  not-excluded. A definitive deny still short-circuits past a
  sibling error, matching OpenFGA — an intersection operand
  resolving `false`, or an exclusion branch resolving `true`,
  denies even when the other branch errored.
- Condition evaluation with missing declared parameters, or with
  a value that cannot be read as its declared type, is an error
  (`ConditionEvaluationError`), not an unmet condition — matching
  OpenFGA's check behavior. A silently-unmet condition would fail
  open through an exclusion branch.

  That error is held rather than raised while its **sibling rows**
  are still being read, and dropped if any of them had a condition
  that evaluated `true` — matching OpenFGA's filtered tuple
  iterator. A sibling whose condition evaluated `false` does not
  drop it; a sibling whose condition held but whose subtree denied
  does. Each read keeps its own decision, so a userset row that
  held does not rescue a broken direct row on the same relation.

  Values are coerced by a port of OpenFGA's converter table, not
  by a `typeof` check, which diverges on six cases. The numeric
  types accept numeric **strings** — JSON has no integer type, so
  upstream parses rather than asserts — while `duration` and
  `timestamp` accept **only** strings:

  | value | declared | verdict |
  |---|---|---|
  | `42`, `"42"` | int | accepted |
  | `4.5`, `"abc"`, `true` | int | refused |
  | `-1`, `"-1"` | uint | refused |
  | `"1.5"`, `1.5` | double | accepted |
  | `"1h"`, `"2h45m"` | duration | accepted |
  | `"1d"`, `3600` | duration | refused |
  | `"2026-01-01T00:00:00Z"` | timestamp | accepted |
  | `1700000000` | timestamp | refused |
  | `["a"]` | `list<string>` | accepted |
  | `[1]` | `list<string>` | refused |

  A context key the condition does not declare is accepted at
  check time and refused on write.

  **The numeric grammar is Go's, not JavaScript's.** Every numeric
  type is parsed upstream by `big.ParseFloat(value, 10, 64, 0)`,
  and the boundary is nowhere near `Number()`'s:

  | spelling | read as | note |
  |---|---|---|
  | `"0x10"`, `"0o10"`, `"0b10"`, `"1_000"` | refused | base 10 is explicit |
  | `" 42 "`, `"\n42"`, `""` | refused | no surrounding space |
  | `"1e3"`, `"1E3"`, `"4.0"`, `"5."`, `".5"`, `"1p3"` | accepted | `p` is a binary exponent |
  | `"Inf"`, `"+Inf"`, `"-Inf"`, `"inf"` | ±∞ (double) | `"Infinity"` and `"NaN"` are refused |
  | `"0.1"`, `"3.14"` | refused (double) | see below |

  An `int` is whatever parses to an integral value, so `"4.0"` and
  `"1e3"` are ints and `"4.5"` is not. Magnitudes outside int64
  saturate to its bounds — including for `uint`, whose ceiling is
  **int64**'s, because upstream converts every numeric string
  through the same `Int64()` and only then rejects a negative.

  A `double` carries one rule more: upstream parses at 64-bit
  precision and refuses the value if converting it to a `float64`
  loses anything. A decimal fraction with no finite binary form is
  therefore an error rather than the nearest double — `"0.1"` as a
  **string** is refused, while `0.1` as a **number** is accepted,
  since a number is already a `float64` and is asserted rather
  than parsed.

  A `duration` takes Go's unit grammar plus the one unitless form
  its parser special-cases, a bare `"0"`. A `timestamp` takes RFC
  3339 with **uppercase** `T` and `Z` and any number of fractional
  digits.

### Known divergence: `listObjects` past the depth budget

`listObjects` checks each candidate forward, so a candidate
further from the grant than `maxDepth` allows is **absent from the
answer**. Upstream reports it. On a 40-hop parent chain upstream
returns all 41 objects; tsfga returns the 25 nearest the grant.

The cause is the one named in the depth-boundary section above —
upstream does not resolve `ListObjects` through `Check` at all. It
reverse-expands from the subject over a job queue
(`reverse_expand_weighted.go`), so a long chain costs it no
resolution depth. Closing the gap needs that reverse walk, which
is the same missing machinery as the depth boundary itself.

What tsfga does **not** do is lose the rest of the answer with it.
A candidate whose resolution exhausts the budget is dropped,
exactly as a candidate answering `false` is, and the call still
returns every object that qualifies. Upstream's stated policy is
the opposite — a depth-exceeded candidate fails the whole
ListObjects (`ErrAuthorizationModelResolutionTooComplex`) — but
its boundary sits far enough out that it almost never reaches its
own abort, so dropping the candidate is closer to upstream on
every shape upstream can answer, and further from it only where
upstream genuinely aborts.

The policy is local to `listObjects`. `check` still raises
`DepthExceededError`, in every set position, and every other error
still aborts a `listObjects` call in candidate order.

Pinned two-sided by `a8-listobjects.test.ts` and
`a4-list-objects-depth.test.ts`.

## A relation the subject's type cannot reach is denied

Before resolving a node's rewrite, tsfga asks whether a subject of
this *type* could hold `objectType#relation` at all — at any
depth, for any data. When it could not, the node answers `false`
without reading a tuple. This is upstream's
`typesys.PathExists(user, relation, objectType)` check, which
`LocalChecker.ResolveCheck` performs at every node.

The answer is computed from the relation configs alone, walking
*backwards* from the node: the subject refs a relation admits,
then the refs that reach those, and so on. It is memoized for the
life of a resolution scope, so a `listObjects` or `checkMany` call
pays for it once; a model changed between requests is picked up by
the next scope.

The prune never manufactures a denial the model did not prove. A
relation the model does not define still raises
`RelationConfigNotFoundError`, and any part of the walk that could
not be read — an undefined relation reached by a rewrite, a store
error — leaves the node unpruned rather than denied. A subject
type is reachable if either it or its typed wildcard (`user:*`)
reaches the node, matching upstream's retry.

Three shapes used to answer wrongly, all with one cause: tsfga
narrowed only at the node it was standing on.

| shape | before | now (and upstream) |
|---|---|---|
| a userset chain, unreachable, whose row carries a condition the request cannot evaluate | refused | `false` |
| the same chain longer than the depth budget | `DepthExceededError` | `false` |
| an unreachable cyclic subtree on the subtract side of a `but not` | `false` | `true` |

The third is the one that mattered: a cycle-truncated `false`
*denies* on the subtract side, so the prune returns a plain,
unflagged `false` — never a cycle. Nothing about the depth budget
or the cycle rules changed.

The prune reads relation configs the resolution would not
otherwise have asked for. They go through the same request-scoped
cache as every other config read, so each `objectType#relation`
costs at most one round trip per scope; see
[`@tsfga/kysely`](../kysely/README.md)'s pool-sizing section for
what that measures at on a large model.

### Each `tuple-to-userset` arm is its own union branch

A relation may have several tuple-to-userset paths
(`viewer from parent or viewer from owner`). Each is its own
branch of the relation's union, as upstream makes each `checkTTU`
its own child. One arm whose tupleset rows carry a condition the
request cannot evaluate raises only for that arm: a sibling arm
that grants still wins, and the error propagates only when nothing
granted. The per-read error rule is unchanged — an arm's condition
errors are still weighed against that arm's own rows, never
against another arm's.

## A userset can be the subject of a check

`CheckRequest` and `ListObjectsRequest` carry an optional
`subjectRelation`, which makes the subject a **userset** —
upstream's `object#relation` form of `TupleKey.user`:

```ts
await fga.check({
  objectType: "document",
  objectId: "550e8400-e29b-41d4-a716-446655440000",
  relation: "viewer",
  subjectType: "team",
  subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  subjectRelation: "member",   // team:…#member
});
```

The question is a **comparison, not an expansion**. The userset
holds `viewer` iff a row grants that exact userset, or a rewrite
of `viewer` reaches one. It is not a check for each member of the
team, and a member holding `viewer` by some other route does not
make the userset hold it.

Three consequences, each measured against v1.18.2:

| shape | answer |
|---|---|
| a relation admitting `[team#member]`, asked about the bare `team:eng` | `false` |
| a relation admitting `[team]`, asked about `team:eng#member` | `false` |
| a `team:*` row, asked about `team:eng#member` | `false` |

The third is not an oversight: a userset can never be a wildcard,
so upstream skips the public-assignability probe
(`shouldCheckPublicAssignable`) and the wildcard retry in
`PathExists` outright when the subject is a userset. tsfga does
both.

A userset holds its own relation on its own object by definition —
`team:eng#member` is a `member` of `team:eng` — ahead of the
model, and even where the relation admits no userset at all.
Upstream answers this in `IsSelfDefining`, between the cycle guard
and the relation lookup.

`listObjects` takes the same field and reaches the objects the
whole userset reaches.

### Two request shapes are refused rather than denied

The subject of a check is validated before any of it is resolved,
as upstream validates the `user` field at the command layer:

- a `subjectRelation` the subject's type does not define, or a
  `subjectType` the model does not define, raises
  `RelationConfigNotFoundError` — upstream answers `relation
  'group#nonexistent' not found` rather than `false`;
- a `subjectId` containing `:` or `#`, a `subjectRelation` that is
  empty, and a `subjectId` of `*` carrying a subject relation, all
  raise `InvalidSubjectTypeError` with
  `cause: "malformed subject"`. Upstream's `userIDRegex` is
  `^[^:#\s\x00\p{Cc}]+$`, so none of them is a subject there
  either.

The second group closes a silent failure. Passing an
OpenFGA-shaped `user` string through `subjectId` — `subjectId:
"eng#member"` — used to resolve quietly to `false`, which a caller
cannot tell from a real denial. It now raises. **The ordering
differs between the two commands, and both orders are
upstream's:** `check` validates the subject first, then the
contextual tuples; `listObjects` validates contextual tuples, then
the target relation, then the subject.

The **write** path does not yet apply the id rule: `addTuple`
accepts a `subjectId` containing `:` or `#`, which upstream
refuses. Such a row is therefore writable and, since the check
gate landed, uncheckable. Closing it is a one-line rule in the
shared write validation and is not yet done.

## Cycles and indeterminacy

A cycle-truncated `false` means *no answer was reached*, not
*access is denied*, and the set operators read the difference:

| Position | A cycled branch behaves like |
|---|---|
| union branch | `false` — a granting sibling still wins |
| intersection operand | `false` — denies, it cannot be shown to hold |
| base of `but not` | `false` — denies |
| **subtract of `but not`** | **`true` — denies** |

The last row is the one that matters. Implementing "a cycle is
just `false`" makes `base:true but not subtract:cycle` grant,
because the truncated exclusion reads as "not excluded". OpenFGA
denies, and so does tsfga.

### `uint` (closed)

A `uint` parameter is carried as CEL's `uint` — cel-js's
`UnsignedInt` — so `type(n) == uint`, a bare `u`-suffixed literal,
and arithmetic bounded by **uint64** rather than int64 all agree
with upstream. The carrier costs `int(n)` on a `uint`, for which
cel-js has no overload; `conditions.ts` registers one and rewrites
the call onto it, so the trade this section used to describe is no
longer a trade.

Saturation is unchanged and still worth stating: a `uint` context
value saturates at **int64**'s ceiling, not uint64's, because
upstream converts every numeric string through the same `Int64()`
and only then rejects a negative.

Note that a mixed-type comparison such as `n >= 7`, `n == 7` or
`n in [1, 7, 9]` on a `uint` parameter is **refused by OpenFGA at
model-write time**, so those cells are unreachable in a valid
model.

Exact comparison past 2^53 and saturation at the int64 bounds
agree. Overflow *past* those bounds agrees only where cel-js
checks it — binary `+`, `-` and `*` on ints, and `-` on uints.
Four operations upstream checks and cel-js does not are pinned;
see the next section.

### Known divergence: unchecked CEL operators

cel-go range-checks every arithmetic and conversion overload;
cel-js checks binary `+`, `-` and `*` on ints and `-` on uints.
tsfga closes the gap wherever the operation has a **name** —
`int()` and `double()` are renamed onto range-checked
implementations, because cel-js refuses to replace a built-in
overload and renaming the call is the way around that. An
**operator** cannot be closed the same way: a renamed operator is
type-blind at rewrite time, so its replacement would have to
reimplement CEL's arithmetic and comparison for bigint, double,
string, duration and timestamp alike, moving semantics tsfga
inherits for free into tsfga's own code where they can drift.

| expression | context | OpenFGA | tsfga |
|---|---|---|---|
| `-n > 0` | `n = int64min` | refused | `true` |
| `n / -1 > 0` | `n = int64min` | refused | `true` |
| `d + duration('2400000h') > d` | `d = 2400000h` | refused | `true` |
| `duration('-2400000h') - d < d` | `d = 2400000h` | refused | `true` |
| `s < '\u{1F600}'` | `s = U+1F600` | `false` | `true` |

The first four are the **granting** direction — upstream declines
to answer and tsfga returns `true` — which makes them the least
comfortable pins in the suite. The fifth is string ordering: Go
compares UTF-8 bytes, JavaScript compares UTF-16 code units, and
only a comparison crossing the surrogate range can disagree. All
five are pinned two-sided in
`tests/conformance/a2-cel-numeric.test.ts`, and all five close if
`@marcbachmann/cel-js` gains a way to replace a built-in overload.

### Known divergence: sub-millisecond timestamps

Go's `time.Time` is nanosecond-resolution; cel-js maps a CEL
timestamp onto a JS `Date`, which is millisecond. Anything finer
is discarded silently — from the context value and from the
`timestamp('…')` literal alike — and both engines still answer,
so the booleans differ:

| expression | context `n` | OpenFGA | tsfga |
|---|---|---|---|
| `n == timestamp('…T00:00:00Z')` | `…00.000000001Z` | `false` | `true` |
| `n == timestamp('…T00:00:00Z')` | `…00.000001Z` | `false` | `true` |
| `n > timestamp('…T00:00:00Z')` | `…00.0005Z` | `true` | `false` |
| `n > timestamp('…00.000000000Z')` | `…00.000000500Z` | `true` | `false` |

The first two rows are the granting direction. Everything at
millisecond resolution or coarser agrees, so a condition that
compares whole seconds, minutes or dates — which is what an
expiry or a business-hours window is — is unaffected. All four
cells and both boundary controls are pinned two-sided in the
conformance suite.

Like the unchecked operators above, this one was found
unreachable rather than judged too costly. `@marcbachmann/cel-js`
8.0.0
declines to displace its own `timestamp(string)` overload, and
its standard library cannot be turned off, so the literal side of
the comparison truncates whatever a custom carrier held. It will
close if cel-js changes its timestamp representation.

### Known divergence: recursive relations

OpenFGA has dedicated resolvers for *recursive* relation shapes
— a relation assignable to a userset of itself
(`define member: [user, group#member]`), or a TTU that recurses
on its own relation (`define viewer: [user] or viewer from
parent`). Those walk the reachable set iteratively, so a loop in
the data resolves to a definitive `false` with no cycle flag.
tsfga has a single recursive resolver and reports indeterminacy
there instead.

The only observable consequence is the subtract side of a
`but not`: given a looping recursive relation on the subtract
side and a base that grants, OpenFGA returns `true` and tsfga
returns `false`. Every other position agrees, because a plain
`false` and a cycled `false` behave identically there. tsfga is
the more conservative of the two — it denies where OpenFGA
grants — but this is a divergence, not a design choice, and it
will close if the recursive resolvers are implemented.

## Breadth limits

Branches of one resolution node are evaluated concurrently,
bounded by `maxBreadth` (default 10, via the same options
object as `maxDepth`). The default matches OpenFGA's default
`OPENFGA_RESOLVE_NODE_BREADTH_LIMIT` (10); pass
`maxBreadth: Infinity` to restore unbounded fanout. Bounding
breadth caps how many concurrent store reads a single wide node
can issue, which is useful to avoid saturating a connection pool.
It almost never changes the answer — see the exception below.
When several branches fail, which branch's error surfaces
depends on completion order — the same nondeterminism OpenFGA
has. Branches still queued when a node settles are never
started. `maxBreadth` must be an integer >= 1 or `Infinity`;
anything else throws `TsfgaError`.

**The exception: a cycle reaching an intersection operand.** An
intersection denies as soon as one operand fails to hold, and two
kinds of operand fail to hold — a definitive `false` and a branch
truncated by a cycle. The first to arrive decides, and it carries
its own indeterminacy out with the denial. One level up that
matters: on the subtract side of a `but not`, a cycle denies and a
plain `false` does not. So on a model where a cycle reaches an
intersection operand, which operand wins the race can change the
final answer, and breadth is what decides whether the operands
race at all.

This is upstream's behaviour, not a tsfga quirk: OpenFGA's
intersection short-circuits on the first `CycleDetected ||
!Allowed` outcome and propagates that outcome's flag, so its answer
tracks which operand is cheaper to resolve and its own concurrency
limit has the same exposure. Preferring the definitive `false`
would be deterministic and would diverge from OpenFGA — granting
where it denies. Matching upstream means racing as it races.
`tests/conformance/intersection-cycle-precedence.test.ts` pins both
directions against a live OpenFGA.

`maxBreadth` also bounds how many `listObjects` candidates are
checked at once — the same knob deliberately, following
upstream, whose ListObjects worker pool is sized at
`1 + resolveNodeBreadthLimit`.

**Breadth buys parallelism only if the store can execute
concurrently.** On a single pooled PostgreSQL connection — the
normal case for a request-scoped store, and unavoidable for one
bound to an open transaction — the driver serialises, so raising
breadth buys queueing rather than parallelism. It no longer costs
extra *work*: concurrent routes into the same node coalesce onto
one resolution (see below), so breadth is not a duplication
multiplier. But if your store cannot resolve reads in parallel,
the default of 10 gains you little, and `maxBreadth: 1` is a
reasonable setting. Measure before changing it.

## One resolution per node

The check graph is a DAG, not a tree: the same
`(object, relation)` is commonly reached by several routes, and a
deep permission chain funnels every route through the same few
nodes near the root of the hierarchy.

Each node is resolved once per check, whichever route gets there
first. A route arriving after another finished reads the settled
result; a route arriving while another is still resolving waits
for it rather than starting again. Both are request-scoped: no
result outlives the call it was computed in, so a check never
answers from data older than itself.

Two kinds of result are deliberately *not* shared, because they
are properties of the route rather than of the node: a subtree
truncated by a cycle, and a subtree that threw. Both are
re-resolved by the next route, matching what upstream's cached
resolver does with a cycle-detected response.

## Abandoned branches stop reading

When a union finds its grant, the branches still in flight are no
longer needed. They stop at their next checkpoint — entering a
node, a tuple-to-userset lookup, a condition evaluation — instead
of walking their subtree and querying a store the caller believes
it is finished with.

The one read that cannot be called back is the one already handed
to the store: tsfga does not put a cancellation token into
`TupleStore`. So a store may still see **one** read per abandoned
branch land after `check()` resolves. If you instrument your
store, drain its counters before reading them, or you will bill
one call's reads to the next.

## checkMany

`check()` builds its resolution scope per call, so two checks in
the same request share nothing and each pays for the whole walk.
`checkMany` runs a batch of requests in one scope: the
relation-config cache and the node memo span the batch, so the
part of the graph they have in common — usually most of it — is
resolved once.

```ts
const [canView, canEdit] = await fga.checkMany([
  { objectType: "document", objectId: docId, relation: "viewer", ...subject },
  { objectType: "document", objectId: docId, relation: "editor", ...subject },
]);
// → [{ allowed: true }, { allowed: false }]
```

- **Answers are in request order**, one outcome per request.
  Upstream's BatchCheck keys an unordered map on a
  caller-supplied correlation id; the array position is the same
  thing, without asking you for one.
- **A failing check does not fail the batch.** Its error is
  reported as `outcome.error` and `allowed` is `false`, matching
  upstream. `checkMany` itself throws only for invalid options.
- **Identical requests cost one resolution.** They coalesce at
  their root node, which is what upstream achieves by
  de-duplicating a batch on a cache key before dispatching it.
- **Concurrency is `maxConcurrentChecks`** (default 50, matching
  `OPENFGA_MAX_CONCURRENT_CHECKS_PER_BATCH_CHECK`). It bounds
  whole checks; `maxBreadth` bounds the branches inside one. There
  is no cap on batch size — upstream's
  `OPENFGA_MAX_CHECKS_PER_BATCH_CHECK` guards a server's request
  handler, and a library holds nobody's socket.
- **Pass one `context` object**, not an equal copy per request.
  Requests are grouped into one scope per context by reference
  identity, because the node memo does not key on the context and
  requests resolving over different contexts must not share one.
- **The scope is bounded by the call**, so it is safe inside a
  transaction: a tuple written earlier in the same transaction is
  visible to it. This is why a shared scope is offered rather than
  a tuple cache — a cache would hide that write.

## listObjects

`listObjects` takes a request object — `objectType`, `relation`,
`subjectType`, `subjectId`, and optionally `context` and
`contextualTuples` — mirroring upstream's `ListObjectsRequest`.

Contextual tuples are applied once to the whole call rather than
once per candidate, so every candidate sees the same overlay and
the shared node memo below still holds. They are validated exactly
as `addTuple` validates a write, before any candidate is checked,
and the objects they name join the candidate pool: an object no
stored tuple mentions is still an answer if a contextual tuple
puts the subject on it.

Candidates come from `listCandidateObjectIds`, which is only a
pre-filter: every candidate still goes through a full `check`.
All of those checks share one relation-config cache and one node
memo for the whole call, so a subtree common to many objects —
the folder behind a thousand documents — is resolved once rather
than once per object, and each relation config is read once
rather than once per object.

The returned array is in candidate order, not completion order.
That is a tsfga determinism choice rather than parity; upstream
streams objects in whatever order its pool finishes them.

The target relation is gated **before** the candidate pool is
read: a relation the model does not define raises
`RelationConfigNotFoundError`, the same error `check`, `checkMany`,
`listSubjects` and `addTuple` raise, rather than depending on
whether any row happens to name an object of that type. Contextual
tuples are validated first, because upstream orders the two gates
that way and the order is observable.

An error in any candidate otherwise fails the whole call. Which
error surfaces is deterministic: it is the first failing candidate
in *candidate* order, not the first to fail in wall-clock order.
No candidate after a failure is started. The one exception is
`DepthExceededError`, which drops that candidate and keeps the
rest of the answer — see "Known divergence: `listObjects` past the
depth budget" above for why.

## Relation configs gate the reads

Each node of a check wants up to three things about its object and
relation: a direct tuple for the subject, a `type:*` wildcard
tuple, and the userset rows. They are asked for **in one store
call**, `findCheckTuples`, because they share an object, a
relation and a plan — three separate queries cost three
round-trips and, on a single-connection handle, three serialized
ones.

A part is left out of the query when the relation config says
nothing it could find would be valid:

| Part | Left out when |
|---|---|
| direct probe | `directlyAssignable` omits the subject type |
| wildcard probe | `directlyAssignable` omits `subjectType:*` |
| userset scan | `directlyAssignable` has no `type#relation` entry |

All three parts are narrowed rather than switched: the query
carries the restrictions the relation admits, so a relation
admitting `team#member` never asks for — and never expands — a
`team:eng#owner` row. The refs are a hint the store may use to
narrow its query; the guarantee is that the reply is re-clamped
against the same list, so a store that over-returns loses rows
rather than smuggling them past the model.

`null` and `[]` are opposites on all three: `null` declines to
narrow, `[]` excludes the part. Core no longer sends `null` — a
relation with no config is refused before anything is read, so
every query carries the relation's own restrictions — but the
fields stay nullable, because "I did not narrow this part" is a
statement a wrapper may still need to make about a query it
forwards.

### The gate is wider than the clamp, deliberately

The restriction's condition is matched too, and that splits what
used to be one predicate in two. The read gate runs *before* the
row exists and the condition lives *on* the row, so the gate can
only match the subject's shape — type, wildcard, userset relation
— and asks for every restriction of that shape, conditioned or
not. `clampToQuery` then performs the exact four-field match on
the reply, before the check algorithm sees a row.

So the invariant is not that the read gate and the write gate
agree. It is:

```
readGate ⊇ writeGate     and     clamp ≡ writeGate
```

The ordering is externally observable rather than a matter of
taste: a row the model does not admit must be dropped before
anything evaluates its condition, or a missing context parameter
raises where OpenFGA answers `false`.

With all three ruled out there is nothing to ask, and the node
skips the store entirely — it still resolves through its rewrites.
That is how a purely computed relation is expressed: an empty
`directlyAssignable` says the relation admits nothing directly,
and no read is issued.

A part is left out only on a *positive* exclusion. A relation with
no config at all is not read at all: `check` raises
`RelationConfigNotFoundError` for it, exactly as `addTuple` does,
rather than reading the absence as "unrestricted". The gate is
the same predicate `addTuple` applies, so a tuple that can be
written is always a tuple that can be found.

**This makes relation configs load-bearing rather than
advisory.** A tuple written straight to the database, bypassing
`addTuple`, or left behind by a relation that has since narrowed
its type list, is no longer found by `check` — it is treated as
the invalid row it is. Previously it would have granted access.
This matches OpenFGA, whose reads are typed and which rejects
such a tuple at write time; the failure direction is closed, not
open.

The config for a relation is read once per request and cached, so
this ordering costs one round-trip per relation, not per node.

### Applying the same gate yourself

`admitsSubjectRef` and `directSubjectRef` are exported so a
consumer narrowing their own query can apply the gate tsfga
applies rather than reimplementing it and drifting out of step.

```typescript
import { admitsSubjectRef, directSubjectRef } from "@tsfga/core";
```

<!-- sample: gate-predicate -->
```typescript
const config = await store.findRelationConfig("document", "viewer");
// No config means the model does not define the relation, which
// `check` refuses rather than treats as unrestricted. The
// predicate takes it non-null so the same decision is yours to
// make here.
if (config === null) throw new Error("document.viewer is not configured");
// The fourth argument is the condition name. Passing null asks
// whether the relation admits `team#member` *unconditioned* --
// a relation admitting only `team#member with in_hours` will
// say no, which is the answer `check` gives too.
admitsSubjectRef(config, directSubjectRef("team", "eng", "member", null));
```

Two things to know before relying on it:

- **The config is not optional.** It used to be, answering `true`
  for `null` because that is what `check` did. Both are gone:
  `check` raises `RelationConfigNotFoundError` on a relation with
  no config, so the misspelled relation name that used to make the
  filter silently admit everything is now a `null` the compiler
  makes you handle.
- **It filters tuple *shapes* only.** It knows nothing of
  `excludedBy` or `intersection`, which revoke a grant after the
  row is read. A row it admits is one `check` will *consider*, not
  one `check` will allow. There is no substitute for `check`.

## Listing subjects

`listSubjects` applies the same type restrictions, so a subject it
reports is one `check` could act on rather than merely one that is
stored. Narrowing a relation does not revalidate the tuples
already written, so inadmissible rows are an ordinary state to be
in, and reporting them was a divergence: OpenFGA filters in Expand
and ListUsers for the same reason.

A relation with no config raises `RelationConfigNotFoundError`
here too, rather than reporting every stored row. `check` refuses
such a relation, and a `listSubjects` that reported subjects
`check` will not act on is the same divergence in the granting
direction.

The consequence is worth stating plainly: **there is no library
path that finds an inadmissible row in order to delete it.**
Upstream keeps `Read` unfiltered for exactly that reason. Until a
maintenance read exists, removing such rows means going to the
store directly.

`listObjects` is deliberately *not* gated at the candidate stage.
It re-checks every candidate through the gated path, so
over-returning candidates costs work and cannot grant, whereas
under-returning would silently drop objects the subject can
really reach.

## Contextual tuples

Contextual tuples passed on a `CheckRequest` are validated
against relation configs with the same rules as `addTuple`: the
relation config must exist, and the subject ref — the bare type,
`type:*` for a wildcard subject, or `type#relation` for a userset,
each with the tuple's condition — must appear in
`directlyAssignable`. Invalid contextual tuples throw
`RelationConfigNotFoundError`, `InvalidSubjectTypeError` or
`InvalidConditionalTupleError`.

### What an error message says, and what it does not

`InvalidSubjectTypeError` names the subject that was refused and
the relation that refused it, and nothing else. It does **not**
enumerate what the relation admits, because `addTuple`'s errors
are the ones a service is most likely to hand back to whoever
attempted the write, and that list describes the authorization
model: every admitted type, every userset relation, every
condition name. OpenFGA names only the offending type.

The list is still reachable, on the error rather than in the
string:

| field | what it holds |
|---|---|
| `subject` | the subject ref the write named |
| `objectType`, `relation` | what refused it |
| `allowed` | every `TypeRestriction` the relation admits |

## Write-time model validation

OpenFGA validates a whole model when it is written. tsfga has no
model document, so the same rules are applied where the pieces
arrive.

`writeRelationConfig` throws `InvalidRelationConfigError`, with
the reason on `.cause`:

| cause | meaning |
|---|---|
| `intersection has fewer than two operands` | a set operation with one child or none; upstream: "as intersection has less than 2 children" |
| `undefined condition` | a type restriction names a condition the store has not got |
| `tupleset relation admits a userset` | the relation a tuple-to-userset reads is assignable to `type#relation` |
| `tupleset relation admits a wildcard` | that relation is assignable to `type:*` |
| `tupleset relation is not a direct relation` | the relation named as `tupleset` rewrites at all; upstream requires its rewrite to be exactly `This` |
| `type restrictions on a non-assignable relation` | `directlyAssignable` is non-empty on a relation whose `intersection` has no `direct` operand |
| `relation admits nothing and rewrites nothing` | the relation can never grant |
| `relation has no entrypoint` | the closed self-cycle form; see below |

Three of those read as stronger than they are without a
qualifier:

- **`relation admits nothing and rewrites nothing` is not
  "`directlyAssignable: []` is refused".** An empty list beside a
  rewrite is how a purely computed relation is spelled. The defect
  is an empty list with *no* rewrite either.
- **`type restrictions on a non-assignable relation` fires only
  against an `intersection` with no `direct` operand.** The
  converse is ordinary: `directlyAssignable` beside `impliedBy`,
  `computedUserset`, `tupleToUserset` or `excludedBy` is
  upstream's `union(This, …)` and `difference(This, …)`, both
  valid.
- **`relation has no entrypoint` is the closed case only.** An
  entrypoint is a whole-model property, and upstream decides it
  over one document. A single config decides only the relation
  whose *sole* arm is a tuple-to-userset onto **itself**, over a
  tupleset admitting its own object type and nothing else
  (`define viewer: viewer from parent`, `parent: [doc]`). Any
  second arm is an entrypoint, and a tupleset admitting some other
  type is not a cycle — that type's relation may have one. The
  general rule stays open.

`RelationConfigDefect` also declares `computed relation undefined
on every tupleset type` and `undefined relation`. **Nothing raises
either yet**, for the reason in the gap below; they are declared
so the union does not change shape when a whole-model validator
arrives.

The first two causes were fail-open: a single-operand intersection
resolved to whatever that operand said, and a tupleset relation
admitting a userset had its subject relation discarded on
dispatch, landing on a different relation of the linked object and
granting.

**The last two have a stated gap.** They are properties of a
*different* relation than the one being written — the one named as
`tupleset` — so they can only be checked when that relation's
config already exists. A tuple-to-userset declared **before** its
tupleset relation is not validated, and neither is a later
widening of that relation. Closing either would need a reverse
lookup (*which configs name me as a tupleset?*) that `TupleStore`
does not have. A validator that fired on write order would be
worse: it would refuse correct models for arriving in an order
nothing documents. Conditions have no such gap — define them
before the configs that name them, which is the order upstream's
atomic model write imposes anyway.

**Two further rules are open for a harder version of the same
reason.** Upstream also refuses a rewrite naming a relation the
object type does not define, and a tuple-to-userset whose computed
relation **no** tupleset type defines. Neither can be decided from
one config: for a forward reference the premise is *always*
absent, so the "skip when the premise is not yet written" rule
above degenerates into never checking, while checking strictly
refuses correct models. Both rules were implemented warn-only and
run over the whole conformance corpus: they fire on 43 config
writes that are not defects, every one an ordinary model whose
relations are written in definition order rather than dependency
order (`viewer: a but not banned` before `banned`; `blocked:
nblocked from parent` before `nblocked`). Both belong to a
validator that sees the whole model at once — a batch config write
— and until there is one, the mistake is reported at check time
instead, where it raises `RelationConfigNotFoundError` and blames
the request rather than the model.

`addTuple` throws `ImplicitTupleError` for a tuple that says only
what the model already says — `doc:1#blocked@doc:1#blocked`.
Upstream refuses it: "cannot write a tuple that is implicit".

**On the write path only.** The same tuple supplied as a
*contextual* tuple is accepted upstream and answered over, so the
gate is deliberately not in the validation `addTuple` and
contextual tuples share. Both halves are pinned two-sided.

## Write-time condition validation

`writeConditionDefinition` compiles the expression and throws
`ConditionCompileError` when it does not parse. OpenFGA compiles
every condition while validating the model write that carries it,
so an expression that cannot be parsed never reaches a check
there; without this it was accepted three times over — the
definition write, every tuple write beneath it, and every check
until someone ran one.

Compilation is parse-only. OpenFGA also type-checks the
expression against its declared parameters and refuses, for
example, `not_a_function(x)`; cel-js parses that and fails only
when it is evaluated, so tsfga accepts the definition and raises
a `ConditionEvaluationError` at check time. Pinned two-sided in
`tests/conformance/condition-compile.test.ts`.

`addTuple` refuses a tuple whose condition the model cannot
accept, with the cause on `InvalidConditionalTupleError.cause`:

| cause | meaning |
|---|---|
| `condition is missing` | no condition, and every matching restriction has one |
| `invalid condition for type restriction` | a defined condition this relation does not name |
| `undefined condition` | no such condition in the store |
| `parameter type error` | a context value not readable as its declared type |
| `invalid context parameter` | a context key the condition does not declare |
| `context contains forbidden characters` | a Unicode control character in a context key, in a string value at any depth, or in the condition name |
| `context size limit exceeded` | a condition context over `writeContextByteLimit` |

Only the context keys actually **present** are validated. A
conditioned tuple with no context, or a partial one, is accepted:
the rest can arrive with the check request.

A tab is a control character and is refused — worth stating,
since it is the one a caller might send without meaning anything
by it. The name is scanned before the definition is looked up, so
a dirty condition name reports the characters rather than
"undefined condition", which is upstream's order.

The size rule has two qualifications. **It is upstream's rule but
not upstream's measure:** upstream sizes a serialised protobuf
`Struct` against `DefaultWriteContextByteLimit` (32 KiB); tsfga
sizes the UTF-8 bytes of the context's JSON, which cannot be made
exact, so the two agree except within a narrow band of the
boundary. The limit is `writeContextByteLimit` on `CheckOptions`,
defaulting to the exported `DEFAULT_WRITE_CONTEXT_BYTE_LIMIT`.
**And it applies to `addTuple` only:** upstream enforces it in the
Write command and nowhere else, so a check request whose
contextual tuple carries a large context is answered, not refused.

A conditioned write costs one extra round-trip — the
condition-definition lookup — so 3 rather than 2. Unconditioned
writes are unchanged. That is deliberate and uncached: a
client-lifetime cache on a *validation* gate goes stale across
processes, and would keep accepting tuples after another instance
narrowed the model.

## Duplicate writes

`addTuple` throws `DuplicateTupleError` when the tuple is already
stored — upstream's `on_duplicate` default of `"error"`. It used
to upsert.

The natural key is upstream's `TupleKeyWithoutCondition`: object
type, object id, relation, subject type, subject id, subject
relation. **The condition is not part of it.** Re-granting a live
edge under a different condition is therefore a duplicate, not a
second row, and the way to change a grant's condition is
`removeTuple` then `addTuple`, in that order — which is what
OpenFGA requires. The upsert was silent and widened as readily as
it narrowed: dropping a condition turned a time-boxed grant
permanent.

Upstream's `on_duplicate: "ignore"` opt-in is not offered. A
caller that wants the old absorb-the-duplicate behaviour catches
`DuplicateTupleError` and ignores it.

### Malformed subjects

A subject ref that is not well formed at all — `team:*#member`, a
wildcard id carrying a subject relation — raises
`InvalidSubjectTypeError` with `cause: "malformed subject"`,
**before** the type gate, because upstream refuses it in
`ValidateUser` before any type restriction or condition is
consulted and the order is observable. It presented as the userset
`team#member` before, so a relation admitting `team#member`
accepted it and stored a row no model can describe. When the cause
is set the message takes a different form — `Invalid subject for
<type>.<relation>: malformed subject` — because rendering the
shape would print `team#member` and name a userset the caller did
not write. For every other refusal the cause is `undefined` and
the message is unchanged.

## TupleStore interface

The `TupleStore` interface is the extension point for custom
database adapters. The core check algorithm depends only on
this interface — it has no database dependencies.

Its read surface is deliberately shaped around what a check
actually asks for, not around individual predicates. The one to
understand when writing an adapter is `findCheckTuples`: it takes
a `CheckTuplesQuery` (the node, plus which restrictions each of
the three parts may be served under) and returns a `CheckTuples`
(`direct`, `wildcard`, `usersets`). Both types are exported.
Serving it as one query is the single largest thing an adapter
can do for check latency; an implementation may run three
instead, and simply gives that up.

The `directRefs`, `wildcardRefs` and `usersetRefs` fields exist so
a store can **narrow** its query — that is where the saving is.
Each carries the type restrictions the relation admits for that
part, so a row the model cannot admit need never be fetched. On
all three, `null` declines to narrow and `[]` excludes the part
outright; reading `[]` as "no filter" answers a query that asked
for nothing with a full scan.

They are a hint, not a trust boundary: `check` re-clamps every
reply against the query it sent — the exact match on type,
subject relation *and* condition — so returning a part that was
not asked for, or a row under a restriction the relation does not
admit, or filing a row under the wrong slot, loses that row. An
adapter bug cannot widen what the model admits, only lose grants
it should have found.

On the write side, `insertTuple` **inserts and reports**: it
returns `true` when a row was written and `false` when the natural
key already existed, and on `false` nothing may be written — the
stored row keeps the condition and the context it already had. It
used to mean upsert, and a store that can only upsert cannot
implement upstream's default; `TsfgaClient.addTuple` turns the
`false` into `DuplicateTupleError`.

Slots are exact. `direct` is the tuple for this subject with no
subject relation, `wildcard` the one for `subjectType:*` likewise,
and every row in `usersets` has a subject relation. A minimal
correct implementation may leave every field `null` and return
all three parts; it just gives up the saving.

See
[`src/store-interface.ts`](src/store-interface.ts)
for the full interface definition.

[`@tsfga/kysely`](../kysely/README.md) provides the included
PostgreSQL adapter.

## Conditions

CEL condition evaluation is supported via
[`@marcbachmann/cel-js`](https://github.com/nicholasgasior/cel-js).
Tuples can reference named condition definitions, and the
check algorithm evaluates them automatically.

Context merge rule: tuple context properties take precedence
over request context properties (matching OpenFGA behavior).

**`matches()` reads its pattern as RE2, not as a JavaScript
`RegExp`.** Upstream is cel-go, so the dialect is Go's `regexp`,
and the two are not a superset of one another. The pattern is
translated before it reaches a `RegExp`:

- the leading inline flags `(?i)`, `(?s)`, `(?m)` become
  JavaScript flags, and `(?U)` inverts every quantifier's
  greediness;
- `(?P<name>` becomes `(?<name>`;
- the POSIX classes (`[[:alpha:]]`, `[[:digit:]]`, …) expand, and
  `\pL` becomes `\p{L}`, compiled with the `u` flag — without
  which a `RegExp` reads it as a literal `p` and the grant
  silently disappears;
- the constructs RE2 does not accept — lookahead, lookbehind and
  backreferences — are **refused**, which is what upstream does,
  rather than matched.

Everything else passes through. Two forms are refused rather than
translated because no faithful JavaScript spelling exists: an
inline flag group that is not at the start of the pattern
(`a(?i)b`), which scopes differently in the two dialects, and a
negated POSIX class (`[[:^alpha:]]`). Both are refusals, not wrong
answers.

No RE2 engine is involved. A native binding such as `node-re2`
would break the Node, Deno and smoke matrix those test
directories exist to hold.

`string(duration)` and `string(timestamp)` are absent from cel-js
and registered by tsfga, formatted as cel-go formats them: total
seconds with an `s` suffix (`3600s`, `1.5s`, `-90s`), and RFC 3339
with the trailing zeros of the fractional second trimmed. The
timestamp side inherits the sub-millisecond boundary documented
above — a JS `Date` cannot carry the nanoseconds cel-go would
print, so agreement holds at millisecond resolution.

Compiled CEL expressions are cached by expression source text
(content-keyed). Redefining a condition via
`writeConditionDefinition` therefore takes effect on the next
evaluation — there is no per-name cache to go stale — and
identical expressions share one compiled entry. The cache holds a
thousand entries and evicts the least recently used, so a caller
that keeps rewriting condition definitions does not grow it
without limit.

## License

MIT
