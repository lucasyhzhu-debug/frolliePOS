import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { wibDayWindow } from "../../lib/time";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "Lucy", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
    });
    const manager = await ctx.db.insert("staff", {
      name: "Lucas", code: "S-0002", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const staffSession = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "d", started_at: Date.now(), ended_at: null, end_reason: null,
    });
    const mgrSession = await ctx.db.insert("staff_sessions", {
      staff_id: manager, device_id: "d", started_at: Date.now(), ended_at: null, end_reason: null,
    });
    const endedSession = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "d", started_at: Date.now(), ended_at: Date.now(), end_reason: "manual_lock",
    });
    return { staff, manager, staffSession, mgrSession, endedSession };
  });
}

async function insertTxn(
  t: ReturnType<typeof convexTest>,
  staffId: Id<"staff">,
  createdAt: number,
  extra: Record<string, unknown> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
      flags: 0, staff_id: staffId, created_at: createdAt, ...extra,
    }),
  );
}

describe("SEC-05: getById is session-gated + strips receipt_token", () => {
  it("returns null for an invalid (ended) session", async () => {
    const t = convexTest(schema);
    const s = await seed(t);
    const txnId = await insertTxn(t, s.staff, Date.now());
    const r = await t.query(api.transactions.public.getById, {
      sessionId: s.endedSession, txnId,
    });
    expect(r).toBeNull();
  });

  it("staff cannot read another day's txn (returns null)", async () => {
    const t = convexTest(schema);
    const s = await seed(t);
    // Created well before today's WIB window start.
    const yesterday = wibDayWindow(Date.now()).dayStartMs - 1;
    const txnId = await insertTxn(t, s.staff, yesterday);
    const r = await t.query(api.transactions.public.getById, {
      sessionId: s.staffSession, txnId,
    });
    expect(r).toBeNull();
  });

  it("manager CAN read another day's txn", async () => {
    const t = convexTest(schema);
    const s = await seed(t);
    const yesterday = wibDayWindow(Date.now()).dayStartMs - 1;
    const txnId = await insertTxn(t, s.staff, yesterday);
    const r = await t.query(api.transactions.public.getById, {
      sessionId: s.mgrSession, txnId,
    });
    expect(r?._id).toBe(txnId);
  });

  it("never returns receipt_token", async () => {
    const t = convexTest(schema);
    const s = await seed(t);
    const txnId = await insertTxn(t, s.staff, Date.now(), {
      receipt_token: "super-secret-capability-token",
      receipt_number: "R-2026-0001",
      confirmed_via: "manual",
    });
    const r = await t.query(api.transactions.public.getById, {
      sessionId: s.mgrSession, txnId,
    });
    expect(r).not.toBeNull();
    expect(r as Record<string, unknown>).not.toHaveProperty("receipt_token");
    // FE-consumed fields still present.
    expect(r?.receipt_number).toBe("R-2026-0001");
    expect(r?.confirmed_via).toBe("manual");
    expect(r?.total).toBe(50000);
  });
});
