import { defineTable } from "convex/server";
import { v } from "convex/values";

export const authTables = {
  staff: defineTable({
    name: v.string(),
    code: v.string(),  // stable staffCode S-NNNN; required since v1.1 (ADR-034, sync prereq)
    pin_hash: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager"), v.literal("owner")),
    active: v.boolean(),
    preferences: v.optional(v.object({
      founders_share_on: v.optional(v.boolean()),
    })),
    created_at: v.number(),
    last_login_at: v.optional(v.number()),
    must_change_pin: v.optional(v.boolean()), // SEC-03: forced rotation after bootstrap default
    // v1.2 #1 (i18n): per-staff UI language. Absent ⇒ English default (ADR-049).
    locale: v.optional(v.union(v.literal("en"), v.literal("id"))),
    // v2.0 (ADR-052): Telegram user ID for cockpit OTP delivery. Written by /start <token>.
    telegram_user_id: v.optional(v.number()),
  })
    .index("by_active", ["active"])
    .index("by_role", ["role"])
    .index("by_code", ["code"])
    .index("by_telegram_user_id", ["telegram_user_id"]),

  staff_sessions: defineTable({
    staff_id: v.id("staff"),
    device_id: v.string(),
    started_at: v.number(),
    ended_at: v.union(v.number(), v.null()),
    end_reason: v.union(
      v.literal("manual_lock"),
      v.literal("timeout"),
      v.literal("force_logout"),
      // v2.0 (ADR-052): owner cockpit "Sign out" — distinct from a booth device
      // lock so the session/audit trail doesn't conflate the two planes.
      v.literal("owner_logout"),
      v.null(),
    ),
    // v2.0 (ADR-052): absent ⇒ booth (legacy rows). Cockpit sessions have no outlet.
    kind: v.optional(v.union(v.literal("booth"), v.literal("cockpit"))),
    // v2.0 (ADR-052): cockpit idle anchor; absent for booth sessions.
    last_active_at: v.optional(v.number()),
    // [SPEC-1 AMENDMENT] stays optional — cockpit sessions are outlet-less.
    // Booth-must-have-outlet is enforced at runtime in requireSession.
    outlet_id: v.optional(v.id("outlets")),
  })
    .index("by_staff_active", ["staff_id", "ended_at"])
    .index("by_device_active", ["device_id", "ended_at"])
    .index("by_outlet_device_active", ["outlet_id", "device_id", "ended_at"]),

  pos_auth_attempts: defineTable({
    staff_id: v.id("staff"),
    fail_count: v.number(),
    locked_until: v.union(v.number(), v.null()),
    last_attempt_at: v.number(),
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Task 12: LEFT OPTIONAL — written by the failed-login counter pre-session (no session/outlet yet); audit context only; lockout is per-staff
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
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Task 12: LEFT OPTIONAL — devices activate UNBOUND (OQ4); a manager binds later via assignDeviceOutlet, so activateDevice cannot stamp an outlet
  })
    .index("by_device_id", ["device_id"])
    .index("by_active", ["active"])
    .index("by_outlet_active", ["outlet_id", "active"]),

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
