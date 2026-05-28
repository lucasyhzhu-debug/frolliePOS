import { query } from "../_generated/server";
import { v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import { computeVoucherDiscount } from "../lib/voucher";

/**
 * Active, unexpired vouchers. Bundled into the offline catalog cache snapshot
 * by useCatalogCache so cart-build can apply vouchers offline. Server
 * re-validates at commitCart per ADR-009.
 *
 * Explicit return type: consumed cross-module via ctx.runQuery (catalog query),
 * so the annotation prevents tsc -b from collapsing the inferred element type.
 */
export const getActiveVouchers = query({
  args: {},
  handler: async (ctx): Promise<Doc<"pos_vouchers">[]> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("pos_vouchers")
      .withIndex("by_active_expires", (q) => q.eq("active", true))
      .collect();
    return rows.filter((voucher) => voucher.expires_at == null || voucher.expires_at > now);
  },
});

/**
 * Validate a voucher code against a cart subtotal. Used by routes/sale/voucher.tsx
 * for live UX feedback AND by transactions.public.commitCart for server-side
 * re-validation.
 *
 * Discount math per ADR-024:
 *   percentage: floor(subtotal * value / 100)
 *   amount:     min(value, subtotal)
 * Both integer rupiah per ADR-015.
 *
 * Returns { valid: false, reason } for not found / inactive / expired /
 * below min_cart_value. Does NOT check used_count <= max_redemptions here —
 * that race is resolved at _redeemVoucher_internal (loser gets VOUCHER_OVER_REDEEMED).
 */
export const validateVoucher = query({
  args: { code: v.string(), cartSubtotal: v.number() },
  handler: async (ctx, args): Promise<{
    valid: boolean;
    discountAmount: number;
    voucherId?: string;
    reason?: "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "MIN_CART_VALUE";
  }> => {
    const voucher = await ctx.db
      .query("pos_vouchers")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .first();
    if (!voucher) return { valid: false, discountAmount: 0, reason: "NOT_FOUND" };
    if (!voucher.active) return { valid: false, discountAmount: 0, reason: "INACTIVE" };
    if (voucher.expires_at != null && voucher.expires_at <= Date.now()) {
      return { valid: false, discountAmount: 0, reason: "EXPIRED" };
    }
    if (voucher.min_cart_value != null && args.cartSubtotal < voucher.min_cart_value) {
      return { valid: false, discountAmount: 0, reason: "MIN_CART_VALUE" };
    }
    const discountAmount = computeVoucherDiscount(voucher.type, voucher.value, args.cartSubtotal);
    return { valid: true, discountAmount, voucherId: voucher._id };
  },
});
