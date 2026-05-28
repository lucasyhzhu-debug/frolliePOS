import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

async function seedBase(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "Lucas", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const session = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "dev-1", started_at: Date.now(),
      ended_at: null, end_reason: null,
    });
    return { staff, session };
  });
}

async function insertTxn(
  t: ReturnType<typeof convexTest>,
  staffId: string,
  status: "awaiting_payment" | "paid" | "draft" | "cancelled",
  created_at: number,
  xenditId?: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("pos_transactions", {
      status,
      subtotal: 100_000,
      voucher_discount: 0,
      total: 100_000,
      flags: 0,
      staff_id: staffId as any,
      created_at,
      xendit_invoice_id_current: xenditId,
    }),
  );
}

describe("transactions/public.listRecentAwaitingPayment", () => {
  it("returns only awaiting_payment txns within last 5 minutes", async () => {
    const t = convexTest(schema);
    const { staff, session } = await seedBase(t);

    const now = Date.now();
    const recent = now - 2 * 60_000;   // 2 min ago — within window
    const old = now - 6 * 60_000;      // 6 min ago — outside window

    await insertTxn(t, staff, "awaiting_payment", recent, "xen_recent");
    await insertTxn(t, staff, "awaiting_payment", old, "xen_old");

    const result = await t.query(api.transactions.public.listRecentAwaitingPayment, {
      sessionId: session,
    });

    expect(result.length).toBe(1);
    expect(result[0].xendit_invoice_id_current).toBe("xen_recent");
  });

  it("excludes paid txns even if recent", async () => {
    const t = convexTest(schema);
    const { staff, session } = await seedBase(t);

    const now = Date.now();
    await insertTxn(t, staff, "awaiting_payment", now - 60_000, "xen_pending");
    await insertTxn(t, staff, "paid", now - 60_000, "xen_paid");

    const result = await t.query(api.transactions.public.listRecentAwaitingPayment, {
      sessionId: session,
    });

    expect(result.length).toBe(1);
    expect(result[0].xendit_invoice_id_current).toBe("xen_pending");
  });

  it("returns [] when session is invalid (session ended)", async () => {
    const t = convexTest(schema);
    // Insert a real staff row so the validator is satisfied, then create an
    // ended session — _resolveSession_internal returns null for ended sessions.
    const fakeSession = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        name: "Ghost", pin_hash: "x", role: "staff", active: false, created_at: Date.now(),
      });
      return ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev",
        started_at: Date.now(),
        ended_at: Date.now(), // ended → _resolveSession_internal returns null
        end_reason: "manual_lock",
      });
    });

    const result = await t.query(api.transactions.public.listRecentAwaitingPayment, {
      sessionId: fakeSession,
    });

    expect(result).toEqual([]);
  });

  it("returns [] when no recent awaiting_payment txns exist", async () => {
    const t = convexTest(schema);
    const { session } = await seedBase(t);

    const result = await t.query(api.transactions.public.listRecentAwaitingPayment, {
      sessionId: session,
    });

    expect(result).toEqual([]);
  });
});
