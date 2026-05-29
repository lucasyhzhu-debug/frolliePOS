/**
 * Bitset flags for pos_transactions.flags. ADR-018 (NEG_STOCK) +
 * spec §"Architecture overview → flags.ts" (VOUCHER_OVER_REDEEMED).
 *
 * New flags MUST use the next unused bit and be added to this file (not
 * inlined as magic numbers anywhere else).
 */
export const NEG_STOCK = 1 << 0;
export const VOUCHER_OVER_REDEEMED = 1 << 1;
export const PAYMENT_AMOUNT_MISMATCH = 1 << 2;

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) === flag;
}

export function withFlag(flags: number, flag: number): number {
  return flags | flag;
}
