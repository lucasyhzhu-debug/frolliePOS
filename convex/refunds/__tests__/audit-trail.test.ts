"use node";

import { convexTest } from "convex-test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { createHash } from "node:crypto";
import { Id } from "../../_generated/dataModel";

/**
 * End-to-end audit verification for the refund subsystem.
 *
 *   refund.requested        ← _createRequest_internal (kind=refund) → source=system
 *                              (KIND_AUDIT[refund].requested; emitted in the requested
 *                              helper with source: "system" per current implementation.)
 *   refund.committed        ← _commitRefund_internal → source=approvalSource arg
 *                              (booth_inline | telegram_approval). Always emitted
 *                              once per committed refund — booth path emits ONLY this.
 *   refund.approval_resolved ← _markResolved_internal (Telegram path only) →
 *                              source=telegram_approval. C2 (post-review): pre-C2 this
 *                              emitted "refund.committed" too, double-counting refunds
 *                              on dashboards. Now distinct: counts approval-row state
 *                              transitions, not refunds.
 *   refund.denied           ← _markDenied_internal via denyRequest → source=telegram_approval
 *                              (KIND_AUDIT[refund].denied).
 *   refund.settled          ← markRefundSettled → source=booth_inline (manager session).
 */

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 33 } }),
    text: async () => "{}",
  })) as unknown as typeof fetch;
  process.env.POS_BASE_URL = "https://pos.example.com";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const MGR_CODE = "M-AUDIT";
const MGR_PIN = "9911";

async function seedPaidTxnWithRealManager(t: ReturnType<typeof convexTest>) {
  // Manager with a real argon2 hash so verifyPinOrThrow can succeed.
  const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
    name: "Manager Audit",
    pin: MGR_PIN,
    role: "manager",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(mgrId, { code: MGR_CODE });
  });

  return await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
    const staffId = await ctx.db.insert("staff", {
      code: "S-AUDIT", name: "Audit Staff", role: "staff", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    } as any);
    const mgrSessionId = await ctx.db.insert("staff_sessions", {
      staff_id: mgrId, device_id: "d", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    } as any);
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers", chatType: "supergroup", title: "Mgrs",
      role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
    });
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
      price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(), outlet_id: outletId,
    } as any);
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
      flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
      receipt_number: "R-2026-0500", receipt_token: "tok-audit-trail", outlet_id: outletId,
    } as any);
    const lineId = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId, product_id: productId,
      product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: 50000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 50000, outlet_id: outletId,
    } as any);
    return { sessionId, mgrSessionId, staffId, mgrId, txnId, lineId };
  });
}

// Inline-only audit query helper: the typed `convexTest` ctx narrows withIndex
// on `audit_log.by_action_date` correctly when the closure has direct access to
// the schema-bound t. Pulling this into a helper widens the ctx generics and
// loses the index narrowing — so we inline at each call site.

