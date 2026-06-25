import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Copy a source outlet's catalog (skus → products → components) into a target
 * outlet with remapped foreign keys. Photos reuse the same `_storage` id by
 * value (same deployment, cheap; rows diverge on later edit). V8-safe; runs
 * inside the caller's mutation transaction (atomic with the rest of the clone).
 */
export async function cloneCatalogRows(
  ctx: MutationCtx,
  { sourceOutletId, targetOutletId, now }: { sourceOutletId: Id<"outlets">; targetOutletId: Id<"outlets">; now: number },
): Promise<{ skus: number; products: number; components: number }> {
  const skuIdMap = new Map<string, Id<"pos_inventory_skus">>();
  const skus = await ctx.db.query("pos_inventory_skus").withIndex("by_outlet_active", (q) => q.eq("outlet_id", sourceOutletId)).collect();
  for (const s of skus) {
    const { _id, _creationTime, outlet_id, created_at, ...rest } = s;
    const nid = await ctx.db.insert("pos_inventory_skus", { ...rest, outlet_id: targetOutletId, created_at: now });
    skuIdMap.set(String(_id), nid);
  }

  const productIdMap = new Map<string, Id<"pos_products">>();
  const products = await ctx.db.query("pos_products").withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", sourceOutletId)).collect();
  for (const p of products) {
    const { _id, _creationTime, outlet_id, created_at, updated_at, ...rest } = p;
    const nid = await ctx.db.insert("pos_products", { ...rest, outlet_id: targetOutletId, created_at: now, updated_at: now });
    productIdMap.set(String(_id), nid);
  }

  const components = await ctx.db.query("pos_product_components").withIndex("by_outlet_product", (q) => q.eq("outlet_id", sourceOutletId)).collect();
  for (const c of components) {
    const newProduct = productIdMap.get(String(c.product_id));
    const newSku = skuIdMap.get(String(c.inventory_sku_id));
    if (!newProduct || !newSku) continue; // dangling FK in source — skip (shouldn't happen)
    await ctx.db.insert("pos_product_components", { product_id: newProduct, inventory_sku_id: newSku, qty: c.qty, outlet_id: targetOutletId });
  }
  return { skus: skus.length, products: products.length, components: components.length };
}
