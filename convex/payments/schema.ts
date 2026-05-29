import { defineTable } from "convex/server";
import { v } from "convex/values";

export const paymentsTables = {
  pos_xendit_invoices: defineTable({
    transaction_id: v.id("pos_transactions"),
    xendit_invoice_id: v.string(),               // QR Codes `id` (QRIS) OR FVA `id` (BCA) — dedup/match key for webhook
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
  })
    .index("by_transaction", ["transaction_id"])
    .index("by_xendit_invoice_id", ["xendit_invoice_id"]),  // webhook dedup
};
