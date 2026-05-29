import { defineTable } from "convex/server";
import { v } from "convex/values";

export const catalogTables = {
  pos_inventory_skus: defineTable({
    sku: v.string(),
    code: v.optional(v.string()), // NEW v0.2.1 — populated in Task F3, required in Task F6 (DEFERRED)
    name: v.string(),
    unit: v.literal("piece"),
    low_threshold: v.number(),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
    photo_storage_id: v.optional(v.id("_storage")),
    active: v.boolean(),
    created_at: v.number(),
  })
    .index("by_sku", ["sku"])
    .index("by_code", ["code"])
    .index("by_active", ["active"]),

  pos_products: defineTable({
    sku_family: v.string(),
    code: v.optional(v.string()), // NEW v0.2.1 — populated in Task F3, required in Task F6 (DEFERRED)
    name: v.string(),
    pack_label: v.string(),
    price_idr: v.number(),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
    photo_storage_id: v.optional(v.id("_storage")),
    active: v.boolean(),
    sort_order: v.number(),
    tax_rate: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_active_sort", ["active", "sort_order"])
    .index("by_family", ["sku_family"])
    .index("by_code", ["code"]),

  pos_product_components: defineTable({
    product_id: v.id("pos_products"),
    inventory_sku_id: v.id("pos_inventory_skus"),
    qty: v.number(),
  })
    .index("by_product", ["product_id"])
    .index("by_sku", ["inventory_sku_id"]),

  // pos_stock_levels MOVED to convex/inventory/schema.ts in v0.3 (ADR-034).
};
