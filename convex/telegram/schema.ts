import { defineTable } from "convex/server";
import { v } from "convex/values";

export const telegramTables = {
  // Outbound debug-trail. audit_log is authoritative for compliance; this is
  // a forensic convenience for replaying sent payloads while debugging a bad
  // template render. NOT the dedupe source (telegramUpdates) nor the approval
  // linkage (pos_approval_requests.telegram_message_id). Purged after 30 days
  // by the telegram-log-purge cron (crons.ts).
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

  // ── Self-registration registry (v0.4) ─────────────────────────────────────
  // One row per Telegram chat that has sent /register@<bot>.
  // Ported verbatim from convex-telegram-bot-starter/convex/schema.ts.
  telegramChats: defineTable({
    chatId: v.string(),
    chatType: v.union(
      v.literal("private"),
      v.literal("group"),
      v.literal("supergroup"),
    ),
    title: v.string(),
    role: v.optional(v.string()),
    registeredBy: v.optional(v.number()),
    registeredAt: v.number(),
    lastSeenAt: v.number(),
    archivedAt: v.optional(v.number()),
    lastError: v.optional(v.object({ at: v.number(), message: v.string() })),
  })
    .index("by_chatId", ["chatId"])
    .index("by_role_archived", ["role", "archivedAt"]),

  telegramUpdates: defineTable({
    updateId: v.number(),
    receivedAt: v.number(),
  })
    .index("by_update_id", ["updateId"])
    // by_received_at: powers the daily purge cron (telegram/internal._purgeOldTelegramUpdates_internal)
    // — bounds the scan to rows older than the 7-day TTL.
    .index("by_received_at", ["receivedAt"]),
};
