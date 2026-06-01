import { Doc, Id } from "../_generated/dataModel";
import { WIB_OFFSET_MS } from "../lib/time";
import { NEG_STOCK } from "./flags";

/**
 * Pure day-summary aggregators for v0.5.3a reporting.
 *
 * Mirrors the refunds/lib.ts convention: input is fully-fetched plain shapes,
 * output is a plain summary object. No Convex `ctx`, no DB reads — the caller
 * (transactions/public.getDay in Task 4) is responsible for stitching the
 * `DayTxn` shape, including the derived `instrument` field (which is read off
 * the Xendit invoice, NOT off `pos_transactions.confirmed_via`).
 *
 * Runtime-neutral (V8-safe): no Node-only imports. Pure functions only.
 */

export type DayLine = Pick<
  Doc<"pos_transaction_lines">,
  "product_code_snapshot" | "product_name_snapshot" | "qty" | "refunded_qty"
>;

export type Instrument = "qris" | "bca_va" | "unknown";

export type DayTxn = {
  _id: Id<"pos_transactions">;
  created_at: number;
  total: number;
  subtotal: number;
  voucher_discount: number;
  voucher_code_snapshot?: string;
  staff_id: Id<"staff">;
  staff_name: string;
  instrument: Instrument;
  flags: number;
  lines: DayLine[];
  refundsTotal: number;
  hasRefunds: boolean;
};

export type DaySummary = {
  gross: number;
  refundsTotal: number;
  net: number;
  count: number;
  avgBasket: number;
  paymentMix: Record<Instrument, { count: number; total: number }>;
  topSkus: { code: string; name: string; qty: number }[];
  hourlyCurve: number[]; // length 24, indexed by WIB hour
  perStaff: { staffId: Id<"staff">; name: string; count: number; total: number }[];
  voucherUsage: { count: number; total: number };
  needsAttention: { flagged: number };
};

function wibHour(epochMs: number): number {
  return new Date(epochMs + WIB_OFFSET_MS).getUTCHours();
}

export function computeDaySummary(txns: DayTxn[]): DaySummary {
  const paymentMix: DaySummary["paymentMix"] = {
    qris: { count: 0, total: 0 },
    bca_va: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
  };
  const hourlyCurve = Array(24).fill(0);
  const skuMap = new Map<string, { code: string; name: string; qty: number }>();
  const staffMap = new Map<string, { staffId: Id<"staff">; name: string; count: number; total: number }>();
  let gross = 0, refundsTotal = 0, flagged = 0, voucherCount = 0, voucherTotal = 0;

  for (const t of txns) {
    gross += t.total;
    refundsTotal += t.refundsTotal;
    if (t.flags & NEG_STOCK) flagged++;
    paymentMix[t.instrument].count++;
    paymentMix[t.instrument].total += t.total;
    hourlyCurve[wibHour(t.created_at)]++;
    if (t.voucher_discount > 0) { voucherCount++; voucherTotal += t.voucher_discount; }
    for (const l of t.lines) {
      const e = skuMap.get(l.product_code_snapshot) ?? { code: l.product_code_snapshot, name: l.product_name_snapshot, qty: 0 };
      e.qty += l.qty;
      skuMap.set(l.product_code_snapshot, e);
    }
    const sk = String(t.staff_id);
    const se = staffMap.get(sk) ?? { staffId: t.staff_id, name: t.staff_name, count: 0, total: 0 };
    se.count++; se.total += t.total;
    staffMap.set(sk, se);
  }

  const count = txns.length;
  return {
    gross,
    refundsTotal,
    net: gross - refundsTotal,
    count,
    avgBasket: count === 0 ? 0 : Math.floor(gross / count),
    paymentMix,
    topSkus: [...skuMap.values()].sort((a, b) => b.qty - a.qty).slice(0, 5),
    hourlyCurve,
    perStaff: [...staffMap.values()].sort((a, b) => b.total - a.total),
    voucherUsage: { count: voucherCount, total: voucherTotal },
    needsAttention: { flagged },
  };
}
