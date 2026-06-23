import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { describe, it, expect } from "vitest";

/**
 * Lazy-mint behaviour. Pre-v0.5.3a these tests called the receipts-side
 * `_lazyMintReceiptToken_internal` facade — that facade was a pure pass-through
 * to `transactions._ensureReceiptTokenForPaidTxn_internal` and was deleted in
 * the v0.5.3a simplification wave (one less hop). The behaviour being asserted
 * (existing-token check, audit emit, status guard) lives in the owning-module
 * helper, so the tests now call it directly.
 */
describe("_ensureReceiptTokenForPaidTxn_internal (lazy-mint behaviour)", () => {
  it("mints a fresh token + audit row on a tokenless paid txn", async () => {
    const t = convexTest(schema);
    const { staffId, txnId } = await t.run(async (ctx: any) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-AUDIT", name: "Auditor", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: Date.now(), paid_at: Date.now(),
        outlet_id: outletId,
      });
      return { staffId, txnId };
    });

    const { token } = await t.mutation(
      internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal,
      { transactionId: txnId, actor: staffId },
    );
    expect(token.length).toBe(43);

    await t.run(async (ctx) => {
      const txn = await ctx.db.get(txnId) as any;
      expect(txn?.receipt_token).toBe(token);
      const auditRows = await ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "receipt.token_minted"))
        .collect();
      expect(auditRows.length).toBe(1);
    });
  });

  it("rejects with TXN_NOT_PAID when called on a non-paid txn", async () => {
    const t = convexTest(schema);
    const { staffId, txnId } = await t.run(async (ctx: any) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-NP", name: "N", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment",
        subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: staffId,
        created_at: Date.now(),
        outlet_id: outletId,
      });
      return { staffId, txnId };
    });
    await expect(
      t.mutation(internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal, {
        transactionId: txnId, actor: staffId,
      }),
    ).rejects.toThrow("TXN_NOT_PAID");
  });

  it("rejects with TXN_NOT_FOUND for a non-existent transaction id", async () => {
    const t = convexTest(schema);
    const { staffId, fakeId } = await t.run(async (ctx: any) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      // create then delete a txn to get a valid-shaped but non-existent id
      const staffId = await ctx.db.insert("staff", {
        code: "S-DD", name: "D", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
      });
      const id = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: staffId,
        created_at: Date.now(), paid_at: Date.now(),
        outlet_id: outletId,
      });
      await ctx.db.delete(id);
      return { staffId, fakeId: id };
    });
    await expect(
      t.mutation(internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal, {
        transactionId: fakeId, actor: staffId,
      }),
    ).rejects.toThrow("TXN_NOT_FOUND");
  });

  it("is idempotent — second call returns the same token", async () => {
    const t = convexTest(schema);
    const { staffId, txnId } = await t.run(async (ctx: any) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-IDEM", name: "I", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: staffId,
        created_at: Date.now(), paid_at: Date.now(),
        outlet_id: outletId,
      });
      return { staffId, txnId };
    });

    const r1 = await t.mutation(
      internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal,
      { transactionId: txnId, actor: staffId },
    );
    const r2 = await t.mutation(
      internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal,
      { transactionId: txnId, actor: staffId },
    );
    expect(r2.token).toBe(r1.token);
  });
});
