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
    must_change_pin: v.optional(v.boolean()), // SEC-03: forced rotation after bootstrap default
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

  // SEC-04: brute-force throttle for /activate device-setup-code entry.
  // device-scoped rows key on device_id; one singleton row keys on the sentinel
  // "__global__" for the rolling-window ceiling (an attacker picks device_id, so
  // per-device alone is bypassable — the global cap is load-bearing).
  pos_device_activation_attempts: defineTable({
    key: v.string(),               // device_id OR "__global__"
    fail_count: v.number(),
    window_start_at: v.number(),   // global: rolling-window anchor
    locked_until: v.union(v.number(), v.null()),
    last_attempt_at: v.number(),
  }).index("by_key", ["key"]),

  registered_devices: defineTable({
    device_id: v.string(),
    label: v.string(),
    activated_by: v.optional(v.id("staff")), // optional v0.6: Telegram-issued codes have no staff issuer
    activated_at: v.number(),
    last_seen_at: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_device_id", ["device_id"])
    .index("by_active", ["active"]),

  pending_device_setups: defineTable({
    setup_code: v.string(),
    issued_by: v.optional(v.id("staff")), // optional v0.6: absent for Telegram-issued codes
    issued_via: v.optional(
      v.union(v.literal("booth_inline"), v.literal("telegram")),
    ), // absent = booth (legacy rows)
    // Intentionally write-only for now: the same attribution is also captured in
    // the device.setup_code_issued audit metadata (the queried forensic trail).
    // Kept structured on the row for a future "who issued this pending code" UI;
    // remove if that never materializes.
    issued_by_telegram: v.optional(
      v.object({
        from_id: v.optional(v.number()), // optional: Telegram omits `from` for anonymous admins / channel posts
        chat_title: v.string(),
      }),
    ),
    expires_at: v.number(),
    consumed_at: v.union(v.number(), v.null()),
  })
    .index("by_code", ["setup_code"])
    .index("by_expires", ["expires_at"]),
};
