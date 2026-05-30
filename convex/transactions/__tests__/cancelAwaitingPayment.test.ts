import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedStaffSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Ali", pin_hash: "x", role: "staff", active: true,
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "dev-1",
      started_at: Date.now(), ended_at: null, end_reason: null,
    });
    return { staffId, sessionId };
  });
}

async function seedAwaitingPaymentTxnWithInvoice(
  t: ReturnType<typeof convexTest>,
  staffId: Id<"staff">,
) {
  return await t.run(async (ctx) => {
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "awaiting_payment", subtotal: 25_000, voucher_discount: 0,
      total: 25_000, flags: 0, staff_id: staffId, created_at: Date.now(),
    });
    await ctx.db.insert("pos_xendit_invoices", {
      transaction_id: txnId,
      xendit_invoice_id: "qr-abc123",
      xendit_idempotency_key: "ik-abc123",
      method: "QRIS",
      qr_string: "00020101021226...",
      status_at_create: "PENDING",
      created_at: Date.now(),
    });
    return txnId;
  });
}

async function seedPendingManualPaymentForTxn(
  t: ReturnType<typeof convexTest>,
  txnId: Id<"pos_transactions">,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("pos_approval_requests", {
      kind: "manual_payment_override",
      entity_type: "pos_transactions",
      entity_id: txnId,
      status: "pending",
      notification_channel: "telegram",
      triggered_by_event: "payment_stalled",
      triggered_at: Date.now(),
      token_hash: "deadbeef".repeat(8),       // 64 hex chars
      token_expires_at: Date.now() + 60 * 60 * 1000,
      context: {},
    });
  });
}

async function seedPaidTxn(
  t: ReturnType<typeof convexTest>,
  staffId: Id<"staff">,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 25_000, voucher_discount: 0,
      total: 25_000, flags: 0, staff_id: staffId,
      created_at: Date.now(), paid_at: Date.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transactions/public.cancelAwaitingPayment", () => {
  it("transitions txn to cancelled + supersedes active invoice + cascades approvals", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaffSession(t);
    const txnId = await seedAwaitingPaymentTxnWithInvoice(t, staffId);
    const approvalId = await seedPendingManualPaymentForTxn(t, txnId);

    const result = await t.mutation(api.transactions.public.cancelAwaitingPayment, {
      idempotencyKey: "k1",
      sessionId,
      txnId,
    });

    expect(result).toEqual({ cancelled: true });

    // 1. Txn cancelled
    const txn = await t.run((ctx) => ctx.db.get(txnId));
    expect(txn?.status).toBe("cancelled");
    expect(txn?.cancelled_at).toBeDefined();
    expect(txn?.cancelled_reason).toBe("user_cancelled_at_payment");

    // 2. Invoice gets cancelled_at stamp
    const invoice = await t.run((ctx) =>
      ctx.db
        .query("pos_xendit_invoices")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", txnId))
        .first(),
    );
    expect(invoice?.cancelled_at).toBeDefined();
    expect(invoice?.cancelled_reason).toBe("txn_cancelled");

    // 3. Pending approval cascade-denied
    const approval = await t.run((ctx) => ctx.db.get(approvalId));
    expect(approval?.status).toBe("denied");
    expect(approval?.deny_reason).toBe("txn_cancelled");

    // 4. Audit row emitted
    const auditRows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "transaction.cancelled"))
        .collect(),
    );
    const cancelRow = auditRows.find((r) => String(r.entity_id) === String(txnId));
    expect(cancelRow).toBeDefined();
    expect(cancelRow?.source).toBe("booth_inline");
  });

  it("non-awaiting txn throws TXN_NOT_AWAITING (race with paid webhook)", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaffSession(t);
    const txnId = await seedPaidTxn(t, staffId);

    await expect(
      t.mutation(api.transactions.public.cancelAwaitingPayment, {
        idempotencyKey: "k1",
        sessionId,
        txnId,
      }),
    ).rejects.toThrow(/TXN_NOT_AWAITING/);
  });

  it("works when no invoice exists (payment was never requested)", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaffSession(t);
    const txnId = await t.run((ctx) =>
      ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 10_000, voucher_discount: 0,
        total: 10_000, flags: 0, staff_id: staffId, created_at: Date.now(),
      }),
    );

    const result = await t.mutation(api.transactions.public.cancelAwaitingPayment, {
      idempotencyKey: "k1",
      sessionId,
      txnId,
    });

    expect(result).toEqual({ cancelled: true });
    const txn = await t.run((ctx) => ctx.db.get(txnId));
    expect(txn?.status).toBe("cancelled");
  });

  it("idempotency replay returns same response, no double-cancel", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaffSession(t);
    const txnId = await seedAwaitingPaymentTxnWithInvoice(t, staffId);

    const r1 = await t.mutation(api.transactions.public.cancelAwaitingPayment, {
      idempotencyKey: "k-idem",
      sessionId,
      txnId,
    });
    expect(r1).toEqual({ cancelled: true });

    // Replay with same key — should return cached result, not throw
    const r2 = await t.mutation(api.transactions.public.cancelAwaitingPayment, {
      idempotencyKey: "k-idem",
      sessionId,
      txnId,
    });
    expect(r2).toEqual({ cancelled: true });

    // Status should still be cancelled (not double-patched or errored)
    const txn = await t.run((ctx) => ctx.db.get(txnId));
    expect(txn?.status).toBe("cancelled");
  });
});
