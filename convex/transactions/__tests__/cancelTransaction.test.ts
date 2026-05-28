import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import {
  installFetchMock,
  _xenditMockReset,
  _xenditMockNextResponse,
  _xenditMockThrowNext,
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

  it("staffreview T3: cancel with invoice, Xendit cancel-API throws 5xx — best-effort, still flips status, audit logs success: false", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithSession(t);
    // Persist a fake invoice
    await t.run((ctx) =>
      ctx.db.patch(s.txn, { xendit_invoice_id_current: "xnd-fail" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("pos_xendit_invoices", {
        transaction_id: s.txn, xendit_invoice_id: "xnd-fail",
        xendit_idempotency_key: "k", method: "QRIS",
        qr_string: "qr", status_at_create: "PENDING", created_at: Date.now(),
      }),
    );
    _xenditMockThrowNext(new Error("Xendit 500"));
    await t.action(api.transactions.actions.cancelTransaction, {
      sessionId: s.session, txnId: s.txn,
      reason: "cancel with hostile Xendit", idempotencyKey: "k-c2",
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("cancelled");

    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "payment.invoice_cancelled"))
        .collect(),
    );
    expect(audit.length).toBeGreaterThan(0);
    // audit_log.metadata is stored as a stringified JSON (logAudit JSON.stringify's
    // it; schema is v.optional(v.string())) — parse it back to assert the outcome.
    const meta = JSON.parse(audit[audit.length - 1].metadata ?? "{}");
    expect(meta.success).toBe(false);
    expect(meta.error).toBeTruthy();
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
    ).rejects.toThrow();
  });
});
