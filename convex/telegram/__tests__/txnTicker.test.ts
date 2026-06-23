import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { setupTelegramStub } from "../../__tests__/_helpers";

// Stub Telegram fetch so the action can send without real HTTP calls.
setupTelegramStub();

describe("sendTxnTicker", () => {
  it("skips silently (no audit) when toggle disabled", async () => {
    const t = convexTest(schema);
    // Disable the toggle
    const txnId = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      await ctx.db.insert("pos_settings", {
        founders_summary_enabled: true,
        txn_ticker_enabled: false,
        updated_at: 0,
        outlet_id: outletId,
      } as any);
      // Seed a minimal paid txn
      const staffId = await ctx.db.insert("staff", {
        name: "Bayu", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      const txn = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 1000, voucher_discount: 0, total: 1000, flags: 0,
        staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-2026-0001", outlet_id: outletId,
      } as any);
      return txn;
    });

    const res = await t.action(internal.telegram.txnTicker.sendTxnTicker, { txnId });
    expect(res).toEqual({ skipped: "disabled" });

    // Invariant: no audit rows on skip (per-sale volume)
    const audits = await t.run(async (ctx) => ctx.db.query("audit_log").collect());
    expect(audits).toHaveLength(0);
  });

  it("returns skipped:role_unbound when managers role not bound", async () => {
    const t = convexTest(schema);
    // Enable ticker (default) but don't bind managers role
    const txnId = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      const staffId = await ctx.db.insert("staff", {
        name: "Bayu", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      return await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 1000, voucher_discount: 0, total: 1000, flags: 0,
        staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-2026-0002", outlet_id: outletId,
      } as any);
    });

    const res = await t.action(internal.telegram.txnTicker.sendTxnTicker, { txnId });
    expect(res).toEqual({ skipped: "role_unbound" });

    // No audit rows on skip
    const audits = await t.run(async (ctx) => ctx.db.query("audit_log").collect());
    expect(audits).toHaveLength(0);
  });
});
