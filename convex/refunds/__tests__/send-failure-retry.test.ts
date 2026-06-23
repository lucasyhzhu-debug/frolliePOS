"use node";

import { convexTest } from "convex-test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

/**
 * Send-failure recovery for refunds.requestRefundApproval (B9).
 *
 * Contract: if the Telegram send (sendTemplate) throws, the pending approval
 * request row must be DELETED so the dedup guard doesn't lock out retries for
 * the full 60-minute TTL. Then a subsequent retry mints a fresh request cleanly.
 *
 * Implementation pulls global fetch — when fetch throws, sendTemplate throws,
 * the catch in requestRefundApproval calls `_deleteRequest_internal`, and the
 * action re-throws. The next call should succeed (with a different idempotency
 * key — same-key would short-circuit via the action-level cache).
 */

const realFetch = globalThis.fetch;

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
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
    const staffId = await ctx.db.insert("staff", {
      code: "S-SF", name: "SF", role: "staff", active: true,
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
      receipt_number: "R-2026-0099", receipt_token: "tok-send-fail", outlet_id: outletId,
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

describe("requestRefundApproval send-failure recovery", () => {
  it("first call: sendTemplate throws → pending row deleted; second call mints a fresh request", async () => {
    const t = convexTest(schema);
    const { sessionId, txnId, lineId } = await seedPaidTxnWithSession(t);

    process.env.POS_BASE_URL = "https://pos.example.com";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    // First call: fetch throws → sendTemplate throws → requestRefundApproval
    // catches, deletes the pending request, and re-throws.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      t.action(api.refunds.actions.requestRefundApproval, {
        sessionId,
        idempotencyKey: "send-fail-1",
        transactionId: txnId,
        lines: [{ line_id: lineId, qty: 1 }],
        reason: "first attempt",
      }),
    ).rejects.toThrow();

    // Pending refund-kind request should NOT exist: it was deleted in the
    // recovery branch. No stuck row to block dedup for 60min.
    const pendingAfterFail = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .filter((q) => q.eq(q.field("kind"), "refund"))
        .collect(),
    );
    expect(pendingAfterFail.length).toBe(0);

    // Now restore fetch + retry under a DIFFERENT idempotency key. (Same key
    // would short-circuit if the failed branch had cached — it didn't, but
    // we keep the keys distinct for clarity.)
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
      text: async () => "{}",
    })) as unknown as typeof fetch;

    const r2 = await t.action(api.refunds.actions.requestRefundApproval, {
      sessionId,
      idempotencyKey: "send-fail-2",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "retry attempt",
    });
    expect(r2.requestId).toBeDefined();

    // A fresh request exists with a fresh token_hash. (We don't assert the
    // hash equals anything specific — just that the row is back and pending.)
    const refundReqs = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .filter((q) => q.eq(q.field("kind"), "refund"))
        .collect(),
    );
    expect(refundReqs.length).toBe(1);
    expect(refundReqs[0]._id).toBe(r2.requestId);
    expect(refundReqs[0].status).toBe("pending");
    expect(refundReqs[0].notified_at).toBeTruthy();
    expect(refundReqs[0].token_hash).toBeTruthy();
  });
});
