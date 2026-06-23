import { defineTable } from "convex/server";
import { v } from "convex/values";

export const transactionsTables = {
  pos_transactions: defineTable({
    // Identity
    receipt_number: v.optional(v.string()),     // "R-YYYY-NNNN" — allocated at _confirmPaid only
    receipt_token: v.optional(v.string()),      // 32-byte URL-safe random; allocated at _confirmPaid; capability per ADR-021

    // Status (v0.3 states; v0.5 adds "voided" via refund row presence per ADR-008)
    status: v.union(
      v.literal("draft"),
      v.literal("awaiting_payment"),
      v.literal("paid"),
      v.literal("cancelled"),
    ),

    // Money (integer rupiah per ADR-015)
    subtotal: v.number(),
    voucher_code_snapshot: v.optional(v.string()),
    voucher_discount: v.number(),                // 0 if no voucher
    total: v.number(),                           // subtotal - voucher_discount

    // Bitset flags
    flags: v.number(),                           // see transactions/flags.ts

    // Provenance
    staff_id: v.id("staff"),
    xendit_invoice_id_current: v.optional(v.string()),  // Denormalized pointer to the active invoice. Canonical invoice store is pos_xendit_invoices (indexed by_xendit_invoice_id); no separate index here in v0.3 (dev-volume scans are negligible). null for draft.

    // Lifecycle (all server-set per ADR-031)
    created_at: v.number(),
    paid_at: v.optional(v.number()),
    cancelled_at: v.optional(v.number()),
    cancelled_reason: v.optional(v.string()),

    // Confirmation provenance (set at _confirmPaid)
    confirmed_via: v.optional(v.union(
      v.literal("webhook"),
      v.literal("polling"),
      v.literal("manual"),
      v.literal("manual_bca"),   // v1.2 #10 — staff self-confirm manual bank transfer
    )),
    confirmed_mgr_approver_id: v.optional(v.id("staff")),
    confirmed_manual_reason: v.optional(v.string()),
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced (was optional during migration window)
  })
    .index("by_status_created", ["status", "created_at"])   // ADR-026 reconciliation
    // by_status_paid_at scopes the founders shift-summary aggregate to paid rows
    // by paid_at (the field the summary is actually about). Replaces the prior
    // by_status_created + 1h-backstop approach, which silently dropped cross-
    // midnight late-paid sales (cart at 21:00 WIB N, paid 02:30 WIB N+1).
    .index("by_status_paid_at", ["status", "paid_at"])
    .index("by_receipt_number", ["receipt_number"])
    .index("by_receipt_token", ["receipt_token"])
    .index("by_staff_created", ["staff_id", "created_at"])
    .index("by_outlet_status_created", ["outlet_id", "status", "created_at"])
    .index("by_outlet_status_paid_at", ["outlet_id", "status", "paid_at"])
    .index("by_outlet_staff_created", ["outlet_id", "staff_id", "created_at"]),

  pos_transaction_lines: defineTable({
    transaction_id: v.id("pos_transactions"),
    product_id: v.id("pos_products"),
    product_code_snapshot: v.string(),
    product_name_snapshot: v.string(),
    unit_price_snapshot: v.number(),
    tax_rate_snapshot: v.number(),               // schema-ready per ADR-000 §4 (0 today)
    qty: v.number(),
    line_subtotal: v.number(),
    // v0.5.1 PR B: optional so pre-PR-B rows (every line shipped v0.3-v0.5.0.1)
    // stay schema-valid. All reads go through helper `lineRefundedQty(line) =
    // line.refunded_qty ?? 0`. Patch writes set a number, not undefined.
    refunded_qty: v.optional(v.number()),
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced (was optional during migration window)
  })
    .index("by_transaction", ["transaction_id"])
    .index("by_outlet_transaction", ["outlet_id", "transaction_id"]),

  pos_receipt_counters: defineTable({
    year: v.number(),                            // WIB calendar year (UTC+7, no DST) — NOT UTC year.
                                                 //   Sales at 17:00-23:59 UTC fall into the next WIB day,
                                                 //   and the new WIB year takes effect at 17:00 UTC Dec 31.
                                                 //   Booth + accounting + customers all expect WIB calendar.
    next_number: v.number(),                     // monotonic; allocated atomically inside _confirmPaid
    outlet_id: v.id("outlets"),                  // v2.0 Task 12: enforced; per-outlet counter
  })
    .index("by_year", ["year"])
    .index("by_outlet_year", ["outlet_id", "year"]),
};
