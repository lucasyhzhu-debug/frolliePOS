import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { describe, it, expect } from "vitest";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// v1.0.1: _confirmPaid now schedules sendTxnTicker; stub Telegram + drain to
// avoid "Write outside of transaction" errors from the pending scheduled action.
setupTelegramStub();

describe("_confirmPaid_internal mints receipt_token", () => {
  it("a confirmed paid txn has a 43-char base64url receipt_token", async () => {
    const t = convexTest(schema);
    const { txnId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-CP", name: "X", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: Date.now(),
      });
      return { txnId };
    });

    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId,
      source: "webhook",
    });

    await t.run(async (ctx) => {
      const txn = await ctx.db.get(txnId);
      expect(txn?.status).toBe("paid");
      expect(txn?.receipt_token).toBeDefined();
      expect(txn?.receipt_token?.length).toBe(43);
      expect(txn?.receipt_token).toMatch(/^[A-Za-z0-9_-]+$/);
    });
    await drainScheduled(t);
  });

  it("re-fire after paid is a no-op — receipt_token stays stable", async () => {
    const t = convexTest(schema);
    const { txnId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-RF", name: "R", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment",
        subtotal: 1, voucher_discount: 0, total: 1,
        flags: 0, staff_id: staffId,
        created_at: Date.now(),
      });
      return { txnId };
    });

    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId, source: "webhook",
    });
    const firstToken = await t.run(async (ctx) => (await ctx.db.get(txnId))?.receipt_token);

    // Re-fire (mimics Xendit webhook retry).
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId, source: "webhook",
    });
    const secondToken = await t.run(async (ctx) => (await ctx.db.get(txnId))?.receipt_token);

    expect(secondToken).toBe(firstToken);
    await drainScheduled(t);
  });
});
