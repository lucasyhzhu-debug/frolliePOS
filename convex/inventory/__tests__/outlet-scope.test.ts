/**
 * outlet-scope.test.ts — v2.0 Task 9B
 *
 * Verifies that catalog + inventory reads are scoped by outlet_id when
 * sessions carry one. Seeds two outlets with their own SKUs, stock levels,
 * and sessions; then asserts each session only sees its own outlet's data.
 *
 * Known limitation: `getStockLevels` has NO sessionId and therefore is NOT
 * yet outlet-scoped (deferred to Task 12). It is tested here to document the
 * limitation, not to assert correctness.
 */

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { setupTelegramStub } from "../../__tests__/_helpers";

setupTelegramStub();

/** Seed an outlet row and return its _id. */
async function seedOutlet(t: any, name: string) {
  const code = name.toUpperCase().replace(/\s+/g, "_").slice(0, 16);
  return t.run((ctx: any) =>
    ctx.db.insert("outlets", { is_open: false,
      code,
      name,
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    }),
  );
}

/** Seed a staff + manager session pinned to a specific outlet. */
async function seedManagerSession(t: any, outletId: string, code: string) {
  return t.run(async (ctx: any) => {
    const staffId = await ctx.db.insert("staff", {
      name: `Manager ${code}`,
      code,
      pin_hash: "$argon2id$dummy",
      role: "manager",
      active: true,
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: `dev-${code}`,
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    });
    return { staffId, sessionId };
  });
}

/** Seed a staff session (non-manager) pinned to an outlet. */
async function seedStaffSession(t: any, outletId: string, code: string) {
  return t.run(async (ctx: any) => {
    const staffId = await ctx.db.insert("staff", {
      name: `Staff ${code}`,
      code,
      pin_hash: "$argon2id$dummy",
      role: "staff",
      active: true,
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: `dev-${code}`,
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    });
    return { staffId, sessionId };
  });
}

/** Seed an active inventory SKU pinned to an outlet. */
async function seedSku(t: any, sku: string, outletId: string) {
  return t.run((ctx: any) =>
    ctx.db.insert("pos_inventory_skus", {
      sku,
      name: `SKU ${sku}`,
      unit: "piece" as const,
      low_threshold: 5,
      active: true,
      created_at: Date.now(),
      outlet_id: outletId,
    }),
  );
}

/** Seed a stock level for a SKU + outlet. */
async function seedStockLevel(t: any, skuId: string, outletId: string, onHand: number) {
  return t.run((ctx: any) =>
    ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuId,
      on_hand: onHand,
      updated_at: Date.now(),
      outlet_id: outletId,
    }),
  );
}

