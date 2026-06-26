import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";

test("cloneCatalogRows copies + remaps FKs into target outlet, reuses photo id", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const src = await ctx.db.insert("outlets", { is_open: false, code: "SRC", name: "Src", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const tgt = await ctx.db.insert("outlets", { is_open: false, code: "TGT", name: "Tgt", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    // Use a real _storage ID — ctx.storage.store is the established pattern in this test env
    const photo = await ctx.storage.store(new Blob(["x"], { type: "image/webp" }));
    const sku = await ctx.db.insert("pos_inventory_skus", { sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 5, active: true, created_at: 1, outlet_id: src, photo_storage_id: photo } as any);
    const prod = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "8pcs", price_idr: 100000, active: true, sort_order: 0, tax_rate: 0, created_at: 1, updated_at: 1, outlet_id: src, photo_storage_id: photo } as any);
    await ctx.db.insert("pos_product_components", { product_id: prod, inventory_sku_id: sku, qty: 8, outlet_id: src } as any);

    const { cloneCatalogRows } = await import("../lib");
    const counts = await cloneCatalogRows(ctx, { sourceOutletId: src, targetOutletId: tgt, now: 999 });
    expect(counts).toEqual({ skus: 1, products: 1, components: 1 });

    const newComp = (await ctx.db.query("pos_product_components").withIndex("by_outlet_product", (q) => q.eq("outlet_id", tgt)).collect())[0];
    const newProd = (await ctx.db.query("pos_products").withIndex("by_outlet_code", (q) => q.eq("outlet_id", tgt).eq("code", "DUBAI_8PC")).collect())[0];
    const newSku = (await ctx.db.query("pos_inventory_skus").withIndex("by_outlet_code", (q) => q.eq("outlet_id", tgt)).collect())[0];
    expect(newComp.product_id).toBe(newProd._id);   // remapped to NEW product
    expect(newComp.inventory_sku_id).toBe(newSku._id); // remapped to NEW sku
    expect(newProd.photo_storage_id).toBe(photo);    // reused BY VALUE
    expect(newComp.product_id).not.toBe(prod);       // not the source id
  });
});

test("cloneCatalogRows copies only active rows — inactive products and skus are excluded", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const src = await ctx.db.insert("outlets", { is_open: false, code: "SRC2", name: "Src2", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const tgt = await ctx.db.insert("outlets", { is_open: false, code: "TGT2", name: "Tgt2", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);

    // Active sku + product
    const activeSku = await ctx.db.insert("pos_inventory_skus", { sku: "active_sku", name: "Active SKU", unit: "piece", low_threshold: 5, active: true, created_at: 1, outlet_id: src } as any);
    const activeProd = await ctx.db.insert("pos_products", { sku_family: "active_sku", code: "ACT_PROD", name: "Active Product", pack_label: "1pc", price_idr: 50000, active: true, sort_order: 0, tax_rate: 0, created_at: 1, updated_at: 1, outlet_id: src } as any);
    await ctx.db.insert("pos_product_components", { product_id: activeProd, inventory_sku_id: activeSku, qty: 1, outlet_id: src } as any);

    // Inactive sku + product (should be excluded)
    const inactiveSku = await ctx.db.insert("pos_inventory_skus", { sku: "inactive_sku", name: "Inactive SKU", unit: "piece", low_threshold: 5, active: false, created_at: 1, outlet_id: src } as any);
    const inactiveProd = await ctx.db.insert("pos_products", { sku_family: "inactive_sku", code: "INACT_PROD", name: "Inactive Product", pack_label: "1pc", price_idr: 30000, active: false, sort_order: 1, tax_rate: 0, created_at: 1, updated_at: 1, outlet_id: src } as any);
    await ctx.db.insert("pos_product_components", { product_id: inactiveProd, inventory_sku_id: inactiveSku, qty: 1, outlet_id: src } as any);

    const { cloneCatalogRows } = await import("../lib");
    const counts = await cloneCatalogRows(ctx, { sourceOutletId: src, targetOutletId: tgt, now: 999 });

    // Only the active product + sku + component should be cloned
    expect(counts).toEqual({ skus: 1, products: 1, components: 1 });

    // Confirm target has exactly one product and it's the active one
    const tgtProducts = await ctx.db.query("pos_products").withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", tgt)).collect();
    expect(tgtProducts).toHaveLength(1);
    expect(tgtProducts[0].code).toBe("ACT_PROD");

    const tgtSkus = await ctx.db.query("pos_inventory_skus").withIndex("by_outlet_active", (q) => q.eq("outlet_id", tgt)).collect();
    expect(tgtSkus).toHaveLength(1);
    expect(tgtSkus[0].sku).toBe("active_sku");
  });
});
