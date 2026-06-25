import { defineTable } from "convex/server";
import { v } from "convex/values";

export const auditTables = {
  audit_log: defineTable({
    actor_id: v.union(v.id("staff"), v.literal("system")),
    action: v.string(),
    entity_type: v.string(),
    entity_id: v.optional(v.string()),
    before_state: v.optional(v.string()),
    after_state: v.optional(v.string()),
    device_id: v.optional(v.string()),
    mgr_approver_id: v.optional(v.id("staff")),
    source: v.union(
      v.literal("booth_inline"),
      v.literal("wa_approval"),
      v.literal("telegram_approval"),
      v.literal("system"),
      v.literal("reaper"),
      v.literal("cockpit"),   // v1.3.0 owner cockpit — owner-initiated writes (no device, no booth)
    ),
    reason: v.optional(v.string()),
    metadata: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_actor_date", ["actor_id", "created_at"])
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_action_date", ["action", "created_at"])
    .index("by_source_date", ["source", "created_at"]),
};