describe("v2.0 Task 9B — outlet-scoped inventory reads", () => {
  it("listInventory: outlet A session sees only outlet A SKUs, not outlet B", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "Outlet A");
    const outletB = await seedOutlet(t, "Outlet B");

    const skuA = await seedSku(t, "sku-a", outletA);
    const skuB = await seedSku(t, "sku-b", outletB);

    await seedStockLevel(t, skuA, outletA, 50);
    await seedStockLevel(t, skuB, outletB, 30);

    const { sessionId: sessionA } = await seedStaffSession(t, outletA, "SA-001");
    const { sessionId: sessionB } = await seedStaffSession(t, outletB, "SB-001");

    const rowsA = await t.query(api.inventory.public.listInventory, { sessionId: sessionA });
    const rowsB = await t.query(api.inventory.public.listInventory, { sessionId: sessionB });

    const skuIdsA = rowsA.map((r: any) => r.skuId);
    const skuIdsB = rowsB.map((r: any) => r.skuId);

    // Outlet A sees its own SKU
    expect(skuIdsA).toContain(skuA);
    // Outlet A does NOT see outlet B's SKU
    expect(skuIdsA).not.toContain(skuB);

    // Outlet B sees its own SKU
    expect(skuIdsB).toContain(skuB);
    // Outlet B does NOT see outlet A's SKU
    expect(skuIdsB).not.toContain(skuA);
  });

  it("listInventory: correct on_hand per outlet (not cross-contaminated)", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "Store Alpha");
    const outletB = await seedOutlet(t, "Store Beta");

    // Same SKU slug but in different outlets
    const skuA = await seedSku(t, "cookie-a", outletA);
    const skuB = await seedSku(t, "cookie-b", outletB);

    await seedStockLevel(t, skuA, outletA, 100);
    await seedStockLevel(t, skuB, outletB, 7);

    const { sessionId: sessionA } = await seedStaffSession(t, outletA, "SA-002");

    const rows = await t.query(api.inventory.public.listInventory, { sessionId: sessionA });
    const rowA = rows.find((r: any) => r.skuId === skuA);

    expect(rowA).toBeDefined();
    expect(rowA!.on_hand).toBe(100);
    // B's row should not appear at all
    expect(rows.find((r: any) => r.skuId === skuB)).toBeUndefined();
  });

  it("getSkuDetail: returns outlet-scoped stock level and movements", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "Detail Outlet A");
    const outletB = await seedOutlet(t, "Detail Outlet B");

    const skuA = await seedSku(t, "detail-sku-a", outletA);

    // Stock level for outlet A (on_hand=42)
    await seedStockLevel(t, skuA, outletA, 42);
    // A spurious stock level for outlet B with different on_hand (must not bleed)
    await seedStockLevel(t, skuA, outletB, 999);

    // Movement for outlet A
    await t.run((ctx: any) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: skuA,
        qty: -3,
        source: "sale" as const,
        created_at: Date.now(),
        outlet_id: outletA,
      }),
    );
    // Movement for outlet B (must not appear in outlet A detail)
    await t.run((ctx: any) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: skuA,
        qty: -99,
        source: "sale" as const,
        created_at: Date.now(),
        outlet_id: outletB,
      }),
    );

    const { sessionId } = await seedStaffSession(t, outletA, "SA-003");

    const detail = await t.query(api.inventory.public.getSkuDetail, {
      sessionId,
      skuId: skuA,
    });

    // Reads the outlet A level (42), not outlet B's (999)
    expect(detail.on_hand).toBe(42);
    // Only outlet A's movement appears (qty -3)
    expect(detail.movements.length).toBe(1);
    expect(detail.movements[0].qty).toBe(-3);
  });

  it("listStockDrift: manager session sees only outlet-scoped drift rows", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "Drift Outlet A");
    const outletB = await seedOutlet(t, "Drift Outlet B");

    const skuA = await seedSku(t, "drift-sku-a", outletA);
    const skuB = await seedSku(t, "drift-sku-b", outletB);

    // Drift row for outlet A
    await t.run((ctx: any) =>
      ctx.db.insert("pos_stock_drift_log", {
        inventory_sku_id: skuA,
        sku_code: "drift-sku-a",
        cached_on_hand: 10,
        reconstructed_on_hand: 8,
        delta: 2,
        detected_at: Date.now(),
        outlet_id: outletA,
      }),
    );
    // Drift row for outlet B
    await t.run((ctx: any) =>
      ctx.db.insert("pos_stock_drift_log", {
        inventory_sku_id: skuB,
        sku_code: "drift-sku-b",
        cached_on_hand: 5,
        reconstructed_on_hand: 3,
        delta: 2,
        detected_at: Date.now(),
        outlet_id: outletB,
      }),
    );

    const { sessionId } = await seedManagerSession(t, outletA, "MA-001");

    const driftRows = await t.query(api.inventory.public.listStockDrift, {
      sessionId,
      includeResolved: true,
    });

    const driftSkuIds = driftRows.map((r: any) => r.inventory_sku_id);
    expect(driftSkuIds).toContain(skuA);
    expect(driftSkuIds).not.toContain(skuB);
  });

  it("_getActiveSkuIds_internal: returns only outlet-scoped active SKUs", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "SKU IDs Outlet A");
    const outletB = await seedOutlet(t, "SKU IDs Outlet B");

    const skuA = await seedSku(t, "ids-sku-a", outletA);
    await seedSku(t, "ids-sku-b", outletB);

    const idsA = await t.query(
      internal.catalog.internal._getActiveSkuIds_internal,
      { outletId: outletA },
    );

    expect(idsA).toContain(skuA);
    // Outlet B's SKU must not appear when querying for outlet A
    const idsASet = new Set(idsA);
    const allSkus: Array<{ _id: string; sku: string }> = await t.run((ctx: any) =>
      ctx.db.query("pos_inventory_skus").collect(),
    );
    const skuBId = allSkus.find((s) => s.sku === "ids-sku-b")?._id ?? "";
    expect(idsASet.has(skuBId as any)).toBe(false);
  });

  /**
   * Known limitation: getStockLevels has no sessionId so outlet_id is not
   * available. It reads globally. This test documents the limitation — do NOT
   * assert isolation here.
   */
  it("getStockLevels (no session): returns all levels globally — outlet isolation not yet implemented", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "Global A");
    const outletB = await seedOutlet(t, "Global B");

    const skuA = await seedSku(t, "global-sku-a", outletA);
    const skuB = await seedSku(t, "global-sku-b", outletB);

    await seedStockLevel(t, skuA, outletA, 10);
    await seedStockLevel(t, skuB, outletB, 20);

    const levels = await t.query(api.inventory.public.getStockLevels, {});

    // Both appear (global read — known limitation; Task 12 will fix this)
    expect(levels[skuA]).toBe(10);
    expect(levels[skuB]).toBe(20);
  });
});
