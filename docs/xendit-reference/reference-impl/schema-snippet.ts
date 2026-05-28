// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE SNIPPET — from Frollie Recipe Master (product_master), Phase 84.
// Excerpt of convex/schema.ts (the qrisPayments table + businessSettings field).
// Documentation only; NOT compiled in FrolliePOS.
// ─────────────────────────────────────────────────────────────────────────────

import { defineTable } from "convex/server";
import { v } from "convex/values";

// businessSettings gained one field for the QRIS NMID (displayed under the QR
// per Bank Indonesia display rules):
//   businessSettings: defineTable({
//     ...existing fields...
//     qrisNmid: v.optional(v.string()),
//   })

// ============================================
// QRIS PAYMENTS (Phase 84 — Xendit QR Codes)
// Per-order QR-attempt state; matched by externalId/xenditQrId in webhook.
// One order → N rows (a QR expires in 30 min and may be regenerated).
// ============================================
export const qrisPaymentsTable = {
  qrisPayments: defineTable({
    orderId: v.id("orders"),
    provider: v.string(), // "xendit"
    externalId: v.string(), // = orderNumber (per-day match key, NOT globally unique)
    xenditQrId: v.string(), // globally unique — primary match key in the webhook
    qrString: v.string(),
    amount: v.number(),
    status: v.union(v.literal("pending"), v.literal("paid"), v.literal("expired")),
    receiptId: v.optional(v.string()), // RRN from payment_detail.receipt_id
    source: v.optional(v.string()), // paying wallet (DANA/OVO/...)
    expiresAt: v.number(), // our own 30-min window, NOT Xendit's expires_at (staffreview R5)
    paidAt: v.optional(v.number()),
    needsReview: v.optional(v.boolean()),
    reviewReason: v.optional(v.string()),
    rawPayload: v.optional(v.string()), // staffreview R1 — A1/A2 raw webhook body for early debugging
  })
    .index("by_order", ["orderId"])
    .index("by_externalId", ["externalId"])
    .index("by_xenditQrId", ["xenditQrId"]),
};
