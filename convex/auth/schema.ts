import { defineTable } from "convex/server";
import { v } from "convex/values";

export const authTables = {
  staff: defineTable({
    name: v.string(),
    code: v.optional(v.string()), // NEW v0.2.1 — populated in Task F3, required in Task F6 (DEFERRED)
    pin_hash: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
    active: v.boolean(),
    preferences: v.optional(v.object({
      founders_share_on: v.optional(v.boolean()),
    })),
    created_at: v.number(),
    last_login_at: v.optional(v.number()),
  })
    .index("by_active", ["active"])
    .index("by_role", ["role"])
    .index("by_code", ["code"]),

  staff_sessions: defineTable({
    staff_id: v.id("staff"),
    device_id: v.string(),
    started_at: v.number(),
    ended_at: v.union(v.number(), v.null()),
    end_reason: v.union(
      v.literal("manual_lock"),
      v.literal("timeout"),
      v.literal("force_logout"),
      v.null(),
    ),
  })
    .index("by_staff_active", ["staff_id", "ended_at"])
    .index("by_device_active", ["device_id", "ended_at"]),

  pos_auth_attempts: defineTable({
    staff_id: v.id("staff"),
    fail_count: v.number(),
    locked_until: v.union(v.number(), v.null()),
    last_attempt_at: v.number(),
  }).index("by_staff", ["staff_id"]),

  registered_devices: defineTable({
    device_id: v.string(),
    label: v.string(),
    activated_by: v.id("staff"),
    activated_at: v.number(),
    last_seen_at: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_device_id", ["device_id"])
    .index("by_active", ["active"]),

  pending_device_setups: defineTable({
    setup_code: v.string(),
    issued_by: v.id("staff"),
    expires_at: v.number(),
    consumed_at: v.union(v.number(), v.null()),
  })
    .index("by_code", ["setup_code"])
    .index("by_expires", ["expires_at"]),
};