describe("refund audit trail", () => {
  it("requestRefundApproval → emits refund.requested (actor=requester, source=system)", async () => {
    const t = convexTest(schema);
    const { sessionId, staffId, txnId, lineId } = await seedPaidTxnWithRealManager(t);

    await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "audit-req-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "wrong order",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.requested"))
        .collect(),
    );
    expect(rows.length).toBe(1);
    // _createRequest_internal sets actor_id = requester_staff_id and source = "system".
    expect(rows[0].actor_id).toBe(staffId);
    expect(rows[0].source).toBe("system");
  });

  it("_commitRefund_internal (booth_inline) → refund.committed with source=booth_inline", async () => {
    const t = convexTest(schema);
    const { staffId, mgrId, txnId, lineId } = await seedPaidTxnWithRealManager(t);

    await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "audit-commit-booth-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "booth path",
      requestedBy: staffId,
      approverId: mgrId,
      approvalSource: "booth_inline",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.committed"))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("booth_inline");
    expect(rows[0].actor_id).toBe(mgrId);
  });

  it("_commitRefund_internal (telegram_approval) → refund.committed with source=telegram_approval", async () => {
    const t = convexTest(schema);
    const { staffId, mgrId, txnId, lineId } = await seedPaidTxnWithRealManager(t);

    await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "audit-commit-tg-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "telegram path",
      requestedBy: staffId,
      approverId: mgrId,
      approvalSource: "telegram_approval",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.committed"))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("telegram_approval");
    expect(rows[0].actor_id).toBe(mgrId);
  });

  it("markRefundSettled → emits refund.settled with source=booth_inline", async () => {
    const t = convexTest(schema);
    const { staffId, mgrSessionId, mgrId, txnId, lineId } = await seedPaidTxnWithRealManager(t);

    // First commit a refund directly (bypass PIN) so we have a refund to settle.
    const { refundId } = await t.mutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: "audit-commit-settle-1",
        transactionId: txnId,
        lines: [{ line_id: lineId, qty: 1 }],
        reason: "to-be-settled",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      },
    );

    await t.mutation(api.refunds.public.markRefundSettled, {
      sessionId: mgrSessionId,
      idempotencyKey: "audit-settle-1",
      refundId,
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.settled"))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("booth_inline");
    expect(rows[0].actor_id).toBe(mgrId);
  });

  it("approveRefund (telegram path) → emits ONE refund.committed + ONE refund.approval_resolved (C2)", async () => {
    // C2 regression: pre-C2, KIND_AUDIT.refund.resolved === "refund.committed",
    // so the Telegram path emitted refund.committed TWICE (once from
    // _commitRefund_internal, once from _markResolved_internal). After C2 the
    // resolve verb is "refund.approval_resolved", so the two events are now
    // distinguishable: exactly one of each per Telegram-approved refund.
    const t = convexTest(schema);
    const { staffId, txnId, lineId } = await seedPaidTxnWithRealManager(t);

    const rawToken = "audit-c2-tg-token";
    const outletId = await t.run(async (ctx) => {
      const outlet = await ctx.db.query("outlets").first();
      return outlet!._id;
    });
    await t.mutation(internal.approvals.internal._createRequest_internal, {
      kind: "refund",
      requester_staff_id: staffId,
      entity_type: "pos_transactions",
      entity_id: txnId as unknown as string,
      outletId,
      context: {
        txn_id: txnId as unknown as string,
        receipt_number: "R-2026-0500",
        lines: [
          {
            line_id: lineId as unknown as string,
            product_name: "Dubai 1pc",
            refund_qty: 1,
            refund_amount: 50000,
          },
        ],
        total_refund: 50000,
        reason: "telegram path c2 check",
      },
      reason: "telegram path c2 check",
      triggered_by_event: "refund_request",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() + 3_600_000,
    });

    await t.action(api.approvals.actions.approveRefund, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: MGR_PIN,
      idempotencyKey: "audit-c2-approve-1",
    });

    const committedRows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.committed"))
        .collect(),
    );
    const resolvedRows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.approval_resolved"))
        .collect(),
    );
    // Exactly one of each — proves verbs are now distinct (no double-emit).
    expect(committedRows.length).toBe(1);
    expect(committedRows[0].source).toBe("telegram_approval");
    expect(committedRows[0].entity_type).toBe("pos_refunds");
    expect(resolvedRows.length).toBe(1);
    expect(resolvedRows[0].source).toBe("telegram_approval");
    expect(resolvedRows[0].entity_type).toBe("pos_approval_requests");
  });

  it("denyRequest (refund kind) → emits refund.denied with source=telegram_approval", async () => {
    const t = convexTest(schema);
    const { staffId, txnId } = await seedPaidTxnWithRealManager(t);

    // Seed a pending refund approval request with a known raw token. We can't
    // round-trip via requestRefundApproval easily (it mints its own token).
    // Use _createRequest_internal directly with kind=refund + a refund context.
    const rawToken = "audit-deny-raw-token";
    const outletId = await t.run(async (ctx) => {
      const outlet = await ctx.db.query("outlets").first();
      return outlet!._id;
    });
    const { requestId } = await t.mutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "refund",
        requester_staff_id: staffId,
        entity_type: "pos_transactions",
        entity_id: txnId as unknown as string,
        outletId,
        context: {
          txn_id: txnId as unknown as string,
          receipt_number: "R-2026-0500",
          lines: [
            { line_id: "stub-line-id", product_name: "Dubai 1pc", refund_qty: 1, refund_amount: 50000 },
          ],
          total_refund: 50000,
          reason: "looks wrong",
        },
        reason: "looks wrong",
        triggered_by_event: "refund_request",
        triggered_at: Date.now(),
        token_hash: sha256Hex(rawToken),
        token_expires_at: Date.now() + 3_600_000,
      },
    );
    expect(requestId).toBeDefined();

    // Now deny via the kind-agnostic deny action.
    await t.action(api.approvals.actions.denyRequest, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: MGR_PIN,
      denyReason: "rejected on review",
      idempotencyKey: "audit-deny-1",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.denied"))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("telegram_approval");
  });
});
