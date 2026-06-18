import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

describe("catalog", () => {
  it("returns products, skus, components, stock levels, and active vouchers", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const dubaiSku = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai cookie", unit: "piece",
        low_threshold: 5, active: true, created_at: Date.now(),
      });
      const dubai3 = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBAI_3PC", name: "Dubai", pack_label: "3 pcs", price_idr: 125000,
        active: true, sort_order: 1, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      await ctx.db.insert("pos_product_components", {
        product_id: dubai3, inventory_sku_id: dubaiSku, qty: 3,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: dubaiSku, on_hand: 18, updated_at: Date.now(),
      });
      // Active voucher — should appear in catalog snapshot (ADR-009)
      await ctx.db.insert("pos_vouchers", {
        code: "WELCOME10", type: "percentage", value: 10,
        active: true, used_count: 0, created_at: Date.now(),
      });
      // Inactive voucher — should be excluded
      await ctx.db.insert("pos_vouchers", {
        code: "DEAD20", type: "amount", value: 20000,
        active: false, used_count: 0, created_at: Date.now(),
      });
    });

    const c = await t.query(api.catalog.public.catalog, {});
    expect(c.skus).toHaveLength(1);
    expect(c.products).toHaveLength(1);
    expect(c.components).toHaveLength(1);
    expect(c.stockLevels).toHaveLength(1);
    expect(c.stockLevels[0].on_hand).toBe(18);
    // Vouchers: only the active one
    expect(c.vouchers).toHaveLength(1);
    expect(c.vouchers[0].code).toBe("WELCOME10");
  });

  it("excludes inactive products + skus", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_inventory_skus", {
        sku: "x", name: "X", unit: "piece", low_threshold: 0,
        active: false, created_at: Date.now(),
      });
    });
    const c = await t.query(api.catalog.public.catalog, {});
    expect(c.skus).toHaveLength(0);
  });

  // Fix 9 — deactivated product's components are excluded
  it("excludes components for inactive products (Fix 9)", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const sku = await ctx.db.insert("pos_inventory_skus", {
        sku: "choc", name: "Choc", unit: "piece",
        low_threshold: 0, active: true, created_at: Date.now(),
      });
      const activeProduct = await ctx.db.insert("pos_products", {
        sku_family: "choc", code: "CHOC_1PC", name: "Active Product", pack_label: "1 pc", price_idr: 50000,
        active: true, sort_order: 1, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      const inactiveProduct = await ctx.db.insert("pos_products", {
        sku_family: "choc", code: "CHOC_3PC", name: "Inactive Product", pack_label: "3 pcs", price_idr: 120000,
        active: false, sort_order: 2, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      // One component for active product, one for inactive
      await ctx.db.insert("pos_product_components", {
        product_id: activeProduct, inventory_sku_id: sku, qty: 1,
      });
      await ctx.db.insert("pos_product_components", {
        product_id: inactiveProduct, inventory_sku_id: sku, qty: 3,
      });
    });

    const c = await t.query(api.catalog.public.catalog, {});
    // Only the active product is returned
    expect(c.products).toHaveLength(1);
    // Only the component belonging to the active product
    expect(c.components).toHaveLength(1);
    expect(c.components[0].qty).toBe(1);
  });

  // Fix 9 — deactivated SKU's stock levels are excluded
  it("excludes stock levels for inactive SKUs (Fix 9)", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const activeSku = await ctx.db.insert("pos_inventory_skus", {
        sku: "active-sku", name: "Active SKU", unit: "piece",
        low_threshold: 0, active: true, created_at: Date.now(),
      });
      const inactiveSku = await ctx.db.insert("pos_inventory_skus", {
        sku: "inactive-sku", name: "Inactive SKU", unit: "piece",
        low_threshold: 0, active: false, created_at: Date.now(),
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: activeSku, on_hand: 10, updated_at: Date.now(),
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: inactiveSku, on_hand: 99, updated_at: Date.now(),
      });
    });

    const c = await t.query(api.catalog.public.catalog, {});
    // Only the active SKU's stock level
    expect(c.stockLevels).toHaveLength(1);
    expect(c.stockLevels[0].on_hand).toBe(10);
  });
});
