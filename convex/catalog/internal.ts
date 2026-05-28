import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
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

/**
 * Expand a list of product IDs to their component SKU requirements.
 * Used by transactions/internal to build sale movements + projected NEG_STOCK
 * checks without touching catalog-owned tables directly (ADR-034 module boundary).
 *
 * Returns one row per (productId, skuId) component pair. If a product has no
 * components the product simply contributes no rows (caller treats it as zero
 * SKU demand).
 */
export const _getComponentsForProducts_internal = internalQuery({
  args: {
    productIds: v.array(v.id("pos_products")),
  },
  handler: async (ctx, args): Promise<Array<{
    productId: Id<"pos_products">;
    skuId: Id<"pos_inventory_skus">;
    qty: number;
  }>> => {
    const result: Array<{ productId: Id<"pos_products">; skuId: Id<"pos_inventory_skus">; qty: number }> = [];
    for (const productId of args.productIds) {
      const components = await ctx.db
        .query("pos_product_components")
        .withIndex("by_product", (q) => q.eq("product_id", productId))
        .collect();
      for (const c of components) {
        result.push({ productId, skuId: c.inventory_sku_id, qty: c.qty });
      }
    }
    return result;
  },
});

/**
 * Fetch product rows by id (for snapshotting price/name/code at sale time).
 * Exposed so the transactions funnel can build immutable line snapshots
 * (ADR-001) without reading catalog-owned tables directly (ADR-034).
 *
 * Returns a projected subset — only the fields commitCart needs to snapshot.
 * Missing ids are simply skipped; the caller treats absence as
 * PRODUCT_NOT_FOUND_OR_INACTIVE.
 */
export const _getProductsByIds_internal = internalQuery({
  args: { productIds: v.array(v.id("pos_products")) },
  handler: async (ctx, args): Promise<Array<{
    _id: Id<"pos_products">;
    name: string;
    price_idr: number;
    tax_rate: number;
    active: boolean;
    sku_family: string;
    code?: string;
  }>> => {
    const out: Array<{
      _id: Id<"pos_products">;
      name: string;
      price_idr: number;
      tax_rate: number;
      active: boolean;
      sku_family: string;
      code?: string;
    }> = [];
    for (const id of args.productIds) {
      const p = await ctx.db.get(id);
      if (p) {
        out.push({
          _id: p._id,
          name: p.name,
          price_idr: p.price_idr,
          tax_rate: p.tax_rate,
          active: p.active,
          sku_family: p.sku_family,
          code: p.code,
        });
      }
    }
    return out;
  },
});
