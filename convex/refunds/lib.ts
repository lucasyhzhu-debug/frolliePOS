import { Doc } from "../_generated/dataModel";

/**
 * Per-line refund amount per ADR-040 (proportional, floor-rounded).
 *
 *   refund_amount = floor(line_total × paid_total × refund_qty / (subtotal_pre_voucher × line.qty))
 *
 * Single floor at the end — flooring earlier produces non-integer rupiah on
 * partial-line refunds.
 *
 * Stateless: recompute against ORIGINAL totals each refund. Multiple partial
 * refunds compose because sum ≤ paid_total is guaranteed by floor + the
 * refundable_qty cap enforced by the caller.
 */
export function computeRefundAmount(
  line: Pick<Doc<"pos_transaction_lines">, "line_subtotal" | "qty">,
  txn: Pick<Doc<"pos_transactions">, "total" | "subtotal">,
  refundQty: number,
): number {
  if (refundQty <= 0) return 0;
  if (refundQty > line.qty) throw new Error("REFUND_QTY_EXCEEDS_LINE_QTY");
  if (txn.subtotal <= 0 || line.qty <= 0) throw new Error("REFUND_INVALID_TXN");

  // BigInt arithmetic to avoid 53-bit precision loss on large transactions.
  // IDR amounts are well under 2^53 individually but the product can exceed it.
  const numerator = BigInt(line.line_subtotal) * BigInt(txn.total) * BigInt(refundQty);
  const denominator = BigInt(txn.subtotal) * BigInt(line.qty);
  return Number(numerator / denominator);    // BigInt division floors toward zero
}

/**
 * Helper to safely read refunded_qty (the field is v.optional so existing rows
 * have undefined). Treat undefined as 0.
 */
export function lineRefundedQty(line: Doc<"pos_transaction_lines">): number {
  return line.refunded_qty ?? 0;
}

/**
 * Remaining refundable qty for a line.
 */
export function lineRefundable(line: Doc<"pos_transaction_lines">): number {
  return line.qty - lineRefundedQty(line);
}
