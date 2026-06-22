// convex/migrations/schema.ts
//
// migration_state table — a durable cursor store for resumable, paginated
// data-backfill operations. Each migration run writes its last-seen page
// cursor here so it can resume after a timeout or transient failure without
// re-scanning already-processed rows.
//
// One row per named migration. The cursor is Convex's opaque paginate cursor
// string (or null when the migration starts fresh from the beginning of the
// table). `completed_at` is stamped when `isDone` flips true from paginate —
// the row stays for audit but the migration won't re-process rows.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const migrationsTables = {
  migration_state: defineTable({
    name: v.string(),         // stable migration identifier, e.g. "backfill_outlet_id"
    cursor: v.union(v.string(), v.null()), // last paginate cursor, null = start
    completed_at: v.optional(v.number()), // server-set when isDone = true
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_name", ["name"]),
};
