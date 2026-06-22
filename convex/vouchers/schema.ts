import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vouchersTables = {
  pos_vouchers: defineTable({
    code: v.string(),                            // UPPERCASE, immutable (ADR-034 stable IDs)
    type: v.union(v.literal("percentage"), v.literal("amount")),
    value: v.number(),                           // pct 0-100 OR rupiah amount
    min_cart_value: v.optional(v.number()),
    max_redemptions: v.optional(v.number()),
    used_count: v.number(),
    expires_at: v.optional(v.number()),
    active: v.boolean(),
    created_at: v.number(),
    created_by_staff_id: v.optional(v.id("staff")),  // optional: vouchers created via Convex
                                                      // dashboard (v0.3-v0.5 manager workflow) have no
                                                      // staff context. v0.5/v0.6 manager portal supplies it.
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced; voucher codes unique per outlet post-v2.0
  })
    .index("by_code", ["code"])
    .index("by_active_expires", ["active", "expires_at"])
    .index("by_outlet_active_expires", ["outlet_id", "active", "expires_at"])
    .index("by_outlet_code", ["outlet_id", "code"]),

  pos_voucher_redemptions: defineTable({
    voucher_id: v.id("pos_vouchers"),
    transaction_id: v.id("pos_transactions"),
    code_snapshot: v.string(),
    discount_amount: v.number(),
    redeemed_at: v.number(),
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced (was optional during migration window)
  })
    .index("by_voucher", ["voucher_id"])
    .index("by_transaction", ["transaction_id"])  // ADR-010 uniqueness (one voucher per txn)
    .index("by_outlet_voucher", ["outlet_id", "voucher_id"])
    .index("by_outlet_transaction", ["outlet_id", "transaction_id"]),
};
