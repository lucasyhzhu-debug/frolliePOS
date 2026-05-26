import { defineTable } from "convex/server";
import { v } from "convex/values";

export const idempotencyTables = {
  pos_idempotency: defineTable({
    key: v.string(),
    mutation_name: v.string(),
    staff_id: v.optional(v.id("staff")),
    response_blob: v.string(),
    expires_at: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expires", ["expires_at"]),
};
