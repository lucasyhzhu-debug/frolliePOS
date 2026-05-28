import { defineTable } from "convex/server";
import { v } from "convex/values";

export const approvalsTables = {
  pos_approval_requests: defineTable({
    // v0.3 ships exactly one kind. v0.4 will add "refund", "manual_payment", etc.
    kind: v.union(v.literal("staff_pin_reset")),

    // What needs approving
    subject_staff_id: v.id("staff"),
    triggered_by_event: v.string(),              // "auth_lockout" in v0.3
    triggered_at: v.number(),

    // Token (authorizes VIEW per ADR-029)
    token_hash: v.string(),                      // sha256(rawToken) hex; raw token only ever in URL.
                                                 // SHA-256 (deterministic) — NOT argon2id — because we need
                                                 // index lookup by hash. Tokens are high-entropy (32 bytes),
                                                 // so salt-less hashing is fine. argon2id is for low-entropy
                                                 // passwords (per ADR-004); high-entropy tokens use SHA-256.
    token_expires_at: v.number(),                // triggered_at + 60min per ADR-029

    // Lifecycle (v0.3 ships exactly these states; v0.4 extends with "denied" when manager rejects
    // a refund or payment-override approval. Adding a v.literal to a union is forward-compatible.)
    status: v.union(
      v.literal("pending"),
      v.literal("resolved"),
      v.literal("expired"),
    ),
    notified_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_by_manager_id: v.optional(v.id("staff")),
  })
    .index("by_token_hash", ["token_hash"])
    .index("by_status_triggered", ["status", "triggered_at"])
    .index("by_subject_staff", ["subject_staff_id"]),
};
