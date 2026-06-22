import { defineTable } from "convex/server";
import { v } from "convex/values";

export const receiptsTables = {
  // Rendered receipt HTML blob, 24h cache per ADR-022. Lazy-regenerate on miss
  // (no reaper cron — storage is cheap, the cron would be ceremony). Token is
  // the lookup key (also lives on pos_transactions.receipt_token); HTML is the
  // value; expires_at is when the cache is stale and should regenerate.
  pos_receipt_html_cache: defineTable({
    token: v.string(),
    html: v.string(),
    expires_at: v.number(),                      // created_at + 24h, server-set per ADR-031
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Stream 2: optional; no new scan index (token globally unique; outlet for purge scoping)
  })
    .index("by_token", ["token"]),  // GLOBAL_UNIQUE — keep
};
