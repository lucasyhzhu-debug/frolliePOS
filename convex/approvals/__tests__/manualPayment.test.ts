"use node";

import { convexTest } from "convex-test";
import { expect, it, vi, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 42 } }),
    text: async () => "{}",
  })) as unknown as typeof fetch;
  process.env.POS_BASE_URL = "https://pos.example.com";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function seed(t: ReturnType<typeof convexTest>): Promise<{
  sessionId: Id<"staff_sessions">;
  txnId: Id<"pos_transactions">;
  staffId: Id<"staff">;
}> {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Lucy",
      code: "S-1",
      role: "staff",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    });
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers",
      chatType: "supergroup",
      title: "Mgrs",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "awaiting_payment",
      subtotal: 50000,
      voucher_discount: 0,
      total: 50000,
      flags: 0,
      staff_id: staffId,
      created_at: Date.now(),
    });
    return { sessionId, txnId, staffId };
  });
}

it("creates a pending manual_payment request and notifies managers", async () => {
  const t = convexTest(schema);
  const { sessionId, txnId } = await seed(t);

  const res = await t.action(api.approvals.actions.requestManualPaymentApproval, {
    sessionId,
    txnId,
    reason: "BCA app shows paid",
    idempotencyKey: "req-1",
  });

  expect(res.requestId).toBeDefined();

  const row = await t.run((ctx) => ctx.db.get(res.requestId));
  expect(row?.status).toBe("pending");
  expect(row?.kind).toBe("manual_payment_override");
  expect(row?.notified_at).toBeTruthy();
  // telegram_message_id is linked best-effort after notify
  expect(row?.telegram_message_id).toBe(42);
});

it("idempotency replay returns same requestId and doesn't re-fire fetch", async () => {
  const t = convexTest(schema);
  const { sessionId, txnId } = await seed(t);

  const r1 = await t.action(api.approvals.actions.requestManualPaymentApproval, {
    sessionId,
    txnId,
    reason: "x",
    idempotencyKey: "k1",
  });

  const fetchSpy = vi.mocked(fetch);
  const callsBefore = fetchSpy.mock.calls.length;

  const r2 = await t.action(api.approvals.actions.requestManualPaymentApproval, {
    sessionId,
    txnId,
    reason: "x",
    idempotencyKey: "k1",
  });

  expect(r2.requestId).toBe(r1.requestId);
  expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no additional fetch on replay
});

it("throws TXN_NOT_AWAITING when transaction is already paid", async () => {
  const t = convexTest(schema);
  const { sessionId, staffId } = await seed(t);

  const paidTxnId = await t.run((ctx) =>
    ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: 50000,
      voucher_discount: 0,
      total: 50000,
      flags: 0,
      staff_id: staffId,
      created_at: Date.now(),
    }),
  );

  await expect(
    t.action(api.approvals.actions.requestManualPaymentApproval, {
      sessionId,
      txnId: paidTxnId,
      reason: "testing",
      idempotencyKey: "req-paid",
    }),
  ).rejects.toThrow("TXN_NOT_AWAITING");
});

it("dedup: second call for same txn while request pending returns existing requestId", async () => {
  const t = convexTest(schema);
  const { sessionId, txnId } = await seed(t);

  const r1 = await t.action(api.approvals.actions.requestManualPaymentApproval, {
    sessionId,
    txnId,
    reason: "first",
    idempotencyKey: "req-dedup-1",
  });

  const r2 = await t.action(api.approvals.actions.requestManualPaymentApproval, {
    sessionId,
    txnId,
    reason: "second",
    idempotencyKey: "req-dedup-2", // different key — not an idempotency replay
  });

  expect(r2.requestId).toBe(r1.requestId);

  // Only one request row should exist
  const rows = await t.run((ctx) =>
    ctx.db.query("pos_approval_requests").collect(),
  );
  expect(rows.filter((r) => r.kind === "manual_payment_override").length).toBe(1);
});
