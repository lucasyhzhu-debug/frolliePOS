import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import * as xendit from "../../payments/xendit";

afterEach(() => vi.restoreAllMocks());

// Real Xendit GET /transactions shape (confirmed Task 0): no settlement_date
// field (derive WIB date from estimated_settlement_time), net_amount provided,
// cashflow gates MONEY_IN. 04:00Z lands on the same WIB calendar day.
const DATA = { data: [
  { reference_id: "pos-a", settlement_status: "SETTLED", cashflow: "MONEY_IN", estimated_settlement_time: "2026-06-05T04:00:00.000Z", amount: 90000, net_amount: 89370, fee: { xendit_fee: 630 } },
  { reference_id: "pos-b", settlement_status: "SETTLED", cashflow: "MONEY_IN", estimated_settlement_time: "2026-06-06T04:00:00.000Z", amount: 12000, net_amount: 11916, fee: { xendit_fee: 84 } },
] };

describe("settlements.syncSettlements", () => {
  it("upserts one poll row per settled day", async () => {
    const t = convexTest(schema);
    vi.spyOn(xendit, "listTransactions").mockResolvedValue(DATA);
    await t.action(internal.settlements.cronActions.syncSettlements, {});
    const rows = await t.run((ctx) => ctx.db.query("pos_settlements").collect());
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "xendit_poll")).toBe(true);
    // Spot-check the field mapping across the DB boundary (the pure lib tests
    // never touch the DB, so this guards an upsert field-mapping regression).
    const jun5 = rows.find((r) => r.settlement_date === "2026-06-05");
    expect(jun5).toMatchObject({ gross_amount: 90000, net_amount: 89370, mdr_amount: 630, transaction_count: 1 });
  });

  it("zero settled rows → audited skip, no rows", async () => {
    const t = convexTest(schema);
    vi.spyOn(xendit, "listTransactions").mockResolvedValue({ data: [] });
    const res = await t.action(internal.settlements.cronActions.syncSettlements, {});
    expect(res).toEqual({ skipped: "no_settlements" });
    const audits = await t.run((ctx) => ctx.db.query("audit_log").collect());
    expect(audits.some((a) => a.action === "settlement.sync_skipped")).toBe(true);
  });
});
