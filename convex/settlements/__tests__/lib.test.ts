import { describe, it, expect } from "vitest";
import { parseListTransactions, aggregateSettledByDate } from "../lib";

// Real Xendit GET /transactions row shape (confirmed 2026-06-08): fee is an
// object (ignored — we use net_amount), no settlement_date field (derive WIB
// date from estimated_settlement_time UTC timestamp), cashflow gates payouts.
// UTC times chosen to land on the intended WIB day (UTC+7): 04:00Z → same date.
const ROWS = [
  { reference_id: "pos-a", settlement_status: "SETTLED",       cashflow: "MONEY_IN",  estimated_settlement_time: "2026-06-05T04:00:00.000Z", amount: 90000, net_amount: 89370, fee: { xendit_fee: 630 } },
  { reference_id: "pos-b", settlement_status: "EARLY_SETTLED", cashflow: "MONEY_IN",  estimated_settlement_time: "2026-06-05T04:00:00.000Z", amount: 45000, net_amount: 44685, fee: { xendit_fee: 315 } },
  { reference_id: "pos-c", settlement_status: "PENDING",       cashflow: "MONEY_IN",  estimated_settlement_time: "2026-06-06T04:00:00.000Z", amount: 45000, net_amount: 44685, fee: { xendit_fee: 315 } },
  { reference_id: "pos-d", settlement_status: null,            cashflow: "MONEY_IN",  estimated_settlement_time: null,                       amount: 0,     net_amount: 0,     fee: { xendit_fee: 0 } },
  { reference_id: "pos-e", settlement_status: "SETTLED",       cashflow: "MONEY_IN",  estimated_settlement_time: "2026-06-06T04:00:00.000Z", amount: 12000, net_amount: 11916, fee: { xendit_fee: 84 } },
  { reference_id: "pay-1", settlement_status: "SETTLED",       cashflow: "MONEY_OUT", estimated_settlement_time: "2026-06-05T04:00:00.000Z", amount: 500000, net_amount: 500000, fee: { xendit_fee: 0 } },
];

describe("settlements/lib aggregateSettledByDate", () => {
  it("groups SETTLED + EARLY_SETTLED MONEY_IN by WIB date; excludes PENDING, null, and MONEY_OUT payouts", () => {
    expect(aggregateSettledByDate(parseListTransactions({ data: ROWS }))).toEqual([
      { settlement_date: "2026-06-05", gross_amount: 135000, mdr_amount: 945, net_amount: 134055, transaction_count: 2 },
      { settlement_date: "2026-06-06", gross_amount: 12000, mdr_amount: 84, net_amount: 11916, transaction_count: 1 },
    ]);
  });
  it("empty input → empty array", () => {
    expect(aggregateSettledByDate([])).toEqual([]);
  });
  it("buckets by WIB calendar date, not UTC (a late-UTC settlement rolls into the next WIB day)", () => {
    const rows = parseListTransactions({ data: [
      { reference_id: "x", settlement_status: "SETTLED", cashflow: "MONEY_IN", estimated_settlement_time: "2026-06-05T20:00:00.000Z", amount: 10000, net_amount: 9930, fee: {} },
    ]});
    expect(aggregateSettledByDate(rows)[0].settlement_date).toBe("2026-06-06");
  });
});

describe("settlements/lib parseListTransactions", () => {
  it("parses the documented envelope { data: [...] } and derives net + WIB date", () => {
    const parsed = parseListTransactions({ data: ROWS, has_more: false });
    expect(parsed).toHaveLength(6);
    expect(parsed[0].net_amount).toBe(89370);
    expect(parsed[0].settlement_date).toBe("2026-06-05");
  });
  it("throws on an unrecognized shape (never silently returns [])", () => {
    expect(() => parseListTransactions({ unexpected: true })).toThrow(/SETTLEMENT_PARSE_FAILED/);
    expect(() => parseListTransactions(null)).toThrow(/SETTLEMENT_PARSE_FAILED/);
  });
  it("tolerates extra/unknown fields on a row", () => {
    const body = { data: [{ ...ROWS[0], channel_code: "QRIS", weird: 1 }] };
    expect(parseListTransactions(body)[0].reference_id).toBe("pos-a");
  });
});
