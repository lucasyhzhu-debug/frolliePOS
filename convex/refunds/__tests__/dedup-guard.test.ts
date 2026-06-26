"use node";

import { convexTest } from "convex-test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

/**
 * Dedup guard test for refunds.requestRefundApproval (B9).
 *
 * Contract: two back-to-back calls with DIFFERENT idempotency keys for the same
 * txn must return the SAME requestId (the dedup helper finds the live pending
 * request) AND the Telegram fetch must fire exactly ONCE.
 *
 * The action is "use node" — convex-test runs it in the Node runtime. We mock
 * global fetch (mirror manualPayment.test.ts pattern) so the Telegram POST is
 * a no-op that returns { ok: true, result: { message_id: N } }.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 99 } }),
    text: async () => "{}",
  })) as unknown as typeof fetch;
  process.env.POS_BASE_URL = "https://pos.example.com";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function seedPaidTxnWithSession(t: ReturnType<typeof convexTest>): Promise<{
  sessionId: Id<"staff_sessions">;
  txnId: Id<"pos_transactions">;
  lineId: Id<"pos_transaction_lines">;
}> {
  return await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
    const staffId = await ctx.db.insert("staff", {
      code: "S-DD", name: "DD", role: "staff", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d", started_at: Date.now(),
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
      receipt_number: "R-2026-0042", receipt_token: "tok-dedup-1", outlet_id: outletId,
    } as any);
    const lineId = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId, product_id: productId,
      product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: 50000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 50000, outlet_id: outletId,
    } as any);
    return { sessionId, txnId, lineId };
  });
}

describe("requestRefundApproval dedup guard", () => {
  it("second call with DIFFERENT idempotency key returns the existing requestId; no second Telegram fetch", async () => {
    const t = convexTest(schema);
    const { sessionId, txnId, lineId } = await seedPaidTxnWithSession(t);

    const r1 = await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "refund-req-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "wrong flavour",
    });
    expect(r1.requestId).toBeDefined();

    const fetchSpy = vi.mocked(fetch);
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Distinct key → not an idempotency-cache replay; this exercises the
    // `_findPendingRefundForTxn_internal` dedup path inside the action.
    // N5: same context (same lines + same reason) → legitimate replay,
    // returns the existing requestId.
    const r2 = await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "refund-req-2",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "wrong flavour",
    });
    expect(r2.requestId).toBe(r1.requestId);

    // No additional Telegram POST on dedup.
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);

    // Only ONE refund-kind approval request row exists.
    const rows = await t.run((ctx) =>
      ctx.db.query("pos_approval_requests").collect(),
    );
    expect(rows.filter((r) => r.kind === "refund").length).toBe(1);
  });

  it("second call with DIFFERENT context (different qty) throws REFUND_REQUEST_PENDING_DIFFERENT", async () => {
    // N5: prevent dedup-shadowing. Staff submitted qty=1; then submits qty=3
    // with a fresh idempotencyKey. Pre-N5 the action returned the OLD requestId
    // and the manager would approve the OLD card (qty=1) — wrong intent. Now
    // it throws so staff knows the prior request must resolve/deny first.
    const t = convexTest(schema);
    const { sessionId, txnId, lineId } = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-DIFF", name: "Diff", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "d", started_at: Date.now(),
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
        status: "paid", subtotal: 150000, voucher_discount: 0, total: 150000,
        flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-DIFF-0001", receipt_token: "tok-diff-1", outlet_id: outletId,
      } as any);
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
        unit_price_snapshot: 50000, tax_rate_snapshot: 0,
        qty: 3, line_subtotal: 150000, outlet_id: outletId,
      } as any);
      return { sessionId, txnId, lineId };
    });

    await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "refund-req-diff-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "wrong flavour",
    });

    // Same txn, fresh key, DIFFERENT qty → reject.
    await expect(
      t.action(api.refunds.actions.requestRefundApproval, {
        sessionId,
        idempotencyKey: "refund-req-diff-2",
        transactionId: txnId,
        lines: [{ line_id: lineId, qty: 3 }],
        reason: "wrong flavour",
      }),
    ).rejects.toThrow(/REFUND_REQUEST_PENDING_DIFFERENT/);

    // Same txn, fresh key, same qty but DIFFERENT reason → also reject.
    await expect(
      t.action(api.refunds.actions.requestRefundApproval, {
        sessionId,
        idempotencyKey: "refund-req-diff-3",
        transactionId: txnId,
        lines: [{ line_id: lineId, qty: 1 }],
        reason: "different reason",
      }),
    ).rejects.toThrow(/REFUND_REQUEST_PENDING_DIFFERENT/);
  });

  it("same-key replay also returns the same requestId (action-level idempotency cache hit)", async () => {
    const t = convexTest(schema);
    const { sessionId, txnId, lineId } = await seedPaidTxnWithSession(t);

    const r1 = await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "refund-same-key",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "first",
    });

    const fetchSpy = vi.mocked(fetch);
    const callsAfterFirst = fetchSpy.mock.calls.length;

    const r2 = await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "refund-same-key",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "first",
    });
    expect(r2.requestId).toBe(r1.requestId);
    // Cache hit: no Telegram fetch on replay.
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
