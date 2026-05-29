import { defineTable } from "convex/server";
import { v } from "convex/values";

export const transactionsTables = {
  pos_transactions: defineTable({
    // Identity
    receipt_number: v.optional(v.string()),     // "R-YYYY-NNNN" — allocated at _confirmPaid only

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
    )),
    confirmed_mgr_approver_id: v.optional(v.id("staff")),
    confirmed_manual_reason: v.optional(v.string()),
  })
    .index("by_status_created", ["status", "created_at"])   // ADR-026 reconciliation
    .index("by_receipt_number", ["receipt_number"])
    .index("by_staff_created", ["staff_id", "created_at"]),

  pos_transaction_lines: defineTable({
    transaction_id: v.id("pos_transactions"),
    product_id: v.id("pos_products"),
    product_code_snapshot: v.string(),
    product_name_snapshot: v.string(),
    unit_price_snapshot: v.number(),
    tax_rate_snapshot: v.number(),               // schema-ready per ADR-000 §4 (0 today)
    qty: v.number(),
    line_subtotal: v.number(),
  })
    .index("by_transaction", ["transaction_id"]),

  pos_receipt_counters: defineTable({
    year: v.number(),                            // WIB calendar year (UTC+7, no DST) — NOT UTC year.
                                                 //   Sales at 17:00-23:59 UTC fall into the next WIB day,
                                                 //   and the new WIB year takes effect at 17:00 UTC Dec 31.
                                                 //   Booth + accounting + customers all expect WIB calendar.
    next_number: v.number(),                     // monotonic; allocated atomically inside _confirmPaid
  })
    .index("by_year", ["year"]),
};
