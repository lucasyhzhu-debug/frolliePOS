import { defineTable } from "convex/server";
import { v } from "convex/values";

export const refundsTables = {
  // ADR-008 refunds are NEW rows (never mutate paid txn status). One row per refund
  // event; multiple refunds against the same txn compose. Each row references the
  // subset of lines being refunded with per-line qty + already-floor-rounded amount
  // (computed via ADR-040 helper at commit time).
  pos_refunds: defineTable({
    transaction_id: v.id("pos_transactions"),
    lines: v.array(v.object({
      line_id: v.id("pos_transaction_lines"),
      qty: v.number(),                           // qty being refunded (≤ line.refundable)
      refund_amount: v.number(),                 // per-line, ADR-040 floor-rounded, integer rupiah
    })),
    total_refund: v.number(),                    // sum of lines[].refund_amount, integer rupiah
    reason: v.string(),                          // free-text from staff
    requested_by: v.id("staff"),                 // staff who initiated
    approver_id: v.id("staff"),                  // manager whose PIN authorised the refund
    approval_source: v.union(
      v.literal("booth_inline"),                 // mgr-at-booth PIN
      v.literal("telegram_approval"),            // off-booth via Telegram URL+PIN
    ),
    approval_request_id: v.optional(v.id("pos_approval_requests")),  // present for telegram path

    // Settlement (ADR-038) — money movement is manual in v1; this field tracks it.
    settlement_status: v.union(v.literal("pending"), v.literal("settled")),
    settled_by: v.optional(v.id("staff")),
    settled_at: v.optional(v.number()),

    created_at: v.number(),                      // server-set per ADR-031
  })
    // For receipt rendering: "get all refunds for this txn"
    .index("by_transaction", ["transaction_id"])
    // For /mgr/refunds-pending: list pending refunds oldest-first
    .index("by_settlement_status", ["settlement_status", "created_at"]),
};
