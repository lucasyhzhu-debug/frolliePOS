"use node";

import { convexTest } from "convex-test";
import { expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

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

// ─── approveManualPayment (Task 21) ─────────────────────────────────────────
// Off-booth approve path: a manager opens the /approve/:token link and confirms
// payment with their own PIN. Mirrors approveStaffPinReset's envelope (token
// sha256 + constant-time compare, manager-by-code resolve, argon2 verify,
// failed-attempt path, action-level idempotency).

const MGR_CODE = "S-9";
const MGR_PIN = "9999";

async function seedApprovable(t: ReturnType<typeof convexTest>): Promise<{
  txnId: Id<"pos_transactions">;
  requestId: Id<"pos_approval_requests">;
  rawToken: string;
  mgrId: Id<"staff">;
  staffId: Id<"staff">;
}> {
  // Manager with a REAL argon2 hash (so argon2Verify can succeed).
  const mgrId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
    name: "Manager",
    pin: MGR_PIN,
    role: "manager",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(mgrId, { code: MGR_CODE });
  });

  const { staffId, txnId } = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Lucy",
      code: "S-1",
      role: "staff",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
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
    return { staffId, txnId };
  });

  const rawToken = "raw-token-approve-mp";
  const { requestId } = await t.mutation(
    internal.approvals.internal._createRequest_internal,
    {
      kind: "manual_payment_override",
      requester_staff_id: staffId,
      entity_type: "pos_transactions",
      entity_id: txnId as unknown as string,
      context: {
        txn_id: txnId as unknown as string,
        amount_idr: 50000,
        reason: "BCA app shows paid",
      },
      reason: "BCA app shows paid",
      triggered_by_event: "manual_payment_request",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() + 3_600_000,
    },
  );

  return { txnId, requestId, rawToken, mgrId, staffId };
}

it("approves: manager PIN confirms payment + resolves request", async () => {
  const t = convexTest(schema);
  const { txnId, requestId, rawToken } = await seedApprovable(t);

  const res = await t.action(api.approvals.actions.approveManualPayment, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    idempotencyKey: "appr-1",
  });
  expect(res.resolved).toBe(true);

  const txn = await t.run((ctx) => ctx.db.get(txnId));
  expect(txn?.status).toBe("paid");
  expect(txn?.confirmed_via).toBe("manual");

  const req = await t.run((ctx) => ctx.db.get(requestId));
  expect(req?.status).toBe("resolved");
});

it("audits payment.confirmed with source=telegram_approval (NOT booth_inline) on off-booth approve", async () => {
  const t = convexTest(schema);
  const { rawToken } = await seedApprovable(t);

  await t.action(api.approvals.actions.approveManualPayment, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    idempotencyKey: "appr-src",
  });

  const confirmRows = await t.run((ctx) =>
    ctx.db
      .query("audit_log")
      .withIndex("by_action_date", (q) => q.eq("action", "payment.confirmed"))
      .collect(),
  );
  expect(confirmRows.length).toBe(1);
  expect(confirmRows[0].source).toBe("telegram_approval");
});

it("wrong PIN throws INVALID_PIN and records a failed attempt against the manager", async () => {
  const t = convexTest(schema);
  const { rawToken, mgrId } = await seedApprovable(t);

  await expect(
    t.action(api.approvals.actions.approveManualPayment, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: "0000", // wrong
      idempotencyKey: "appr-wrong",
    }),
  ).rejects.toThrow("INVALID_PIN");

  const attempt = await t.run((ctx) =>
    ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", mgrId))
      .first(),
  );
  expect(attempt?.fail_count).toBe(1);
});

it("idempotency replay: same key returns cached result without firing twice", async () => {
  const t = convexTest(schema);
  const { txnId, requestId, rawToken } = await seedApprovable(t);

  const r1 = await t.action(api.approvals.actions.approveManualPayment, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    idempotencyKey: "appr-replay",
  });
  const r2 = await t.action(api.approvals.actions.approveManualPayment, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    idempotencyKey: "appr-replay",
  });
  expect(r2).toEqual(r1);

  // Only one payment.confirmed audit row — no double-execution.
  const confirmRows = await t.run((ctx) =>
    ctx.db
      .query("audit_log")
      .withIndex("by_action_date", (q) => q.eq("action", "payment.confirmed"))
      .collect(),
  );
  expect(confirmRows.length).toBe(1);

  // Txn paid + request resolved exactly once.
  const txn = await t.run((ctx) => ctx.db.get(txnId));
  expect(txn?.status).toBe("paid");
  const req = await t.run((ctx) => ctx.db.get(requestId));
  expect(req?.status).toBe("resolved");
});

// ─── denyRequest (Task 22) ───────────────────────────────────────────────────
// Kind-agnostic off-booth deny. Works for any pending request
// (staff_pin_reset, manual_payment_override, any future kind — NO kind guard).

it("denies: request goes to denied, txn stays awaiting_payment", async () => {
  const t = convexTest(schema);
  const { txnId, requestId, rawToken } = await seedApprovable(t);

  const res = await t.action(api.approvals.actions.denyRequest, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    denyReason: "looks wrong",
    idempotencyKey: "deny-1",
  });
  expect(res.denied).toBe(true);

  // Transaction must remain untouched (deny doesn't confirm payment).
  const txn = await t.run((ctx) => ctx.db.get(txnId));
  expect(txn?.status).toBe("awaiting_payment");

  // Request must be in denied status.
  const req = await t.run((ctx) => ctx.db.get(requestId));
  expect(req?.status).toBe("denied");
});

it("denyRequest wrong PIN throws INVALID_PIN and records a failed attempt against the manager", async () => {
  const t = convexTest(schema);
  const { rawToken, mgrId } = await seedApprovable(t);

  await expect(
    t.action(api.approvals.actions.denyRequest, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: "0000", // wrong
      denyReason: "rejected",
      idempotencyKey: "deny-wrong",
    }),
  ).rejects.toThrow("INVALID_PIN");

  const attempt = await t.run((ctx) =>
    ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", mgrId))
      .first(),
  );
  expect(attempt?.fail_count).toBe(1);
});

it("denyRequest idempotency replay: same key returns same {denied:true} without re-executing", async () => {
  const t = convexTest(schema);
  const { requestId, rawToken } = await seedApprovable(t);

  const r1 = await t.action(api.approvals.actions.denyRequest, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    denyReason: "looks wrong",
    idempotencyKey: "deny-replay",
  });
  const r2 = await t.action(api.approvals.actions.denyRequest, {
    token: rawToken,
    managerStaffCode: MGR_CODE,
    managerPin: MGR_PIN,
    denyReason: "looks wrong",
    idempotencyKey: "deny-replay",
  });
  expect(r2).toEqual(r1);

  // Request status is denied exactly once — the row's denied_at is present once.
  const req = await t.run((ctx) => ctx.db.get(requestId));
  expect(req?.status).toBe("denied");
  expect(req?.denied_at).toBeDefined();

  // No pos_auth_attempts written (PIN was correct on first call, replay never re-verifies).
  const attempts = await t.run((ctx) =>
    ctx.db.query("pos_auth_attempts").collect(),
  );
  expect(attempts.length).toBe(0);
});
