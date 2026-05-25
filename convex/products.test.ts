import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

describe("catalog", () => {
  it("returns products, skus, components, stock levels", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await t.run(async (ctx) => {
      const dubaiSku = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai cookie", unit: "piece",
        low_threshold: 5, active: true, created_at: Date.now(),
      });
      const dubai3 = await ctx.db.insert("pos_products", {
        sku_family: "dubai", name: "Dubai", pack_label: "3 pcs", price_idr: 125000,
        active: true, sort_order: 1, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      await ctx.db.insert("pos_product_components", {
        product_id: dubai3, inventory_sku_id: dubaiSku, qty: 3,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: dubaiSku, on_hand: 18, updated_at: Date.now(),
      });
    });

    const c = await t.query(api.products.catalog, {});
    expect(c.skus).toHaveLength(1);
    expect(c.products).toHaveLength(1);
    expect(c.components).toHaveLength(1);
    expect(c.stockLevels).toHaveLength(1);
    expect(c.stockLevels[0].on_hand).toBe(18);
  });

  it("excludes inactive products + skus", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_inventory_skus", {
        sku: "x", name: "X", unit: "piece", low_threshold: 0,
        active: false, created_at: Date.now(),
      });
    });
    const c = await t.query(api.products.catalog, {});
    expect(c.skus).toHaveLength(0);
  });
});
