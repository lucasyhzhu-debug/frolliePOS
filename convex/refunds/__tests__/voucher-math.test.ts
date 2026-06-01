import { describe, it, expect } from "vitest";
import { computeRefundAmount, computeTotalRefund, lineRefundable, lineRefundedQty } from "../lib";
import type { Doc } from "../../_generated/dataModel";

function txn(subtotal: number, voucher: number): Doc<"pos_transactions"> {
  return {
    _id: "x" as any, _creationTime: 0,
    status: "paid", subtotal, voucher_discount: voucher, total: subtotal - voucher,
    flags: 0, staff_id: "s" as any, created_at: 0, paid_at: 0,
  };
}

function line(qty: number, unit_price: number, refunded_qty?: number): Doc<"pos_transaction_lines"> {
  return {
    _id: "l" as any, _creationTime: 0,
    transaction_id: "t" as any, product_id: "p" as any,
    product_code_snapshot: "X", product_name_snapshot: "X",
    unit_price_snapshot: unit_price, tax_rate_snapshot: 0,
    qty, line_subtotal: qty * unit_price,
    refunded_qty,
  };
}

describe("computeRefundAmount (ADR-040)", () => {
  it("no voucher: refund_amount = unit_price × refund_qty (exact)", () => {
    const t = txn(150000, 0);
    const l = line(3, 50000);
    expect(computeRefundAmount(l, t, 1)).toBe(50000);
    expect(computeRefundAmount(l, t, 2)).toBe(100000);
    expect(computeRefundAmount(l, t, 3)).toBe(150000);
  });

  it("with voucher, partial refund — worked example (refund 1 of 3, voucher -20k on 150k → paid 130k → refund 43.333)", () => {
    const t = txn(150000, 20000);
    const l = line(3, 50000);
    expect(computeRefundAmount(l, t, 1)).toBe(43333);
    expect(computeRefundAmount(l, t, 2)).toBe(86666);
    expect(computeRefundAmount(l, t, 3)).toBe(130000);
  });

  it("full-refund-of-all-lines: total_refund ≤ paid_total, off by < 1 IDR per line (ADR-040 §49)", () => {
    const t = txn(230000, 30000);
    const l1 = line(3, 50000);
    const l2 = line(2, 40000);
    const refundLines = [
      { line: l1, qty: 3 },
      { line: l2, qty: 2 },
    ];
    const total = computeTotalRefund(t, refundLines);
    // ADR-040 §49: "Floor favours business by < 1 IDR per refund line." With 2
    // lines, the floored sum can be up to 2 IDR less than paid_total. Critical
    // invariant: never exceed paid_total.
    expect(total).toBeLessThanOrEqual(t.total);
    expect(total).toBeGreaterThanOrEqual(t.total - refundLines.length);
    // For these exact numbers: 130434 + 69565 = 199999 (1 IDR floor loss).
    expect(total).toBe(199999);
  });

  it("floor wins on decimal (rejects rounding-up alternative)", () => {
    const t = txn(100000, 1);
    const l = line(1, 99999);
    expect(computeRefundAmount(l, t, 1)).toBe(99998);
  });

  it("rejects refund_qty > line.qty", () => {
    const t = txn(50000, 0);
    const l = line(1, 50000);
    expect(() => computeRefundAmount(l, t, 2)).toThrow("REFUND_QTY_EXCEEDS_LINE_QTY");
  });

  it("returns 0 for refund_qty = 0", () => {
    const t = txn(50000, 0);
    const l = line(1, 50000);
    expect(computeRefundAmount(l, t, 0)).toBe(0);
  });
});

describe("lineRefundedQty / lineRefundable", () => {
  it("treats undefined refunded_qty as 0", () => {
    const l = line(3, 50000);
    expect(lineRefundedQty(l)).toBe(0);
    expect(lineRefundable(l)).toBe(3);
  });
  it("respects explicit refunded_qty", () => {
    const l = line(3, 50000, 1);
    expect(lineRefundedQty(l)).toBe(1);
    expect(lineRefundable(l)).toBe(2);
  });
});
