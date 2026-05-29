import { defineTable } from "convex/server";
import { v } from "convex/values";

export const inventoryTables = {
  pos_stock_movements: defineTable({
    inventory_sku_id: v.id("pos_inventory_skus"),  // NOTE: spec used "sku_id"; corrected to "inventory_sku_id"
                                                   // to match existing data and v0.2 catalog queries.
    qty: v.number(),                               // signed: NEGATIVE for sale
    source: v.union(
      v.literal("sale"),                           // v0.3
      v.literal("stock_in"),                       // v0.5
      v.literal("spoilage"),                       // v0.6
      v.literal("adjustment"),                     // v0.5
    ),

    source_transaction_line_id: v.optional(v.id("pos_transaction_lines")),

    created_at: v.number(),
    recorded_by_staff_id: v.optional(v.id("staff")),
  })
    .index("by_sku_created", ["inventory_sku_id", "created_at"])
    .index("by_line_and_sku", ["source_transaction_line_id", "inventory_sku_id"]),  // ADR-026 dedup

  // MOVED FROM catalog/schema.ts in v0.3 (ADR-034).
  pos_stock_levels: defineTable({
    inventory_sku_id: v.id("pos_inventory_skus"),
    on_hand: v.number(),                           // may go negative per ADR-018
    last_movement_id: v.optional(v.string()),      // Kept as v.string() (not v.id) deliberately: v0.3 ships against the dev deployment with existing rows; narrowing to v.id("pos_stock_movements") would risk schema-validation rejection on legacy values. Reconcile at prod cutover (v1.0). Not written by any v0.3 code path.
    updated_at: v.number(),
  })
    .index("by_sku", ["inventory_sku_id"]),
};
