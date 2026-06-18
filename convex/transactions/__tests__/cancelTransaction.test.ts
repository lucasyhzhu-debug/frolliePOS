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
      name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
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
    const invoiceId = await t.run((ctx) =>
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
    // C1 + I1: active invoice must now be cancelled and have an audit row.
    const invoice = await t.run((ctx) => ctx.db.get(invoiceId));
    expect(invoice?.cancelled_at).toBeDefined();
    expect(invoice?.cancelled_reason).toBe("txn_cancelled");
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "payment.invoice_cancelled"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    const auditRow = audit[0];
    expect(auditRow.entity_id).toBe(invoiceId);
    // F6: cancelTransaction threads real staff context → source="booth_inline"
    expect(auditRow.source).toBe("booth_inline");
    const meta = JSON.parse(auditRow.metadata as unknown as string) as Record<string, unknown>;
    expect(String(meta.txn_id)).toBe(String(s.txn));
  });

  it("v050-be-cancel-cancels-approval: cascade-denies live pending manual_payment_override on cancel", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithSession(t);

    // Seed a pending manual_payment_override approval row for this txn.
    const approvalId = await t.run(async (ctx) => {
      return await ctx.db.insert("pos_approval_requests", {
        kind: "manual_payment_override",
        entity_type: "pos_transactions",
        entity_id: s.txn,
        status: "pending",
        notification_channel: "telegram",
        triggered_by_event: "payment_stalled",
        triggered_at: Date.now(),
        token_hash: "deadbeef".repeat(8),        // 64 hex chars — any non-empty string
        token_expires_at: Date.now() + 60 * 60 * 1000, // 60-min future TTL
        context: {},
      });
    });

    await t.action(api.transactions.actions.cancelTransaction, {
      sessionId: s.session, txnId: s.txn,
      reason: "cascade test", idempotencyKey: "k-cascade1",
    });

    // Txn should be cancelled.
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("cancelled");

    // Approval row should be cascade-denied with system actor.
    const approval = await t.run((ctx) => ctx.db.get(approvalId));
    expect(approval?.status).toBe("denied");
    expect(approval?.denied_by_manager_id).toBe("system");
    expect(approval?.deny_reason).toBe("txn_cancelled");

    // Audit log should have a denial row with source "system" and cascaded_from_txn.
    // KIND_AUDIT["manual_payment_override"].denied === "manual_payment_override.denied" (per-kind verbs, v0.5.0)
    // Note: audit_log.metadata is stored as a JSON string by logAudit — parse before inspect.
    const auditRows = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "manual_payment_override.denied"))
        .collect(),
    );
    const txnIdStr = s.txn as unknown as string;
    const cascadeRow = auditRows.find((r) => {
      if (!r.metadata) return false;
      const meta = JSON.parse(r.metadata as unknown as string) as Record<string, unknown>;
      return String(meta.cascaded_from_txn) === txnIdStr;
    });
    expect(cascadeRow).toBeDefined();
    expect(cascadeRow?.source).toBe("system");
  });

  it("F1 idempotency replay: same-key retry still sees invoice cancelled + approval denied (no double-write)", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithSession(t);

    // Seed active invoice
    const invoiceId = await t.run((ctx) =>
      ctx.db.insert("pos_xendit_invoices", {
        transaction_id: s.txn, xendit_invoice_id: "xnd-f1",
        xendit_idempotency_key: "k-f1", method: "QRIS",
        qr_string: "qr", status_at_create: "PENDING", created_at: Date.now(),
      }),
    );
    // Seed pending approval
    const approvalId = await t.run((ctx) =>
      ctx.db.insert("pos_approval_requests", {
        kind: "manual_payment_override",
        entity_type: "pos_transactions",
        entity_id: s.txn,
        status: "pending",
        notification_channel: "telegram",
        triggered_by_event: "payment_stalled",
        triggered_at: Date.now(),
        token_hash: "f1hash".repeat(10),
        token_expires_at: Date.now() + 60 * 60 * 1000,
        context: {},
      }),
    );

    // First call — succeeds
    await t.action(api.transactions.actions.cancelTransaction, {
      sessionId: s.session, txnId: s.txn,
      reason: "f1-test", idempotencyKey: "k-f1-idem",
    });

    // Second call — same idempotencyKey (retry replay)
    const r2 = await t.action(api.transactions.actions.cancelTransaction, {
      sessionId: s.session, txnId: s.txn,
      reason: "f1-test", idempotencyKey: "k-f1-idem",
    });
    expect(r2).toEqual({ cancelled: true });

    // Invoice still in single cancelled state (no duplicate patch)
    const invoice = await t.run((ctx) => ctx.db.get(invoiceId));
    expect(invoice?.cancelled_at).toBeDefined();
    expect(invoice?.cancelled_reason).toBe("txn_cancelled");

    // Approval still in single denied state
    const approval = await t.run((ctx) => ctx.db.get(approvalId));
    expect(approval?.status).toBe("denied");

    // No duplicate invoice_cancelled audit rows
    const invoiceAudits = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "payment.invoice_cancelled"))
        .collect(),
    );
    expect(invoiceAudits.length).toBe(1);

    // No duplicate approval-denied audit rows
    const approvalAudits = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "manual_payment_override.denied"))
        .collect(),
    );
    expect(approvalAudits.length).toBe(1);
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
