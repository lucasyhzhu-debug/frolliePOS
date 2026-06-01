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

  it("throws INVALID_DAY for a malformed day label (manager)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "Mgr", role: "manager", code: "M9" });
    const sessionId = await seedSession(t, mgrId);
    await expect(
      t.query(api.transactions.public.listDayTransactions, { sessionId, day: "not-a-date" })
    ).rejects.toThrow(/INVALID_DAY/);
    await expect(
      t.query(api.transactions.public.listDayTransactions, { sessionId, day: "2026-02-30" })
    ).rejects.toThrow(/INVALID_DAY/);
  });
});

describe("dashboardSummary", () => {
  it("throws MANAGER_ONLY for a staff session", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "Sari", role: "staff", code: "S1" });
    const sessionId = await seedSession(t, staffId);
    await expect(
      t.query(api.transactions.public.dashboardSummary, { sessionId })
    ).rejects.toThrow(/MANAGER_ONLY/);
  });

  it("throws on an invalid session (NO_SESSION)", async () => {
    const t = convexTest(schema);
    const goneId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", { name: "X", role: "manager", active: true, pin_hash: "x", code: "X1", created_at: 0 } as any);
      const sess = await ctx.db.insert("staff_sessions", { staff_id: sid, device_id: "d1", started_at: 0, ended_at: null, end_reason: null } as any);
      await ctx.db.delete(sess);
      return sess;
    });
    await expect(
      t.query(api.transactions.public.dashboardSummary, { sessionId: goneId })
    ).rejects.toThrow();
  });

  it("returns an all-zero summary for a day with no sales", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "Mgr", role: "manager", code: "M1" });
    const sessionId = await seedSession(t, mgrId);
    const s = await t.query(api.transactions.public.dashboardSummary, { sessionId });
    expect(s.gross).toBe(0);
    expect(s.refundsTotal).toBe(0);
    expect(s.net).toBe(0);
    expect(s.count).toBe(0);
    expect(s.avgBasket).toBe(0);
    expect(s.topSkus).toEqual([]);
    expect(s.hourlyCurve).toHaveLength(24);
    expect(s.hourlyCurve.every((n: number) => n === 0)).toBe(true);
    expect(s.perStaff).toEqual([]);
    expect(s.needsAttention).toEqual({ flagged: 0 });
    expect(s.voucherUsage).toEqual({ count: 0, total: 0 });
    expect(s.paymentMix).toEqual({
      qris: { count: 0, total: 0 },
      bca_va: { count: 0, total: 0 },
      unknown: { count: 0, total: 0 },
    });
  });

  it("throws INVALID_DAY for a malformed day label", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "Mgr", role: "manager", code: "M9" });
    const sessionId = await seedSession(t, mgrId);
    await expect(
      t.query(api.transactions.public.dashboardSummary, { sessionId, day: "garbage" })
    ).rejects.toThrow(/INVALID_DAY/);
  });

  it("aggregates a day's paid txns (gross/net/count/avgBasket)", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "Mgr2", role: "manager", code: "M2" });
    const sessionId = await seedSession(t, mgrId);
    const todayWin = wibDayWindow(Date.now());
    await seedPaidTxn(t, { staffId: mgrId, createdAt: todayWin.dayStartMs + 3_600_000, total: 30_000 });
    await seedPaidTxn(t, { staffId: mgrId, createdAt: todayWin.dayStartMs + 7_200_000, total: 20_000 });

    const s = await t.query(api.transactions.public.dashboardSummary, { sessionId });
    expect(s.gross).toBe(50_000);
    expect(s.count).toBe(2);
    expect(s.avgBasket).toBe(25_000);
    expect(s.net).toBe(50_000); // no refunds
  });
});

describe("getTransactionDetail", () => {
  it("returns null for an invalid session", async () => {
    const t = convexTest(schema);
    const goneId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", { name: "X", role: "staff", active: true, pin_hash: "x", code: "X1", created_at: 0 } as any);
      const sess = await ctx.db.insert("staff_sessions", { staff_id: sid, device_id: "d1", started_at: 0, ended_at: null, end_reason: null } as any);
      await ctx.db.delete(sess);
      return { sessionId: sess };
    });
    // Use any valid-looking txn id — handler returns null on missing session before reading txn.
    const fakeTxnId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("staff", { name: "Y", role: "staff", active: true, pin_hash: "x", code: "Y1", created_at: 0 } as any);
      const id = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 1000, voucher_discount: 0, total: 1000, flags: 0,
        staff_id: sid, created_at: 0, paid_at: 0,
      } as any);
      return id;
    });
    const res = await t.query(api.transactions.public.getTransactionDetail, {
      sessionId: goneId.sessionId, txnId: fakeTxnId,
    });
    expect(res).toBeNull();
  });

  it("returns null for a missing txn", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "S", role: "staff", code: "S2" });
    const sessionId = await seedSession(t, staffId);
    const goneTxnId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 1000, voucher_discount: 0, total: 1000, flags: 0,
        staff_id: staffId, created_at: 0, paid_at: 0,
      } as any);
      await ctx.db.delete(id);
      return id;
    });
    const res = await t.query(api.transactions.public.getTransactionDetail, {
      sessionId, txnId: goneTxnId,
    });
    expect(res).toBeNull();
  });

  it("returns null for a staff read of a prior-day txn (today-collapse semantics)", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "S3", role: "staff", code: "S3" });
    const sessionId = await seedSession(t, staffId);
    const todayWin = wibDayWindow(Date.now());
    const yesterdayStart = todayWin.dayStartMs - 86_400_000;
    const yTxnId = await seedPaidTxn(t, { staffId, createdAt: yesterdayStart + 3_600_000, total: 50_000 });
    const res = await t.query(api.transactions.public.getTransactionDetail, { sessionId, txnId: yTxnId });
    expect(res).toBeNull();
  });

  it("a manager may read a prior-day txn", async () => {
    const t = convexTest(schema);
    const mgrId = await seedStaff(t, { name: "M", role: "manager", code: "M3" });
    const sessionId = await seedSession(t, mgrId);
    const todayWin = wibDayWindow(Date.now());
    const yesterdayStart = todayWin.dayStartMs - 86_400_000;
    const yTxnId = await seedPaidTxn(t, { staffId: mgrId, createdAt: yesterdayStart + 3_600_000, total: 77_000 });
    const res = await t.query(api.transactions.public.getTransactionDetail, { sessionId, txnId: yTxnId });
    expect(res?.txn.total).toBe(77_000);
    expect(res?.refundStatus).toBe("none");
    expect(res?.lines).toHaveLength(1);
  });

  it("returns refundStatus 'none' for a today txn without refunds", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, { name: "S4", role: "staff", code: "S4" });
    const sessionId = await seedSession(t, staffId);
    const todayWin = wibDayWindow(Date.now());
    const txnId = await seedPaidTxn(t, { staffId, createdAt: todayWin.dayStartMs + 7_200_000, total: 25_000 });
    const res = await t.query(api.transactions.public.getTransactionDetail, { sessionId, txnId });
    expect(res?.refundStatus).toBe("none");
    expect(res?.lines).toHaveLength(1);
  });
});
