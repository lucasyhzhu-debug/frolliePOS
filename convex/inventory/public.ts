import { query } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";

/**
 * Reactive map of inventory_sku_id → on_hand for ACTIVE SKUs only.
 * Active-status comes from catalog via its internal API (ADR-034: inventory
 * does not read catalog-owned pos_inventory_skus directly). Consumed by
 * useCart (live cart validation) and the catalog query.
 */
export const getStockLevels = query({
  args: {},
  handler: async (ctx): Promise<Record<string, number>> => {
    const activeIds = await ctx.runQuery(
      internal.catalog.internal._getActiveSkuIds_internal,
      {},
    );
    const activeSet = new Set<Id<"pos_inventory_skus">>(activeIds);

    const levels = await ctx.db.query("pos_stock_levels").collect();
    const result: Record<string, number> = {};
    for (const lvl of levels) {
      if (activeSet.has(lvl.inventory_sku_id)) {
        result[lvl.inventory_sku_id] = lvl.on_hand;
      }
    }
    return result;
  },
});
