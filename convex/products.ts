import { query } from "./_generated/server";

/**
 * Single payload for the catalog screen + offline cache. Persisted to IDB
 * client-side by useCatalogCache (Task 8.5) so cold starts work offline.
 * available_qty per product is computed client-side (ADR-017) from the
 * components + stockLevels in this payload.
 *
 * vouchers not in v0.2 — added in v0.6.
 */
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    const [products, skus, components, stockLevels] = await Promise.all([
      ctx.db
        .query("pos_products")
        .withIndex("by_active_sort", (q) => q.eq("active", true))
        .collect(),
      ctx.db
        .query("pos_inventory_skus")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect(),
      ctx.db.query("pos_product_components").collect(),
      ctx.db.query("pos_stock_levels").collect(),
    ]);
    return { products, skus, components, stockLevels };
  },
});
