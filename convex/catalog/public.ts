import { v } from "convex/values";
import { query } from "../_generated/server";
import { api } from "../_generated/api";
import { Doc } from "../_generated/dataModel";
import { requireManagerSession } from "../auth/sessions";

/**
 * Single payload for the catalog screen + offline cache. Persisted to IDB
 * client-side by useCatalogCache (Task 8.5) so cold starts work offline.
 * available_qty per product is computed client-side (ADR-017) from the
 * components + stockLevels in this payload.
 *
 * Stock levels are sourced via api.inventory.public.getStockLevels (ADR-034:
 * inventory owns pos_stock_levels; catalog reads through inventory's public API).
 * The Record<id, on_hand> map is converted to an array of {inventory_sku_id,
 * on_hand} rows to preserve the useCatalogCache consumer contract.
 *
 * Vouchers are bundled for offline apply per ADR-009 (server re-validates at
 * commitCart). Active+unexpired rows are sourced via
 * api.vouchers.public.getActiveVouchers (ADR-034: vouchers owns pos_vouchers).
 */
export const catalog = query({
  args: {},
  // Explicit return type breaks the cross-module circular inference (this handler
  // calls ctx.runQuery on inventory + vouchers public APIs). Without it tsc -b
  // collapses the inferred element types and downstream consumers see `any`.
  handler: async (
    ctx,
  ): Promise<{
    products: Doc<"pos_products">[];
    skus: Doc<"pos_inventory_skus">[];
    components: Doc<"pos_product_components">[];
    stockLevels: Array<{ inventory_sku_id: string; on_hand: number }>;
    vouchers: Doc<"pos_vouchers">[];
  }> => {
    const [products, skus, allComponents, stockLevelMap, vouchers] = await Promise.all([
      ctx.db
        .query("pos_products")
        .withIndex("by_active_sort", (q) => q.eq("active", true))
        .collect(),
      ctx.db
        .query("pos_inventory_skus")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect(),
      ctx.db.query("pos_product_components").collect(),
      ctx.runQuery(api.inventory.public.getStockLevels, {}),
      ctx.runQuery(api.vouchers.public.getActiveVouchers, {}),
    ]);

    const activeProductIds = new Set(products.map((p) => p._id));

    const components = allComponents.filter((c) => activeProductIds.has(c.product_id));

    // Convert the Record<id, on_hand> map returned by inventory.public.getStockLevels
    // into an array of {inventory_sku_id, on_hand} rows — preserving the shape
    // that useCatalogCache and the catalog tests expect.
    const stockLevels = Object.entries(stockLevelMap).map(([inventory_sku_id, on_hand]) => ({
      inventory_sku_id,
      on_hand,
    }));

    return { products, skus, components, stockLevels, vouchers };
  },
});

/**
 * Manager-only admin view of the catalog. Mirrors `catalog` but returns ALL
 * products (including `active: false` / archived) so the product-admin UI
 * (Task 15, v0.5.3b) can list and edit them. Active inventory SKUs only
 * (matches `catalog`'s scope — admin doesn't manage SKU lifecycle here).
 *
 * Gated by `requireManagerSession` (manager-only). Returns all components so
 * the UI can render recipe rows for every product, archived or not.
 */
export const listAllProducts = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    products: Doc<"pos_products">[];
    skus: Doc<"pos_inventory_skus">[];
    components: Doc<"pos_product_components">[];
  }> => {
    await requireManagerSession(ctx, args.sessionId);
    const [products, skus, components] = await Promise.all([
      ctx.db.query("pos_products").collect(),
      ctx.db
        .query("pos_inventory_skus")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect(),
      ctx.db.query("pos_product_components").collect(),
    ]);
    return { products, skus, components };
  },
});
