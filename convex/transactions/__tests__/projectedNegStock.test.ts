import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_projectedNegStockFlag_internal", () => {
  it("staffreview T4: multi-product-same-SKU cart sums qtys across products", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const dubai = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 0,
        active: true, created_at: Date.now(),
      });
      const p1pc = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBAI_1PC", name: "Dubai 1pc", pack_label: "1pc",
        price_idr: 25_000, active: true, sort_order: 1, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      const p8pc = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pc", pack_label: "8pc",
        price_idr: 200_000, active: true, sort_order: 2, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      await ctx.db.insert("pos_product_components", {
        product_id: p1pc, inventory_sku_id: dubai, qty: 1,
      });
      await ctx.db.insert("pos_product_components", {
        product_id: p8pc, inventory_sku_id: dubai, qty: 8,
      });
      return { dubai, p1pc, p8pc };
    });

    // on_hand = 10; 1pc (needs 1) + 8pc (needs 8) = 9 total → OK, flag=false
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: setup.dubai, on_hand: 10, updated_at: Date.now(),
      });
    });
    const flag1 = await t.query(internal.transactions.internal._projectedNegStockFlag_internal, {
      lines: [{ productId: setup.p1pc, qty: 1 }, { productId: setup.p8pc, qty: 1 }],
    });
    expect(flag1).toBe(false);

    // Drain to 8; 1+8=9 > 8 → flag=true
    await t.run(async (ctx) => {
      const lvl = await ctx.db.query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", setup.dubai)).first();
      await ctx.db.patch(lvl!._id, { on_hand: 8 });
    });
    const flag2 = await t.query(internal.transactions.internal._projectedNegStockFlag_internal, {
      lines: [{ productId: setup.p1pc, qty: 1 }, { productId: setup.p8pc, qty: 1 }],
    });
    expect(flag2).toBe(true);
  });
});
