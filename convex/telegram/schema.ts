import { defineTable } from "convex/server";
import { v } from "convex/values";

export const telegramTables = {
  // POC: telegram_log is intentionally NOT prefixed with `pos_` — sandbox table
  // that gets replaced (or absorbed into pos_approval_requests) if/when the POC
  // graduates. See docs/superpowers/specs/2026-05-25-telegram-poc-design.md.
  telegram_log: defineTable({
    direction: v.union(v.literal("out"), v.literal("in")),
    template_kind: v.optional(v.string()),
    payload_json: v.string(),
    update_id: v.optional(v.number()),
    callback_data: v.optional(v.string()),
    from_user: v.optional(v.string()),
    message_id: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_update_id", ["update_id"])
    .index("by_created_at", ["created_at"]),
};
