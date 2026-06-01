import { describe, it, expect } from "vitest";
import { computeDaySummary, type DayTxn } from "../lib";
import { NEG_STOCK } from "../flags";

const txn = (over: Partial<DayTxn>): DayTxn => ({
  _id: "t1" as any, created_at: 0, total: 10_000, subtotal: 10_000,
  voucher_discount: 0, voucher_code_snapshot: undefined, staff_id: "s1" as any,
  staff_name: "Sari", instrument: "qris", flags: 0,
  lines: [{ product_code_snapshot: "DUBAI8", product_name_snapshot: "Dubai 8pcs", qty: 1, refunded_qty: 0 }],
  refundsTotal: 0, hasRefunds: false, ...over,
});

describe("computeDaySummary", () => {
  it("sums gross, refunds, net and counts", () => {
    const s = computeDaySummary([
      txn({ total: 30_000 }),
      txn({ total: 20_000, refundsTotal: 5_000, hasRefunds: true }),
    ]);
    expect(s.gross).toBe(50_000);
    expect(s.refundsTotal).toBe(5_000);
    expect(s.net).toBe(45_000);
    expect(s.count).toBe(2);
    expect(s.avgBasket).toBe(25_000);
  });

  it("returns an all-zero summary for an empty day (never null)", () => {
    const s = computeDaySummary([]);
    expect(s).toEqual({
      gross: 0, refundsTotal: 0, net: 0, count: 0, avgBasket: 0,
      paymentMix: { qris: { count: 0, total: 0 }, bca_va: { count: 0, total: 0 }, unknown: { count: 0, total: 0 } },
      topSkus: [], hourlyCurve: Array(24).fill(0), perStaff: [], voucherUsage: { count: 0, total: 0 },
      needsAttention: { flagged: 0 },
    });
  });

  it("buckets the hourly curve by WIB hour", () => {
    // 2026-06-01 02:00 UTC = 09:00 WIB → bucket 9
    const s = computeDaySummary([txn({ created_at: Date.UTC(2026, 5, 1, 2, 0) })]);
    expect(s.hourlyCurve[9]).toBe(1);
  });

  it("ranks top SKUs by qty sold", () => {
    const s = computeDaySummary([
      txn({ lines: [{ product_code_snapshot: "A", product_name_snapshot: "A", qty: 5, refunded_qty: 0 }] }),
      txn({ lines: [{ product_code_snapshot: "B", product_name_snapshot: "B", qty: 2, refunded_qty: 0 }] }),
    ]);
    expect(s.topSkus[0]).toMatchObject({ code: "A", qty: 5 });
  });

  it("flags NEG_STOCK txns in needsAttention", () => {
    const s = computeDaySummary([txn({ flags: NEG_STOCK })]);
    expect(s.needsAttention.flagged).toBe(1);
  });

  it("routes payments into the correct instrument buckets", () => {
    const s = computeDaySummary([
      txn({ total: 10_000, instrument: "qris" }),
      txn({ total: 30_000, instrument: "bca_va" }),
      txn({ total: 5_000, instrument: "unknown" }),
    ]);
    expect(s.paymentMix.qris).toEqual({ count: 1, total: 10_000 });
    expect(s.paymentMix.bca_va).toEqual({ count: 1, total: 30_000 });
    expect(s.paymentMix.unknown).toEqual({ count: 1, total: 5_000 });
  });

  it("ranks perStaff desc by total", () => {
    const s = computeDaySummary([
      txn({ staff_id: "a" as any, staff_name: "A", total: 10_000 }),
      txn({ staff_id: "b" as any, staff_name: "B", total: 50_000 }),
      txn({ staff_id: "a" as any, staff_name: "A", total: 30_000 }),
    ]);
    expect(s.perStaff[0]).toMatchObject({ name: "B", total: 50_000, count: 1 });
    expect(s.perStaff[1]).toMatchObject({ name: "A", total: 40_000, count: 2 });
  });
});
