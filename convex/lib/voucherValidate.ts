// Shared voucher validation reason-code logic. Pure, V8-safe — must NOT import
// anything Node-specific so it can be bundled by:
//   - convex/vouchers/public.ts:validateVoucher (BE reactive query)
//   - src/routes/sale/voucher.tsx (FE offline fallback)
// The same inputs MUST yield the same outputs in both paths or the user
// sees a different discount in cart-build vs commit.
//
// Discount math delegates to convex/lib/voucher.ts:computeVoucherDiscount
// (also pure / V8-safe — confirmed at staffreview).

import { computeVoucherDiscount } from "./voucher";

export type VoucherForValidate = {
  _id: string;
  code: string;
  type: "percentage" | "amount";
  value: number;
  active: boolean;
  expires_at?: number;
  min_cart_value?: number;
};

export type ValidateResult =
  | { valid: true; discountAmount: number; voucherId: string }
  | { valid: false; discountAmount: 0; reason: "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "MIN_CART_VALUE" };

export function validateVoucherAgainst(
  voucher: VoucherForValidate | null,
  cartSubtotal: number,
  nowMs: number,
): ValidateResult {
  if (!voucher) return { valid: false, discountAmount: 0, reason: "NOT_FOUND" };
  if (!voucher.active) return { valid: false, discountAmount: 0, reason: "INACTIVE" };
  if (voucher.expires_at != null && voucher.expires_at <= nowMs) {
    return { valid: false, discountAmount: 0, reason: "EXPIRED" };
  }
  if (voucher.min_cart_value != null && cartSubtotal < voucher.min_cart_value) {
    return { valid: false, discountAmount: 0, reason: "MIN_CART_VALUE" };
  }
  const discountAmount = computeVoucherDiscount(voucher.type, voucher.value, cartSubtotal);
  return { valid: true, discountAmount, voucherId: voucher._id };
}
