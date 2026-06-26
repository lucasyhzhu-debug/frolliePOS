/**
 * outlet-write.test.ts — v2.0 Task 9E
 *
 * Verifies write-side outlet stamping for catalog creates and stock movements.
 *
 * Tests:
 *   1. _createProductCommit_internal with outletId → product row has outlet_id
 *   2. _createProductCommit_internal bundled SKU path → SKU + component have outlet_id
 *   3. _createInventorySkuCommit_internal with outletId → sku row has outlet_id
 *   4. _recordSaleMovement_internal with outlet_id → movement + level carry outlet_id
 *   5. recordRecount with outlet-stamped session → movement rows carry outlet_id
 */

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { setupTelegramStub } from "../../__tests__/_helpers";

setupTelegramStub();

// ─── Shared seed helpers ───────────────────────────────────────────────────

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

async function seedManager(t: any, outletId: string, code: string) {
  return t.run(async (ctx: any) => {
    const managerId = await ctx.db.insert("staff", {
      name: `Manager ${code}`,
      code,
      pin_hash: "$argon2id$dummy",
      role: "manager",
      active: true,
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: managerId,
      device_id: `dev-${code}`,
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    });
    return { managerId, sessionId };
  });
}

async function seedStaffSessionWithOutlet(t: any, outletId: string, code: string) {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("v2.0 Task 9E — outlet_id stamping on catalog creates and stock movements", () => {
  // ── Catalog creates ──────────────────────────────────────────────────────

  it("_createProductCommit_internal: stamps outlet_id on the product row", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t, "Product Write Outlet");
    const { managerId } = await seedManager(t, outletId, "P-MGR-01");

    const { productId } = await t.mutation(
      internal.catalog.internal._createProductCommit_internal,
      {
        idempotencyKey: "test:product-stamp:commit",
        mgrId: managerId,
        deviceId: "dev-P-MGR-01",
        sku_family: "dubai",
        code: "DUBAI_1PC",
        name: "Dubai 1pc",
        pack_label: "1pc",
        price_idr: 50000,
        tax_rate: 0,
        sort_order: 1,
        outletId,
      },
    );

    const product: any = await t.run((ctx: any) => ctx.db.get(productId));
    expect(product).not.toBeNull();
    expect(product.outlet_id).toBe(outletId);
  });

  it("_createProductCommit_internal bundled-SKU: stamps outlet_id on both SKU and component rows", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t, "Bundled SKU Outlet");
    const { managerId } = await seedManager(t, outletId, "B-MGR-01");

    const result = await t.mutation(
      internal.catalog.internal._createProductCommit_internal,
      {
        idempotencyKey: "test:bundled-stamp:commit",
        mgrId: managerId,
        deviceId: "dev-B-MGR-01",
        sku_family: "matcha",
        code: "MATCHA_3PC",
        name: "Matcha 3pc",
        pack_label: "3pc",
        price_idr: 120000,
        tax_rate: 0,
        sort_order: 2,
        outletId,
        withInventorySku: true,
        inventorySkuLowThreshold: 5,
        inventorySkuComponentQty: 3,
      },
    );

    expect(result.inventorySkuId).toBeDefined();
    expect(result.skuCreated).toBe(true);

    // SKU row carries outlet_id
    const sku: any = await t.run((ctx: any) => ctx.db.get(result.inventorySkuId!));
    expect(sku).not.toBeNull();
    expect(sku.outlet_id).toBe(outletId);

    // Product row carries outlet_id
    const product: any = await t.run((ctx: any) => ctx.db.get(result.productId));
    expect(product.outlet_id).toBe(outletId);

    // Component row carries outlet_id
    const components: any[] = await t.run((ctx: any) =>
      ctx.db
        .query("pos_product_components")
        .withIndex("by_product", (q: any) => q.eq("product_id", result.productId))
        .collect(),
    );
    expect(components).toHaveLength(1);
    expect(components[0].outlet_id).toBe(outletId);
  });

  it("_createInventorySkuCommit_internal: stamps outlet_id on the SKU row", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t, "SKU Write Outlet");
    const { managerId } = await seedManager(t, outletId, "S-MGR-01");

    const { skuId } = await t.mutation(
      internal.catalog.internal._createInventorySkuCommit_internal,
      {
        idempotencyKey: "test:sku-stamp:commit",
        mgrId: managerId,
        deviceId: "dev-S-MGR-01",
        sku: "lotus-cookie",
        name: "Lotus Cookie",
        low_threshold: 3,
        outletId,
      },
    );

    const sku: any = await t.run((ctx: any) => ctx.db.get(skuId));
    expect(sku).not.toBeNull();
    expect(sku.outlet_id).toBe(outletId);
  });

  // v2.0 Task 12 (ENFORCE): the prior "omits outlet_id when outletId not
  // supplied" migration-window test was removed — `_createInventorySkuCommit_internal`
  // now requires `outletId` (v.id("outlets")), so omitting it is a hard
  // validator error rather than a tolerated absence.

  // ── Stock movement writes ────────────────────────────────────────────────

  it("_recordSaleMovement_internal: stamps outlet_id on movement + stock level", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t, "Sale Movement Outlet");

    const { txnId, lineId, skuId } = await t.run(async (ctx: any) => {
      const staffId = await ctx.db.insert("staff", {
        name: "Sale Staff",
        code: "SAL-01",
        pin_hash: "$argon2id$dummy",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai",
        code: "DUBAI_T",
        name: "Dubai Test",
        pack_label: "1pc",
        price_idr: 50000,
        tax_rate: 0,
        sort_order: 1,
        active: true,
        created_at: Date.now(),
        updated_at: Date.now(),
        outlet_id: outletId,
      });
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "sale-sku",
        name: "Sale SKU",
        unit: "piece" as const,
        low_threshold: 5,
        active: true,
        created_at: Date.now(),
        outlet_id: outletId,
      });
      // Seed initial stock so low-stock check doesn't fire (on_hand=100 > threshold=5)
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuId,
        on_hand: 100,
        updated_at: Date.now(),
        outlet_id: outletId,
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        staff_id: staffId,
        subtotal: 50000,
        voucher_discount: 0,
        total: 50000,
        status: "paid",
        paid_at: Date.now(),
        created_at: Date.now(),
        flags: 0,
        outlet_id: outletId,
      });
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId,
        product_id: productId,
        product_code_snapshot: "DUBAI_T",
        product_name_snapshot: "Dubai Test",
        unit_price_snapshot: 50000,
        tax_rate_snapshot: 0,
        qty: 2,
        line_subtotal: 100000,
        outlet_id: outletId,
      });
      return { txnId, lineId, skuId };
    });

    await t.mutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: txnId,
      lines: [{ lineId, skuId, qty: 2 }],
      outlet_id: outletId,
    });

    const movements: any[] = await t.run((ctx: any) =>
      ctx.db
        .query("pos_stock_movements")
        .withIndex("by_sku_created", (q: any) => q.eq("inventory_sku_id", skuId))
        .collect(),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0].outlet_id).toBe(outletId);
    expect(movements[0].qty).toBe(-2);

    // stock level should also carry outlet_id
    const level: any = await t.run((ctx: any) =>
      ctx.db
        .query("pos_stock_levels")
        .withIndex("by_outlet_sku", (q: any) =>
          q.eq("outlet_id", outletId).eq("inventory_sku_id", skuId),
        )
        .first(),
    );
    expect(level).not.toBeNull();
    expect(level.outlet_id).toBe(outletId);
    expect(level.on_hand).toBe(98); // 100 - 2
  });

  it("recordRecount: stamps outlet_id on movement rows written by a session-pinned recount", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t, "Recount Outlet");

    const { sessionId, staffId, skuId } = await t.run(async (ctx: any) => {
      const staffId = await ctx.db.insert("staff", {
        name: "Recount Staff",
        code: "RC-01",
        pin_hash: "$argon2id$dummy",
        role: "staff",
        active: true,
        created_at: Date.now(),
      });
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-rc",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      });
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "recount-sku",
        name: "Recount SKU",
        unit: "piece" as const,
        low_threshold: 2,
        active: true,
        created_at: Date.now(),
        outlet_id: outletId,
      });
      // Current on_hand = 5; entering 10 → delta = +5
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuId,
        on_hand: 5,
        updated_at: Date.now(),
        outlet_id: outletId,
      });
      return { sessionId, staffId, skuId };
    });

    await t.mutation(api.inventory.public.recordRecount, {
      idempotencyKey: "test:recount-outlet",
      sessionId,
      counts: [{ skuId, entered: 10 }],
    });

    const movements: any[] = await t.run((ctx: any) =>
      ctx.db
        .query("pos_stock_movements")
        .withIndex("by_sku_created", (q: any) => q.eq("inventory_sku_id", skuId))
        .collect(),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0].source).toBe("recount");
    // v2.0 Task 9E: movement row should carry the session outlet's outlet_id
    expect(movements[0].outlet_id).toBe(outletId);
  });
});
