import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { wibDayWindow } from "../../lib/time";

// inline seed helpers — use `as any` for terseness on full-Doc inserts;
// existing tests in this dir use the same pattern.

async function seedStaff(t: ReturnType<typeof convexTest>, args: { name: string; role: "staff" | "manager"; code: string }) {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff", { name: args.name, role: args.role, active: true, pin_hash: "x", code: args.code, created_at: 0 } as any)
  );
}

async function seedSession(t: ReturnType<typeof convexTest>, staffId: any) {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: 0, ended_at: null, end_reason: null } as any)
  );
}

async function seedPaidTxn(t: ReturnType<typeof convexTest>, args: { staffId: any; createdAt: number; total?: number }) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: args.total ?? 10_000,
      voucher_discount: 0,
      total: args.total ?? 10_000,
      flags: 0,
      staff_id: args.staffId,
      created_at: args.createdAt,
      paid_at: args.createdAt,
    } as any);
    // Seed a throwaway product row so we have a valid Id<"pos_products"> for the line.
    // _fetchDayWindow_internal projects only the snapshot fields off the line, so the
    // product doesn't need to be coherent — just needs to exist for the validator.
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "x", name: "X", pack_label: "1pc",
      price_idr: args.total ?? 10_000, active: true, sort_order: 1, tax_rate: 0,
      created_at: 0, updated_at: 0,
    } as any);
    // One line so DayTxn.lines is non-empty and downstream tests don't sweat it.
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: id,
      product_id: productId,
      product_code_snapshot: "X",
      product_name_snapshot: "X",
      unit_price_snapshot: args.total ?? 10_000,
      tax_rate_snapshot: 0,
      qty: 1,
      line_subtotal: args.total ?? 10_000,
    } as any);
    return id;
  });
}

describe("listDayTransactions", () => {
  it("returns [] for an invalid session", async () => {
    const t = convexTest(schema);
    const goneId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", { name: "X", role: "staff", active: true, pin_hash: "x", code: "X1", created_at: 0 } as any);
      const sess = await ctx.db.insert("staff_sessions", { staff_id: sid, device_id: "d1", started_at: 0, ended_at: null, end_reason: null } as any);
      await ctx.db.delete(sess);
      return sess;
    });
    const res = await t.query(api.transactions.public.listDayTransactions, { sessionId: goneId });
    expect(res).toEqual([]);
  });

  it("staff request for a past day collapses to today (no error)", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);

    const todayWin = wibDayWindow(Date.now());
    // Yesterday: shift by -1 day
    const yesterdayStart = todayWin.dayStartMs - 86_400_000;

    await seedPaidTxn(t, { staffId, createdAt: yesterdayStart + 3_600_000, total: 50_000 }); // yesterday
    await seedPaidTxn(t, { staffId, createdAt: todayWin.dayStartMs + 3_600_000, total: 30_000 }); // today

    // Build yesterday's YYYY-MM-DD label
    const wibYesterday = new Date(yesterdayStart + 7 * 60 * 60 * 1000);
    const label = `${wibYesterday.getUTCFullYear()}-${String(wibYesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(wibYesterday.getUTCDate()).padStart(2, "0")}`;

    const res = await t.query(api.transactions.public.listDayTransactions, {
      sessionId, day: label,
    });
    expect(res).toHaveLength(1);
    expect(res[0].total).toBe(30_000); // today's row only
  });

  it("manager request honours the requested past day", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "Mgr", role: "manager", code: "M1" });
    const sessionId = await seedSession(t, mgrId);

    const todayWin = wibDayWindow(Date.now());
    const yesterdayStart = todayWin.dayStartMs - 86_400_000;

    await seedPaidTxn(t, { staffId: mgrId, createdAt: yesterdayStart + 3_600_000, total: 99_000 }); // yesterday
    await seedPaidTxn(t, { staffId: mgrId, createdAt: todayWin.dayStartMs + 3_600_000, total: 11_000 }); // today

    const wibYesterday = new Date(yesterdayStart + 7 * 60 * 60 * 1000);
    const label = `${wibYesterday.getUTCFullYear()}-${String(wibYesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(wibYesterday.getUTCDate()).padStart(2, "0")}`;

    const res = await t.query(api.transactions.public.listDayTransactions, {
      sessionId, day: label,
    });
    expect(res).toHaveLength(1);
    expect(res[0].total).toBe(99_000); // yesterday's row for the manager
  });

  it("defaults to server-today when no day param given (manager)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "M2", role: "manager", code: "M2" });
    const sessionId = await seedSession(t, mgrId);

    const todayWin = wibDayWindow(Date.now());
    await seedPaidTxn(t, { staffId: mgrId, createdAt: todayWin.dayStartMs + 7_200_000, total: 12_345 });

    const res = await t.query(api.transactions.public.listDayTransactions, { sessionId });
    expect(res).toHaveLength(1);
    expect(res[0].total).toBe(12_345);
  });
});
