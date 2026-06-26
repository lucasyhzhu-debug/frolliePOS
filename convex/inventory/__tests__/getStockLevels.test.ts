import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

describe("inventory/public.getStockLevels", () => {
  it("returns on_hand only for active SKUs, omits inactive", async () => {
    const t = convexTest(schema);
    const now = Date.now();

    const { activeSkuId, inactiveSkuId } = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: now, created_by: null,
      } as never);
      const activeSkuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 5,
        active: true, created_at: now, outlet_id: outletId,
      });
      const inactiveSkuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "retired", name: "Retired SKU", unit: "piece", low_threshold: 0,
        active: false, created_at: now, outlet_id: outletId,
      });
      // Stock levels for both SKUs.
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: activeSkuId, on_hand: 12, updated_at: now, outlet_id: outletId,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: inactiveSkuId, on_hand: 99, updated_at: now, outlet_id: outletId,
      });
      return { activeSkuId, inactiveSkuId };
    });

    const levels = await t.query(api.inventory.public.getStockLevels, {});

    // Active SKU's on_hand present.
    expect(levels[activeSkuId]).toBe(12);
    // Inactive SKU must be absent from result — active filter applied.
    expect(levels[inactiveSkuId]).toBeUndefined();
  });
});
