import { type Kysely, sql } from "kysely";

/**
 * Widens `tsfga.tuples.subject_id` from `uuid` to `text`, deleting
 * the nil-UUID wildcard sentinel.
 *
 * The public wildcard subject is the literal `"*"`, but a `uuid`
 * column cannot hold it, so the adapter stored it as the nil UUID
 * and mapped it back on every read. That reserved a value the
 * library documented and nothing enforced: a tuple written for a
 * real subject whose id happens to be
 * `00000000-0000-0000-0000-000000000000` landed in the wildcard's
 * slot, read back as `"*"`, and granted the relation to *every*
 * subject of its type — while the subject it was written for
 * stopped matching it. Upstream reserves no id at all; only the
 * literal `*` is a wildcard.
 *
 * A validation guard cannot fix this. OpenFGA accepts the write,
 * so refusing it is a second divergence rather than a fix. The
 * only representation with no reserved value left to document is
 * one where `"*"` is stored as itself.
 *
 * `object_id` deliberately stays `uuid`. tsfga still cannot carry
 * a non-UUID object id — a real but separate parity question, and
 * widening it here would grow this migration past the bug it
 * fixes.
 *
 * PostgreSQL rewrites the table and rebuilds every index naming
 * the column, including `idx_tuples_unique`'s
 * `COALESCE(subject_relation, '')` expression index and
 * `idx_tuples_subject`, so neither has to be dropped and recreated
 * by hand.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // `uuid` has an assignment cast to `text`, so the builder's
  // plain `ALTER COLUMN … TYPE text` is accepted — no `USING`, and
  // no raw SQL, is needed in this direction.
  await db.schema
    .alterTable("tsfga.tuples")
    .alterColumn("subject_id", (col) => col.setDataType("text"))
    .execute();
}

/**
 * **Not data-preserving, by construction.** `text` admits every id
 * `uuid` admits and more: the wildcard `"*"`, and any id a caller
 * wrote once the column stopped rejecting it. There is no honest
 * automatic conversion for those — mapping `"*"` back onto the nil
 * UUID would reinstate the collision this migration exists to
 * delete, and inventing a UUID for any other id would rewrite a
 * grant to name a subject nobody authorized.
 *
 * So the rollback casts and lets PostgreSQL refuse: any row whose
 * `subject_id` is not a UUID fails the whole statement. Failing on
 * a row the old shape cannot represent is the correct outcome —
 * such rows must be deleted or rewritten deliberately before
 * rolling back, and the error names them.
 *
 * Raw `sql` here because the cast is not an assignment cast in
 * this direction and Kysely's `alterColumn` builder cannot emit
 * the required `USING` clause.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tsfga.tuples
    ALTER COLUMN subject_id TYPE uuid USING subject_id::uuid
  `.execute(db);
}
