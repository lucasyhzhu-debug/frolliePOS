/**
 * Voucher discount in integer rupiah (ADR-015), per ADR-024:
 *   percentage → floor(subtotal * value / 100)
 *   amount     → min(value, subtotal)   (never discount more than the cart)
 *
 * Shared by vouchers.validateVoucher (live UX feedback) and
 * transactions.commitCart (server-side re-validation) so the two can't drift —
 * the user must be charged exactly the discount they were shown.
 */
export function computeVoucherDiscount(
  type: "percentage" | "amount",
  value: number,
  subtotal: number,
): number {
  return type === "percentage"
    ? Math.floor((subtotal * value) / 100)
    : Math.min(value, subtotal);
}
