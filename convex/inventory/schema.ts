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
      v.literal("refund"),                         // v0.5.1 PR B
      v.literal("recount"),                        // v0.5.2 — staff absolute recount (ADR-041)
    ),

    source_transaction_line_id: v.optional(v.id("pos_transaction_lines")),

    spoilage_reason: v.optional(v.string()),       // NEW v0.6: non-null only when source="spoilage"
    spoilage_event_id: v.optional(v.string()),     // NEW v0.6: groups multi-line spoilage events

    created_at: v.number(),
    recorded_by_staff_id: v.optional(v.id("staff")),
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Stream 2: optional during migration window
  })
    .index("by_sku_created", ["inventory_sku_id", "created_at"])
    .index("by_line_and_sku", ["source_transaction_line_id", "inventory_sku_id"])  // ADR-026 dedup (GLOBAL_UNIQUE — keep)
    .index("by_outlet_sku_created", ["outlet_id", "inventory_sku_id", "created_at"]),

  // MOVED FROM catalog/schema.ts in v0.3 (ADR-034).
  pos_stock_levels: defineTable({
    inventory_sku_id: v.id("pos_inventory_skus"),
    on_hand: v.number(),                           // may go negative per ADR-018
    last_movement_id: v.optional(v.string()),      // Kept as v.string() (not v.id) deliberately: v0.3 ships against the dev deployment with existing rows; narrowing to v.id("pos_stock_movements") would risk schema-validation rejection on legacy values. Reconcile at prod cutover (v1.0). Not written by any v0.3 code path.
    updated_at: v.number(),
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Stream 2: optional during migration window
  })
    .index("by_sku", ["inventory_sku_id"])
    .index("by_outlet_sku", ["outlet_id", "inventory_sku_id"]),

  // v0.5.2 (ADR-042): low-stock dedup FLAG only. The threshold itself is the
  // catalog-owned pos_inventory_skus.low_threshold — NOT duplicated here.
  // Row is DELETED (not flagged) when on_hand climbs back to/above threshold — re-arms the alert.
  // The row's existence IS the flag — no `updated_at` field; `alerted_at` is the
  // only timestamp (set once at insert).
  pos_low_stock_alerts: defineTable({
    inventory_sku_id: v.id("pos_inventory_skus"),
    alerted_at: v.number(),
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Stream 2: optional during migration window
  })
    .index("by_sku", ["inventory_sku_id"])
    .index("by_outlet_sku", ["outlet_id", "inventory_sku_id"]),

  // v0.5.2 (ADR-041): singleton holding the last recount timestamp for the hourly
  // nudge. One row per outlet post-v2.0. Avoids a by-source scan of pos_stock_movements (no such index).
  // No `updated_by_staff_id` — actor identity for the recount lives on the
  // matching audit_log row (`stock.recount` action), where audit drill-down
  // looks for it anyway.
  pos_recount_state: defineTable({
    last_recount_at: v.number(),
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Stream 2: optional during migration window; was singleton, now one row per outlet
  })
    .index("by_outlet", ["outlet_id"]),

  // v0.6 (R1): append-only drift log written by the nightly stock-recon cron (R7)
  // when the ledger reconstruction of pos_stock_movements disagrees with the
  // cached pos_stock_levels.on_hand. sku_code is snapshotted at detection time
  // (immutable — CLAUDE.md rule #1 spirit). resolved_* fields populated by
  // resolveDrift (R8). Indefinite retention.
  pos_stock_drift_log: defineTable({
    inventory_sku_id: v.id("pos_inventory_skus"),
    sku_code: v.string(),                       // snapshot, immutable (mirrors voucher code_snapshot rationale)
    cached_on_hand: v.number(),
    reconstructed_on_hand: v.number(),
    delta: v.number(),                          // cached - reconstructed
    detected_at: v.number(),
    resolved_at: v.optional(v.number()),
    resolved_by_staff_id: v.optional(v.id("staff")),
    resolution_note: v.optional(v.string()),
    outlet_id: v.optional(v.id("outlets")),  // v2.0 Stream 2: optional during migration window
  })
    .index("by_sku_detected", ["inventory_sku_id", "detected_at"])
    .index("by_unresolved", ["resolved_at"])   // for "still-open drifts" list
    .index("by_outlet_sku_detected", ["outlet_id", "inventory_sku_id", "detected_at"])
    .index("by_outlet_unresolved", ["outlet_id", "resolved_at"]),
};
