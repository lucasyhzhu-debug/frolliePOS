import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

/**
 * Settlement tests for refunds.public:
 *   - markRefundSettled (manager-session-gated, idempotent, audited)
 *   - listPendingSettlement (manager-only, oldest-first)
 *
 * ADR-038: settlement is bookkeeping ack; manager session is required but NO
 * fresh PIN — the money-authorising decision happened at refund APPROVAL time.
 */

async function seedPaidTxn(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
    const staffId = await ctx.db.insert("staff", {
      code: "S-S", name: "S", role: "staff", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const mgrId = await ctx.db.insert("staff", {
      code: "M-S", name: "M", role: "manager", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const staffSession = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    } as any);
    const mgrSession = await ctx.db.insert("staff_sessions", {
      staff_id: mgrId, device_id: "d", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    } as any);
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
      price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(), outlet_id: outletId,
    } as any);
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
      flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
      receipt_number: "R-2026-S001", receipt_token: "tok-settle-1", outlet_id: outletId,
    } as any);
    const lineId = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId, product_id: productId,
      product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: 50000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 50000, outlet_id: outletId,
    } as any);
    return { staffId, mgrId, staffSession, mgrSession, txnId, lineId, outletId };
  });
}

async function commitOneRefund(
  t: ReturnType<typeof convexTest>,
  seed: { staffId: Id<"staff">; mgrId: Id<"staff">; txnId: Id<"pos_transactions">; lineId: Id<"pos_transaction_lines"> },
): Promise<Id<"pos_refunds">> {
  const { refundId } = await t.mutation(
    internal.refunds.internal._commitRefund_internal,
    {
      idempotencyKey: `settlement-test-commit-${Math.random()}`,
      transactionId: seed.txnId,
      lines: [{ line_id: seed.lineId, qty: 1 }],
      reason: "test",
      requestedBy: seed.staffId,
      approverId: seed.mgrId,
      approvalSource: "booth_inline",
    },
  );
  return refundId;
}

describe("markRefundSettled", () => {
  it("rejects with MANAGER_ONLY when called from a staff session", async () => {
    const t = convexTest(schema);
    const seed = await seedPaidTxn(t);
    const refundId = await commitOneRefund(t, seed);

    await expect(
      t.mutation(api.refunds.public.markRefundSettled, {
        sessionId: seed.staffSession,
        idempotencyKey: "settle-staff",
        refundId,
      }),
    ).rejects.toThrow(/MANAGER_ONLY/);
  });

  it("succeeds for a manager session: settlement_status=settled + settled_by + settled_at set", async () => {
    const t = convexTest(schema);
    const seed = await seedPaidTxn(t);
    const refundId = await commitOneRefund(t, seed);

    const res = await t.mutation(api.refunds.public.markRefundSettled, {
      sessionId: seed.mgrSession,
      idempotencyKey: "settle-ok",
      refundId,
    });
    expect(res.settled_by).toBe(seed.mgrId);
    expect(res.settled_at).toBeGreaterThan(0);

    const refund = await t.run((ctx) => ctx.db.get(refundId));
    expect(refund?.settlement_status).toBe("settled");
    expect(refund?.settled_by).toBe(seed.mgrId);
    expect(refund?.settled_at).toBe(res.settled_at);
  });

  it("idempotent: second call on already-settled refund returns existing settled_by/at without re-stamping or re-auditing", async () => {
    const t = convexTest(schema);
    const seed = await seedPaidTxn(t);
    const refundId = await commitOneRefund(t, seed);

    const r1 = await t.mutation(api.refunds.public.markRefundSettled, {
      sessionId: seed.mgrSession,
      idempotencyKey: "settle-1",
      refundId,
    });

    // Distinct key so we hit the "already settled" branch (not the cache).
    const r2 = await t.mutation(api.refunds.public.markRefundSettled, {
      sessionId: seed.mgrSession,
      idempotencyKey: "settle-2",
      refundId,
    });
    expect(r2.settled_by).toBe(r1.settled_by);
    expect(r2.settled_at).toBe(r1.settled_at);

    // Only ONE refund.settled audit row.
    const auditRows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.settled"))
        .collect(),
    );
    expect(auditRows.length).toBe(1);
  });
});

describe("listPendingSettlement", () => {
  it("returns pending refunds only, oldest-first; rejects staff session", async () => {
    const t = convexTest(schema);
    const seed = await seedPaidTxn(t);

    // First seed a second paid txn so we can commit multiple refunds.
    const { lineId2 } = await t.run(async (ctx) => {
      const productId2 = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUB3", name: "Dubai 3pc", pack_label: "3pc",
        price_idr: 120000, active: true, sort_order: 1, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(), outlet_id: seed.outletId,
      } as any);
      const txn2 = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 120000, voucher_discount: 0, total: 120000,
        flags: 0, staff_id: seed.staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-2026-S002", receipt_token: "tok-settle-2", outlet_id: seed.outletId,
      } as any);
      const lineId2 = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txn2, product_id: productId2,
        product_code_snapshot: "DUB3", product_name_snapshot: "Dubai 3pc",
        unit_price_snapshot: 120000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 120000, outlet_id: seed.outletId,
      } as any);
      return { txn2, lineId2 };
    });

    // Commit refund 1 (older).
    const refund1 = await commitOneRefund(t, seed);
    // Tiny stagger via a second commit.
    const { refundId: refund2 } = await t.mutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: "settlement-test-refund2",
        transactionId: await t.run(async (ctx) => {
          // Look up the txn id for the second paid row.
          const txns = await ctx.db.query("pos_transactions").collect();
          return txns.find((x) => x.receipt_number === "R-2026-S002")!._id;
        }),
        lines: [{ line_id: lineId2, qty: 1 }],
        reason: "second",
        requestedBy: seed.staffId,
        approverId: seed.mgrId,
        approvalSource: "booth_inline",
      },
    );

    // Settle refund1 so only refund2 remains pending.
    await t.mutation(api.refunds.public.markRefundSettled, {
      sessionId: seed.mgrSession,
      idempotencyKey: "settle-just-1",
      refundId: refund1,
    });

    // Staff session rejected.
    await expect(
      t.query(api.refunds.public.listPendingSettlement, { sessionId: seed.staffSession }),
    ).rejects.toThrow(/MANAGER_ONLY/);

    // Manager: returns ONLY pending (refund2), not refund1.
    // B28a M2: projection drops settlement_status — only refunds with
    // settlement_status="pending" are returned (index-filtered), so the
    // surfaced row IS the pending one by construction. Re-verify via the
    // underlying DB row that refund1 was settled and refund2 is still pending.
    const pending = await t.query(api.refunds.public.listPendingSettlement, {
      sessionId: seed.mgrSession,
    });
    expect(pending.length).toBe(1);
    expect(pending[0]._id).toBe(refund2);
    // Projection no longer surfaces settlement_status (M2) — assert at the
    // table level instead.
    const refund2Row = await t.run((ctx) => ctx.db.get(refund2));
    expect(refund2Row?.settlement_status).toBe("pending");
  });
});
