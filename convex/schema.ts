import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  staff: defineTable({
    name: v.string(),
    pin_hash: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
    active: v.boolean(),
    preferences: v.optional(v.object({
      founders_share_on: v.optional(v.boolean()),
    })),
    created_at: v.number(),
    last_login_at: v.optional(v.number()),
  })
    .index("by_active", ["active"])
    .index("by_role", ["role"]),

  staff_sessions: defineTable({
    staff_id: v.id("staff"),
    device_id: v.string(),
    started_at: v.number(),
    ended_at: v.union(v.number(), v.null()),
    end_reason: v.union(
      v.literal("manual_lock"),
      v.literal("timeout"),
      v.literal("force_logout"),
      v.null(),
    ),
  })
    .index("by_staff_active", ["staff_id", "ended_at"])
    .index("by_device_active", ["device_id", "ended_at"]),

  pos_auth_attempts: defineTable({
    staff_id: v.id("staff"),
    fail_count: v.number(),
    locked_until: v.union(v.number(), v.null()),
    last_attempt_at: v.number(),
  }).index("by_staff", ["staff_id"]),

  registered_devices: defineTable({
    device_id: v.string(),
    label: v.string(),
    activated_by: v.id("staff"),
    activated_at: v.number(),
    last_seen_at: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_device_id", ["device_id"])
    .index("by_active", ["active"]),

  pending_device_setups: defineTable({
    setup_code: v.string(),
    issued_by: v.id("staff"),
    expires_at: v.number(),
    consumed_at: v.union(v.number(), v.null()),
  })
    .index("by_code", ["setup_code"])
    .index("by_expires", ["expires_at"]),

  pos_inventory_skus: defineTable({
    sku: v.string(),
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
    .index("by_active", ["active"]),

  pos_products: defineTable({
    sku_family: v.string(),
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
    .index("by_family", ["sku_family"]),

  pos_product_components: defineTable({
    product_id: v.id("pos_products"),
    inventory_sku_id: v.id("pos_inventory_skus"),
    qty: v.number(),
  })
    .index("by_product", ["product_id"])
    .index("by_sku", ["inventory_sku_id"]),

  pos_stock_levels: defineTable({
    inventory_sku_id: v.id("pos_inventory_skus"),
    on_hand: v.number(),
    last_movement_id: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_sku", ["inventory_sku_id"]),

  pos_idempotency: defineTable({
    key: v.string(),
    mutation_name: v.string(),
    staff_id: v.optional(v.id("staff")),
    response_blob: v.string(),
    expires_at: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expires", ["expires_at"]),

  audit_log: defineTable({
    actor_id: v.union(v.id("staff"), v.literal("system")),
    action: v.string(),
    entity_type: v.string(),
    entity_id: v.optional(v.string()),
    before_state: v.optional(v.string()),
    after_state: v.optional(v.string()),
    device_id: v.optional(v.string()),
    mgr_approver_id: v.optional(v.id("staff")),
    source: v.union(
      v.literal("booth_inline"),
      v.literal("wa_approval"),
      v.literal("system"),
      v.literal("reaper"),
    ),
    reason: v.optional(v.string()),
    metadata: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_actor_date", ["actor_id", "created_at"])
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_action_date", ["action", "created_at"])
    .index("by_source_date", ["source", "created_at"]),
});
