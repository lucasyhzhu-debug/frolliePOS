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
    attempts: number;
    status: "pending" | "delivered" | "failed";
    created_at: number;
  }> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("pos_qris_forward_outbox", {
      raw_payload: JSON.stringify({ event: "qr.payment", data: { qr_id: "q1" } }),
      xendit_qr_id: overrides.xendit_qr_id ?? "q1",
      status: overrides.status ?? "pending",
      attempts: overrides.attempts ?? 0,
      created_at: overrides.created_at ?? now,
      next_attempt_at: now,
    });
  });
}

describe("payments/forwarder", () => {
  beforeEach(() => {
    process.env.XENDIT_CALLBACK_TOKEN = "tok-test-1234567890";
    process.env.FROLLIE_FORWARD_SECRET = "fwd-secret-abc";
    stubFetch(200);
  });

  it("enqueue dedups by xendit_qr_id → exactly one pending row", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "dup-1",
    });
    await t.mutation(internal.payments.forwarder._enqueueForward_internal, {
      raw_payload: "{}",
      xendit_qr_id: "dup-1",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("pos_qris_forward_outbox")
        .withIndex("by_xendit_qr_id", (q) => q.eq("xendit_qr_id", "dup-1"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    await drainScheduled(t); // enqueue schedules _deliverForward (runAfter 0)
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

    const reports = await t.run(async (ctx) =>
      ctx.db.query("pos_error_reports").collect(),
    );
    expect(reports.some((r) => r.route === "convex/payments/forwarder")).toBe(true);
    await drainScheduled(t); // ops report schedules a Telegram alert (runAfter 0)
  });

  it("401 → failed immediately (terminal, not retried) + ops report", async () => {
    const t = convexTest(schema);
    const id = await insertPending(t, { attempts: 0 });
    stubFetch(401);
    await t.action(internal.payments.forwarder._deliverForward, { id });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("failed");
    // Proves it did NOT go through the retry path (attempts stays 0, not MAX).
    expect(row?.attempts).toBe(0);

    const reports = await t.run(async (ctx) =>
      ctx.db.query("pos_error_reports").collect(),
    );
    expect(reports.some((r) => r.route === "convex/payments/forwarder")).toBe(true);
    await drainScheduled(t); // ops report schedules a Telegram alert (runAfter 0)
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
