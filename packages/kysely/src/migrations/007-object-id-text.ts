import { type Kysely, sql } from "kysely";

/**
 * Widens `tsfga.tuples.object_id` from `uuid` to `text`, so an
 * object id is compared as the opaque string upstream compares.
 *
 * A `uuid` column does not store the id it was given: PostgreSQL
 * parses it and canonicalises it. `doc:…D4C0…` and `doc:…d4c0…`,
 * and the hyphenless spelling of either, are three writes and one
 * row — while upstream stores three distinct objects, because
 * `SplitObject` slices at the first `:` and keeps the rest
 * verbatim. Both engines accept all three writes, so tsfga then
 * answered `true` where OpenFGA answers `false`: a widening in the
 * granting direction that no caller can see. An id reaching tsfga
 * from two sources that disagree about UUID casing silently merged
 * two objects' grants.
 *
 * Migration `006` made the same argument for `subject_id`. This is
 * the other half of it, deferred then to keep `006`'s blast radius
 * on the bug it fixed.
 *
 * It also retires the "object ids must be UUID-formatted"
 * limitation: an object id is now whatever string the caller
 * wrote, as upstream's is. What used to be a driver refusal for a
 * malformed id — a `DatabaseError`, not a `TsfgaError`, and inside
 * a transaction one that aborts every later statement — is now
 * `@tsfga/core`'s own write-path well-formedness rule.
 *
 * PostgreSQL rewrites the table and rebuilds every index naming
 * the column, `idx_tuples_unique`'s
 * `COALESCE(subject_relation, '')` expression index included, so
 * none has to be dropped and recreated by hand.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // `uuid` has an assignment cast to `text`, so the builder's plain
  // `ALTER COLUMN … TYPE text` is accepted — no `USING`, and no raw
  // SQL, is needed in this direction.
  await db.schema
    .alterTable("tsfga.tuples")
    .alterColumn("object_id", (col) => col.setDataType("text"))
    .execute();
}

/**
 * **Not data-preserving, by construction**, exactly as `006`'s
 * rollback is. `text` admits every id `uuid` admits and more: any
 * object id a caller wrote once the column stopped rejecting it.
 * There is no honest automatic conversion — inventing a UUID for
 * a non-UUID id would rewrite a grant to name an object nobody
 * authorized, and dropping such rows would revoke grants silently.
 *
 * So the rollback casts and lets PostgreSQL refuse: any row whose
 * `object_id` is not a UUID fails the whole statement. Failing on
 * a row the old shape cannot represent is the correct outcome —
 * such rows must be deleted or rewritten deliberately before
 * rolling back, and the error names them.
 *
 * Rolling back is lossy in a second way that no error can report:
 * ids that survive the cast are canonicalised, so two rows
 * differing only in casing collide on `idx_tuples_unique` and the
 * rollback fails on the duplicate instead.
 *
 * Raw `sql` here because the cast is not an assignment cast in
 * this direction and Kysely's `alterColumn` builder cannot emit
 * the required `USING` clause.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tsfga.tuples
    ALTER COLUMN object_id TYPE uuid USING object_id::uuid
  `.execute(db);
}
