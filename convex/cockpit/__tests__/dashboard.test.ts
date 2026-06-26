/**
 * convex/cockpit/__tests__/dashboard.test.ts
 *
 * TDD for Task 7: cross-outlet dashboard queries.
 *
 * Scenario: 2 active outlets, a cockpit owner session, one paid transaction
 * per outlet inside today's WIB day window.
 *
 * Assertions:
 *  - perOutletSummary: 2 rows, each with the correct per-outlet split (including refundTotal).
 *    The consolidated headline is derived client-side by summing all rows.
 */
import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { wibDayWindow } from "../../lib/time";

// ── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Seed an owner staff member + an active cockpit session (last_active_at = now).
 * Mirrors the seedCockpitSession helper from outlets.test.ts.
 */
async function seedCockpitSession(ctx: any): Promise<{
  owner: any;
  session: any;
}> {
  const owner = await ctx.db.insert("staff", {
    name: "Owner",
    code: "OWN1",
    role: "owner",
    pin_hash: "x",
    active: true,
    created_at: 1,
  });
  const session = await ctx.db.insert("staff_sessions", {
    staff_id: owner,
    device_id: "cockpit-device",
    kind: "cockpit",
    started_at: Date.now(),
    last_active_at: Date.now(),
    ended_at: null,
    end_reason: null,
  });
  return { owner, session };
}

/**
 * Seed an active outlet row. Returns the outlet Id.
 */
async function seedOutlet(
  ctx: any,
  code: string,
  name: string,
): Promise<any> {
  return ctx.db.insert("outlets", { is_open: false,
    code,
    name,
    timezone: "Asia/Jakarta",
    active: true,
    created_at: 1,
    created_by: null,
  } as any);
}

/**
 * Seed a staff member (role: "staff") for transaction authorship.
 */
async function seedStaff(ctx: any, code: string): Promise<any> {
  return ctx.db.insert("staff", {
    name: code,
    code,
    role: "staff",
    pin_hash: "x",
    active: true,
    created_at: 1,
  } as any);
}

/**
 * Seed a paid transaction with one line inside the given WIB day window.
 * paid_at is set inside the window (dayStartMs + 1h) so _fetchDayWindow_internal
 * picks it up (it indexes on paid_at).
 */
async function seedPaidTxn(
  ctx: any,
  opts: {
    outletId: any;
    staffId: any;
    total: number;
    dayStartMs: number;
  },
): Promise<any> {
  const paidAt = opts.dayStartMs + 3_600_000; // 1h into the day
  const txnId = await ctx.db.insert("pos_transactions", {
    status: "paid",
    subtotal: opts.total,
    voucher_discount: 0,
    total: opts.total,
    flags: 0,
    staff_id: opts.staffId,
    created_at: opts.dayStartMs,
    paid_at: paidAt,
    outlet_id: opts.outletId,
  } as any);
  // A minimal product row — _fetchDayWindow_internal projects snapshot fields
  // from the line, not the product; product just needs to exist for the FK.
  const productId = await ctx.db.insert("pos_products", {
    sku_family: "test",
    code: `P_${opts.outletId}`,
    name: "Test Product",
    pack_label: "1pc",
    price_idr: opts.total,
    active: true,
    sort_order: 1,
    tax_rate: 0,
    created_at: 0,
    updated_at: 0,
    outlet_id: opts.outletId,
  } as any);
  await ctx.db.insert("pos_transaction_lines", {
    transaction_id: txnId,
    product_id: productId,
    product_code_snapshot: "TEST",
    product_name_snapshot: "Test Product",
    unit_price_snapshot: opts.total,
    tax_rate_snapshot: 0,
    qty: 1,
    line_subtotal: opts.total,
    outlet_id: opts.outletId,
  } as any);
  return txnId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("perOutletSummary returns 2 rows with correct per-outlet split", async () => {
  const t = convexTest(schema);
  const { dayStartMs } = wibDayWindow(Date.now());

  const { session } = await t.run(async (ctx) => {
    const o1 = await seedOutlet(ctx, "P1", "Outlet P1");
    const o2 = await seedOutlet(ctx, "P2", "Outlet P2");
    const s1 = await seedStaff(ctx, "STP1");
    const s2 = await seedStaff(ctx, "STP2");
    await seedPaidTxn(ctx, { outletId: o1, staffId: s1, total: 50_000, dayStartMs });
    await seedPaidTxn(ctx, { outletId: o2, staffId: s2, total: 70_000, dayStartMs });
    return seedCockpitSession(ctx);
  });

  const rows = await t.query(api.cockpit.dashboard.perOutletSummary, {
    sessionId: session,
  });

  expect(rows.length).toBe(2);

  const p1 = rows.find((r: any) => r.code === "P1");
  const p2 = rows.find((r: any) => r.code === "P2");

  expect(p1).toBeDefined();
  expect(p1!.txnCount).toBe(1);
  expect(p1!.gross).toBe(50_000);

  expect(p2).toBeDefined();
  expect(p2!.txnCount).toBe(1);
  expect(p2!.gross).toBe(70_000);
  expect(p1!.refundTotal).toBe(0);
  expect(p2!.refundTotal).toBe(0);
});
