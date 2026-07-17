import { defineTable } from "convex/server";
import { v } from "convex/values";

export const paymentsTables = {
  pos_xendit_invoices: defineTable({
    transaction_id: v.id("pos_transactions"),
    xendit_invoice_id: v.string(),               // QR Codes `id` (QRIS) OR FVA `id` (BCA) — dedup/match key for webhook
    reference_id: v.optional(v.string()),        // external_id sent to Xendit; addresses the simulate endpoint
    xendit_idempotency_key: v.string(),          // X-IDEMPOTENCY-KEY we sent to Xendit at creation;
                                                 //   recorded for audit + retry traceability
    method: v.union(v.literal("QRIS"), v.literal("BCA_VA")),

    qr_string: v.optional(v.string()),
    va_number: v.optional(v.string()),
    receipt_id: v.optional(v.string()),          // bank RRN from the paid webhook — Frollie Pro settlement join key
    payment_source: v.optional(v.string()),      // paying wallet/bank (DANA/OVO/BCA)

    status_at_create: v.string(),
    created_at: v.number(),
    cancelled_at: v.optional(v.number()),
    cancelled_reason: v.optional(v.string()),
    replaced_by_invoice_id: v.optional(v.id("pos_xendit_invoices")),
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced (was optional during migration window)
  })
    .index("by_transaction", ["transaction_id"])
    .index("by_xendit_invoice_id", ["xendit_invoice_id"])  // webhook dedup (GLOBAL_UNIQUE — keep)
    .index("by_outlet_transaction", ["outlet_id", "transaction_id"]),

  // Transactional outbox for forwarding genuine QRIS paid-callbacks from this
  // shared-Xendit-account POS webhook to Recipe Master (Frollie Pro). The single
  // account-level Xendit webhook lands here; RM QR payments no-op on the POS, so
  // we durably re-POST them to RM. NOT outlet-scoped (these rows carry no
  // session/outlet — a forwarded event is RM's, not a POS outlet's), so the
  // frollie-internal/index-leads-with-outlet_id lint (OUTLET_SCOPED-only) does
  // not apply. INVARIANT: forwarding is strictly POS → RM — RM must never
  // forward, and this outbox must never be pointed anywhere but RM (SSRF-safe:
  // the target is a hardcoded const in forwarder.ts, never payload-derived).
  // The forward secret is NEVER stored here (Convex data is dashboard-visible) —
  // it is re-read from env at send time.
  pos_qris_forward_outbox: defineTable({
    raw_payload: v.string(),                                // exact raw body to re-POST
    xendit_qr_id: v.string(),                               // dedup + audit (from matchKey)
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
    attempts: v.number(),                                   // incremented per delivery try
    last_error: v.optional(v.string()),                     // truncated
    created_at: v.number(),
    next_attempt_at: v.number(),                            // backoff schedule
    delivered_at: v.optional(v.number()),
  })
    .index("by_xendit_qr_id", ["xendit_qr_id"])             // dedup read (OCC-race-safe) — without it enqueue degrades to a .collect() scan
    .index("by_status_next", ["status", "next_attempt_at"]), // optional future sweeper for due pending rows
};
