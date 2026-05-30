import { defineTable } from "convex/server";
import { v } from "convex/values";

export const approvalsTables = {
  pos_approval_requests: defineTable({
    // v0.3: "staff_pin_reset". v0.4 adds "manual_payment_override".
    kind: v.union(
      v.literal("staff_pin_reset"),
      v.literal("manual_payment_override"),   // NEW in v0.4
    ),

    // WHO asked (pin_reset is system-triggered → optional)
    requester_staff_id: v.optional(v.id("staff")),

    // WHAT is approved — generic entity pointer (ADR-030 shape)
    entity_type: v.optional(v.string()),
    entity_id: v.optional(v.string()),
    // back-compat: pin_reset keeps using subject_staff_id (now optional)
    subject_staff_id: v.optional(v.id("staff")),

    // per-kind context — VALIDATED by APPROVAL_KINDS[kind] before every insert.
    // schema-level v.any() is unavoidable for a shared column; the invariant is
    // enforced in _createRequest_internal (the single writer).
    context: v.optional(v.any()),
    reason: v.optional(v.string()),

    triggered_by_event: v.string(),
    triggered_at: v.number(),

    // Token (authorizes VIEW per ADR-029)
    token_hash: v.string(),                      // sha256(rawToken) hex; raw token only ever in URL.
                                                 // SHA-256 (deterministic) — NOT argon2id — because we need
                                                 // index lookup by hash. Tokens are high-entropy (32 bytes),
                                                 // so salt-less hashing is fine. argon2id is for low-entropy
                                                 // passwords (per ADR-004); high-entropy tokens use SHA-256.
    token_expires_at: v.number(),                // triggered_at + 60min per ADR-029

    // Lifecycle: pending → resolved | denied. "expired" is NOT a DB-row state —
    // it's a virtual status computed at read time when row.status === "pending"
    // && row.token_expires_at <= Date.now() (see approvals/public.getByToken,
    // getRequestStatus, getRecentPinResetForStaff). No mutation writes "expired",
    // so it is intentionally absent from this union — preventing a future
    // contributor from inserting a row in a state the lifecycle mutations would
    // refuse to act on (they would throw REQUEST_RESOLVED instead of
    // the user-expected TOKEN_EXPIRED). v0.4 adds "denied" for manager reject.
    status: v.union(
      v.literal("pending"),
      v.literal("resolved"),
      v.literal("denied"),
    ),
    notified_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_by_manager_id: v.optional(v.id("staff")),
    denied_at: v.optional(v.number()),                 // NEW in v0.4
    denied_by_manager_id: v.optional(v.id("staff")),   // NEW in v0.4
    deny_reason: v.optional(v.string()),               // NEW in v0.4

    // Telegram linkage (best-effort) — patched after notify
    notification_channel: v.optional(v.literal("telegram")),
    telegram_message_id: v.optional(v.number()),
    telegram_chat_id: v.optional(v.string()),
  })
    .index("by_token_hash", ["token_hash"])
    .index("by_status_triggered", ["status", "triggered_at"])
    .index("by_subject_staff", ["subject_staff_id"])
    .index("by_kind_status", ["kind", "status"]),   // NEW in v0.4
};
