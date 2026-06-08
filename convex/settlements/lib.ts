// PURE + V8-safe. The ONLY place the Xendit GET /transactions row shape is
// interpreted. Field paths confirmed against a real TEST-key response on
// 2026-06-08 (docs/xendit-reference/settlement-reconciliation.md, "List
// Transactions — confirmed shape"). Key facts: `fee` is an OBJECT (use
// Xendit-provided `net_amount` instead; mdr = amount - net_amount); there is NO
// `settlement_date` field — derive the WIB calendar date from the UTC
// `estimated_settlement_time` timestamp; `cashflow` gates collected sales
// (MONEY_IN) vs payouts (MONEY_OUT).
import { WIB_OFFSET_MS } from "../lib/time";

export type SettlementStatus = "PENDING" | "SETTLED" | "EARLY_SETTLED" | null;

/** Normalized row we depend on, extracted from a raw Xendit transaction. */
export type XenditTxnRow = {
  reference_id: string;
  settlement_status: SettlementStatus;
  settlement_date: string | null; // DERIVED WIB calendar date (YYYY-MM-DD)
  cashflow: string | null;         // "MONEY_IN" | "MONEY_OUT"
  gross_amount: number;            // raw row.amount
  net_amount: number;              // raw row.net_amount ("amount after fees/VAT")
};

export type SettlementDay = {
  settlement_date: string;
  gross_amount: number;
  mdr_amount: number;
  net_amount: number;
  transaction_count: number;
};

/** UTC ISO timestamp → WIB (UTC+7) calendar date YYYY-MM-DD. null/unparseable → null. */
function wibCalendarDate(utcIso: string | null): string | null {
  if (!utcIso) return null;
  const t = Date.parse(utcIso);
  if (Number.isNaN(t)) return null;
  return new Date(t + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** Parse a raw GET /transactions body into normalized rows. Throws on an
 *  unrecognized shape — a silent [] would be indistinguishable from "no
 *  settlements" and mask a field-path regression. */
export function parseListTransactions(body: unknown): XenditTxnRow[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error(`SETTLEMENT_PARSE_FAILED: unexpected body ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return (body as { data: unknown[] }).data.map((r) => {
    const row = r as Record<string, unknown>;
    const gross = Number(row.amount ?? 0);
    const net = Number(row.net_amount ?? gross);
    return {
      reference_id: String(row.reference_id ?? ""),
      settlement_status: (row.settlement_status ?? null) as SettlementStatus,
      settlement_date: wibCalendarDate((row.estimated_settlement_time ?? null) as string | null),
      cashflow: (row.cashflow ?? null) as string | null,
      gross_amount: gross,
      net_amount: net,
    };
  });
}

const SETTLED: SettlementStatus[] = ["SETTLED", "EARLY_SETTLED"];

/** Aggregate settled MONEY_IN rows by WIB settlement date into daily totals.
 *  Excludes PENDING/null-settlement, dateless, and MONEY_OUT (payout) rows.
 *  mdr = gross - net (total Xendit deductions). Deterministic, date-ascending. */
export function aggregateSettledByDate(rows: XenditTxnRow[]): SettlementDay[] {
  const byDate = new Map<string, SettlementDay>();
  for (const r of rows) {
    if (!SETTLED.includes(r.settlement_status)) continue;
    if (r.cashflow !== "MONEY_IN") continue;
    if (!r.settlement_date) continue;
    const day = byDate.get(r.settlement_date) ?? {
      settlement_date: r.settlement_date,
      gross_amount: 0,
      mdr_amount: 0,
      net_amount: 0,
      transaction_count: 0,
    };
    day.gross_amount += r.gross_amount;
    day.net_amount += r.net_amount;
    day.mdr_amount = day.gross_amount - day.net_amount;
    day.transaction_count += 1;
    byDate.set(r.settlement_date, day);
  }
  return [...byDate.values()].sort((a, b) => a.settlement_date.localeCompare(b.settlement_date));
}
