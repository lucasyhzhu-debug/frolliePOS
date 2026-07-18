import { describe, it, expect, beforeEach, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// The ops report (on failed/max-attempts/401) schedules a Telegram alert action.
// Stub Telegram at module scope to avoid "Write outside of transaction" errors.
setupTelegramStub();

const MAX_ATTEMPTS = 5;

function stubFetch(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(status === 200 ? "ok" : "err", { status })),
  );
}

async function insertPending(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    xendit_qr_id: string;
    xendit_payment_id: string;
    attempts: number;
    status: "pending" | "delivered" | "failed";
    created_at: number;
    next_attempt_at: number;
    delivered_at: number;
  }> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("pos_qris_forward_outbox", {
      raw_payload: JSON.stringify({ event: "qr.payment", data: { qr_id: "q1" } }),
      xendit_qr_id: overrides.xendit_qr_id ?? "q1",
      xendit_payment_id: overrides.xendit_payment_id,
      status: overrides.status ?? "pending",
      attempts: overrides.attempts ?? 0,
      created_at: overrides.created_at ?? now,
      next_attempt_at: overrides.next_attempt_at ?? now,
      delivered_at: overrides.delivered_at,
    });
  });
}

describe("payments/forwarder", () => {
  beforeEach(() => {
    process.env.XENDIT_CALLBACK_TOKEN = "tok-test-1234567890";
    process.env.FROLLIE_FORWARD_SECRET = "fwd-secret-abc";
    stubFetch(200);
  });

  it("enqueue dedups on the (qr_id, payment_id) pair → Xendit redelivery inserts exactly one row", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "dup-1",
      xendit_payment_id: "pay-1",
    });
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "dup-1",
      xendit_payment_id: "pay-1",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("pos_qris_forward_outbox")
        .withIndex("by_qr_payment", (q) => q.eq("xendit_qr_id", "dup-1"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    await drainScheduled(t); // enqueue schedules _deliverForward (runAfter 0)
  });

  it("a SECOND payment on the same qr_id (different payment_id) inserts its own row — not silently dropped", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "multi-1",
      xendit_payment_id: "pay-A",
    });
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "multi-1",
      xendit_payment_id: "pay-B",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("pos_qris_forward_outbox")
        .withIndex("by_qr_payment", (q) => q.eq("xendit_qr_id", "multi-1"))
        .collect(),
    );
    // One QR, two genuine payments → two forwards. Deduping on qr_id alone
    // would lose payment B on a money path.
    expect(rows).toHaveLength(2);
    await drainScheduled(t);
  });

  it("enqueue re-drives a STALE pending row (dead chain) — Xendit redelivery is the recovery path", async () => {
    const t = convexTest(schema);
    // A pending row whose next_attempt_at is >10min past = chain died before
    // any terminal/retry mutation. No new row; a fresh delivery is scheduled.
    const id = await insertPending(t, {
      xendit_qr_id: "stale-1",
      xendit_payment_id: "pay-S",
      next_attempt_at: Date.now() - 11 * 60_000,
    });
    stubFetch(200);
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "stale-1",
      xendit_payment_id: "pay-S",
    });
    await drainScheduled(t); // runs the re-driven _deliverForward
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("delivered");
  });

  it("enqueue does NOT re-drive a live pending row (next_attempt_at recent) — single-chain invariant holds", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t, {
      xendit_qr_id: "live-1",
      xendit_payment_id: "pay-L",
      next_attempt_at: Date.now() + 60_000, // in-flight chain, retry scheduled
    });
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "live-1",
      xendit_payment_id: "pay-L",
    });
    await drainScheduled(t);
    const row = await t.run(async (ctx) => ctx.db.get(id));
    // Untouched: still pending, no duplicate delivery fired by the enqueue.
    expect(row?.status).toBe("pending");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POS-owned qr_id (row in pos_xendit_invoices) is NOT enqueued — booth sales don't forward to RM", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null, is_open: false,
      } as any);
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      });
      const txn = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 25_000, voucher_discount: 0,
        total: 25_000, flags: 0, staff_id: staff, created_at: Date.now(),
        outlet_id: outletId,
      } as any);
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txn, xendit_invoice_id: "qr_pos_own",
        xendit_idempotency_key: "k", method: "QRIS", qr_string: "qr",
        status_at_create: "PENDING", created_at: Date.now(), outlet_id: outletId,
      } as any);
    });
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "qr_pos_own",
      xendit_payment_id: "pay-X",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("pos_qris_forward_outbox").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("enqueue inserts one pending row with attempts 0", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "new-1",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("pos_qris_forward_outbox").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
    await drainScheduled(t); // enqueue schedules _deliverForward (runAfter 0)
  });

  it("200 → delivered, hits hardcoded RM URL with both auth headers", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t);
    stubFetch(200);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("delivered");
    expect(row?.delivered_at).toBeTypeOf("number");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://decisive-wombat-7.convex.site/api/xendit/qr-payment");
    const headers = call[1].headers;
    expect(headers["x-callback-token"]).toBe("tok-test-1234567890");
    expect(headers["x-frollie-forward-secret"]).toBe("fwd-secret-abc");
    // Byte-identical re-POST is the core contract — RM re-parses the raw envelope.
    // A regression that JSON-round-trips or wraps the body would break RM matching.
    expect(call[1].body).toBe(JSON.stringify({ event: "qr.payment", data: { qr_id: "q1" } }));
  });

  it("500 → still pending, attempts incremented, next_attempt_at pushed out", async () => {
    const t = convexTest(schema);
    const createdAt = Date.now();
    const id = await insertPending(t, { created_at: createdAt });
    stubFetch(500);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row!.next_attempt_at).toBeGreaterThan(createdAt);
  });

  it("max attempts → failed + ops error report", async () => {
    const t = convexTest(schema);
    // Seed one below MAX so this try exhausts it (MAX_ATTEMPTS - 1 = 4).
    const id = await insertPending(t, { attempts: MAX_ATTEMPTS - 1 });
    stubFetch(500);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("failed");
    // The terminal try IS counted — a stuck failed row reads the true try count.
    expect(row?.attempts).toBe(MAX_ATTEMPTS);

    const reports = await t.run(async (ctx) =>
      ctx.db.query("pos_error_reports").collect(),
    );
    const forwarderReport = reports.find((r) => r.route === "convex/payments/forwarder");
    expect(forwarderReport).toBeDefined();
    // The alert/record names the exact payment to reconcile (money path).
    expect(forwarderReport!.message).toContain("qr=q1");
    await drainScheduled(t); // ops report schedules a Telegram alert (runAfter 0)
  });

  it("401 → failed immediately (terminal, not retried) + ops report names the qr", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t, { attempts: 0 });
    stubFetch(401);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("failed");
    // Terminal after ONE try: attempts is 1 (that try counted), NOT driven to MAX.
    expect(row?.attempts).toBe(1);

    const reports = await t.run(async (ctx) =>
      ctx.db.query("pos_error_reports").collect(),
    );
    const forwarderReport = reports.find((r) => r.route === "convex/payments/forwarder");
    expect(forwarderReport).toBeDefined();
    expect(forwarderReport!.message).toContain("qr=q1");
    await drainScheduled(t); // ops report schedules a Telegram alert (runAfter 0)
  });

  it("fetch throws (connection error) → retry path: still pending, attempts incremented", async () => {
    const t = convexTest(schema);
    const createdAt = Date.now();
    const id = await insertPending(t, { created_at: createdAt });
    // Exercises the catch (e) branch — a dropped/hung RM connection, the failure
    // the outbox exists to survive. stubFetch only ever returns Responses, so
    // this throwing stub is the only coverage of that path.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row!.next_attempt_at).toBeGreaterThan(createdAt);
  });

  it("FROLLIE_FORWARD_SECRET absent → no POST; retry path with a config-naming error (self-heals once set)", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t);
    delete process.env.FROLLIE_FORWARD_SECRET; // beforeEach re-sets it next test
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    // No POST with an empty secret header (that would draw a TERMINAL 401 from
    // RM on attempt 1). The row stays pending on the retry ladder so setting
    // the env var self-heals it, and the error names the actual problem.
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain("FROLLIE_FORWARD_SECRET");
  });

  it("FROLLIE_FORWARD_URL env override redirects the POST (dev → RM-dev smoke); default otherwise", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t);
    process.env.FROLLIE_FORWARD_URL = "https://rm-dev.example.convex.site/api/xendit/qr-payment";
    try {
      stubFetch(200);
      await t.action(internal.payments.forwarder._deliverForward, { id });
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("https://rm-dev.example.convex.site/api/xendit/qr-payment");
    } finally {
      delete process.env.FROLLIE_FORWARD_URL;
    }
  });

  it("_requeueFailed_internal: failed rows → pending with attempts reset + delivery re-scheduled (break-glass)", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t, {
      xendit_qr_id: "rq-1", status: "failed", attempts: MAX_ATTEMPTS,
    });
    stubFetch(200);
    const res = await t.mutation(internal.payments.forwarder._requeueFailed_internal, {});
    expect(res.requeued).toBe(1);
    await drainScheduled(t); // runs the re-scheduled _deliverForward
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("delivered");
  });

  it("_purgeDeliveredForwards_internal: old delivered rows purged; fresh delivered + failed rows kept", async () => {
    const t = convexTest(schema);
    const now = Date.now();
    const oldDelivered = await insertPending(t, {
      xendit_qr_id: "purge-old", status: "delivered",
      delivered_at: now - 31 * 24 * 60 * 60_000,
    });
    const freshDelivered = await insertPending(t, {
      xendit_qr_id: "purge-fresh", status: "delivered", delivered_at: now,
    });
    const failed = await insertPending(t, {
      xendit_qr_id: "purge-failed", status: "failed",
      created_at: now - 60 * 24 * 60 * 60_000,
    });
    const res = await t.mutation(internal.payments.forwarder._purgeDeliveredForwards_internal, {});
    expect(res.purged).toBe(1);
    const [oldRow, freshRow, failedRow] = await t.run(async (ctx) =>
      Promise.all([ctx.db.get(oldDelivered), ctx.db.get(freshDelivered), ctx.db.get(failed)]),
    );
    expect(oldRow).toBeNull();          // purged
    expect(freshRow).not.toBeNull();    // within retention
    expect(failedRow).not.toBeNull();   // forensics — never purged
  });

  it("non-pending row is a no-op (fetch not called)", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t, { status: "delivered" });
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("delivered");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
