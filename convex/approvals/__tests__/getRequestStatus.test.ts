import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function seedRequest(
  t: ReturnType<typeof convexTest>,
  opts: { tokenExpiresAt: number },
): Promise<Id<"pos_approval_requests">> {
  return await t.run(async (ctx) => {
    const outletId = await (ctx.db as any).insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    });
    return await (ctx.db as any).insert("pos_approval_requests", {
      kind: "manual_payment_override",
      entity_type: "pos_transactions",
      entity_id: "t1",
      context: { txn_id: "t1", amount_idr: 10000, reason: "test" },
      triggered_by_event: "manual_payment_request",
      triggered_at: Date.now(),
      token_hash: "test-hash-" + Math.random(),
      token_expires_at: opts.tokenExpiresAt,
      status: "pending",
      outlet_id: outletId,
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getRequestStatus", () => {
  it("returns null for unknown requestId", async () => {
    const t = convexTest(schema);
    // Use a well-formed but non-existent ID by seeding then using a fake id shape
    const reqId = await seedRequest(t, { tokenExpiresAt: Date.now() + 60_000 });
    // Delete it so we get a missing row
    await t.run(async (ctx) => { await ctx.db.delete(reqId); });
    const result = await t.query(api.approvals.public.getRequestStatus, { requestId: reqId });
    expect(result).toBeNull();
  });

  it("returns pending for a live (not-yet-expired) pending row", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema);
    const expiry = Date.now() + 60_000;
    const reqId = await seedRequest(t, { tokenExpiresAt: expiry });

    vi.setSystemTime(expiry - 1);
    const result = await t.query(api.approvals.public.getRequestStatus, { requestId: reqId });
    expect(result?.status).toBe("pending");
  });

  it("returns expired for a pending row past its token_expires_at (latent bug closed)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema);
    const expiry = Date.now() + 1_000;
    const reqId = await seedRequest(t, { tokenExpiresAt: expiry });

    // Advance time past expiry — DB row stays "pending", effective status is "expired"
    vi.setSystemTime(expiry + 1);
    const result = await t.query(api.approvals.public.getRequestStatus, { requestId: reqId });
    expect(result?.status).toBe("expired");
  });

  it("returns expired at exactly token_expires_at (boundary inclusive)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema);
    const expiry = Date.now() + 1_000;
    const reqId = await seedRequest(t, { tokenExpiresAt: expiry });

    vi.setSystemTime(expiry);
    const result = await t.query(api.approvals.public.getRequestStatus, { requestId: reqId });
    expect(result?.status).toBe("expired");
  });

  it("returns resolved for a resolved row (terminal wins over time)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema);
    const expiry = Date.now() - 60_000; // already past
    const reqId = await seedRequest(t, { tokenExpiresAt: expiry });
    // Manually set to resolved
    await t.run(async (ctx) => {
      await ctx.db.patch(reqId, { status: "resolved", resolved_at: Date.now() - 1_000 });
    });

    const result = await t.query(api.approvals.public.getRequestStatus, { requestId: reqId });
    expect(result?.status).toBe("resolved");
  });

  it("returns denied for a denied row (terminal wins over time)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema);
    const expiry = Date.now() - 60_000; // already past
    const reqId = await seedRequest(t, { tokenExpiresAt: expiry });
    await t.run(async (ctx) => {
      await ctx.db.patch(reqId, { status: "denied", denied_at: Date.now() - 1_000 });
    });

    const result = await t.query(api.approvals.public.getRequestStatus, { requestId: reqId });
    expect(result?.status).toBe("denied");
  });
});
