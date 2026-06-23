import { defineTable } from "convex/server";
import { v } from "convex/values";

export const ownerAuthTables = {
  owner_auth_otp: defineTable({
    staff_id: v.id("staff"),
    code_hash: v.string(),
    expires_at: v.number(),
    fail_count: v.number(),
    consumed_at: v.union(v.number(), v.null()),
    created_at: v.number(),
    device_id: v.string(),
  })
    .index("by_staff_active", ["staff_id", "consumed_at"])
    .index("by_expires", ["expires_at"]),

  owner_auth_bindings: defineTable({
    kind: v.union(v.literal("telegram_bind"), v.literal("remember_device")),
    staff_id: v.id("staff"),
    token_hash: v.string(),
    expires_at: v.number(),
    redeemed_at: v.union(v.number(), v.null()),
    created_at: v.number(),
    device_id: v.optional(v.string()),
    quick_pin_hash: v.optional(v.string()),
  })
    .index("by_token_hash", ["token_hash"])
    .index("by_staff_kind", ["staff_id", "kind"])
    .index("by_expires", ["expires_at"]),

  owner_auth_attempts: defineTable({
    staff_id: v.id("staff"),
    request_count: v.number(),
    window_start_at: v.number(),
    locked_until: v.union(v.number(), v.null()),
  }).index("by_staff", ["staff_id"]),
};
