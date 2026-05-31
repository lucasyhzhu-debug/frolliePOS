import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { describe, it, expect } from "vitest";

describe("_lazyMintReceiptToken_internal (dormant in v0.5.1, tested for v0.5.3 readiness)", () => {
  it("mints a fresh token + audit row on a tokenless paid txn", async () => {
    const t = convexTest(schema);
    const { staffId, txnId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-AUDIT", name: "Auditor", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: Date.now(), paid_at: Date.now(),
      });
      return { staffId, txnId };
    });

    const { token } = await t.mutation(
      internal.receipts.internal._lazyMintReceiptToken_internal,
      { transactionId: txnId, actor: staffId },
    );
    expect(token.length).toBe(43);

    await t.run(async (ctx) => {
      const txn = await ctx.db.get(txnId);
      expect(txn?.receipt_token).toBe(token);
      const auditRows = await ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "receipt.token_minted"))
        .collect();
      expect(auditRows.length).toBe(1);
    });
  });

  it("is idempotent — second call returns the same token", async () => {
    const t = convexTest(schema);
    const { staffId, txnId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-IDEM", name: "I", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: staffId,
        created_at: Date.now(), paid_at: Date.now(),
      });
      return { staffId, txnId };
    });

    const r1 = await t.mutation(
      internal.receipts.internal._lazyMintReceiptToken_internal,
      { transactionId: txnId, actor: staffId },
    );
    const r2 = await t.mutation(
      internal.receipts.internal._lazyMintReceiptToken_internal,
      { transactionId: txnId, actor: staffId },
    );
    expect(r2.token).toBe(r1.token);
  });
});
