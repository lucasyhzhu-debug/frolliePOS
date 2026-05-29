import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import {
  installFetchMock,
  _xenditMockReset,
} from "../../payments/__tests__/_xenditMock";

beforeEach(() => {
  _xenditMockReset();
  installFetchMock();
  process.env.XENDIT_SECRET_KEY = "xnd_test_fake";
});

async function seedAwaitingWithSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "L", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const session = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "d", started_at: Date.now(),
      ended_at: null, end_reason: null,
    });
    const txn = await ctx.db.insert("pos_transactions", {
      status: "awaiting_payment", subtotal: 25_000, voucher_discount: 0,
      total: 25_000, flags: 0, staff_id: staff, created_at: Date.now(),
    });
    return { staff, session, txn };
  });
}

describe("transactions/actions.cancelTransaction", () => {
  it("staffreview T2: cancel without current invoice — flips status, no Xendit HTTP", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithSession(t);
    await t.action(api.transactions.actions.cancelTransaction, {
      sessionId: s.session, txnId: s.txn,
      reason: "staff cancel before payment", idempotencyKey: "k-c1",
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("cancelled");
    expect(txn?.cancelled_reason).toBe("staff cancel before payment");
  });

  it("Decision E: cancel with existing invoice — flips status cleanly (no Xendit HTTP, no expire! call)", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithSession(t);
    // Persist a fake invoice pointer on the txn (as if requestPayment had run)
    await t.run((ctx) =>
      ctx.db.patch(s.txn, { xendit_invoice_id_current: "xnd-cancel" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("pos_xendit_invoices", {
        transaction_id: s.txn, xendit_invoice_id: "xnd-cancel",
        xendit_idempotency_key: "k", method: "QRIS",
        qr_string: "qr", status_at_create: "PENDING", created_at: Date.now(),
      }),
    );
    // No mock needed — the action no longer calls Xendit on cancel (Decision E).
    await t.action(api.transactions.actions.cancelTransaction, {
      sessionId: s.session, txnId: s.txn,
      reason: "cancel with existing invoice", idempotencyKey: "k-c2",
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("cancelled");
    expect(txn?.cancelled_reason).toBe("cancel with existing invoice");
    // No payment.invoice_cancelled audit row (that path no longer exists for cancel).
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "payment.invoice_cancelled"))
        .collect(),
    );
    expect(audit.length).toBe(0);
  });

  it("rejects cancelling a paid txn", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithSession(t);
    await t.run((ctx) => ctx.db.patch(s.txn, { status: "paid", paid_at: Date.now() }));
    await expect(
      t.action(api.transactions.actions.cancelTransaction, {
        sessionId: s.session, txnId: s.txn,
        reason: "should reject", idempotencyKey: "k-c3",
      }),
    ).rejects.toThrow("INVALID_STATE_FOR_CANCEL");
  });
});
