import { internalQuery } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/**
 * Active inventory SKU ids. Exposed so other modules (e.g. inventory) can
 * filter by active status without reaching into catalog-owned tables
 * directly (ADR-034 module boundary).
 */
export const _getActiveSkuIds_internal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"pos_inventory_skus">[]> => {
    const skus = await ctx.db
      .query("pos_inventory_skus")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return skus.map((s) => s._id);
  },
});
