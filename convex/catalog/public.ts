import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { requireManagerSession } from "../auth/sessions";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";

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

/**
 * Edit a product's non-price metadata (name, pack_label, sort_order, plus
 * optional sku_family / initials / hue). Manager-session-gated, NO PIN —
 * none of these fields move money (CLAUDE.md #9). Price + tax_rate edits go
 * through the PIN-gated action (`catalog.actions.updateProductPricing`).
 *
 * Mirrors `staff.updateStaffName`'s `withIdempotency` + `authCheck` shape:
 * authCheck runs BEFORE the cache lookup so an unauthorised retry can't
 * read a cached success (see docs/PATTERNS/idempotency-dual-call-authcheck.md).
 */
export const updateProductMeta = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    productId: v.id("pos_products"),
    name: v.string(),
    pack_label: v.string(),
    sort_order: v.number(),
    sku_family: v.optional(v.string()),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      productId: Id<"pos_products">;
      name: string;
      pack_label: string;
      sort_order: number;
      sku_family?: string;
      initials?: string;
      hue?: number;
    },
    { ok: true }
  >(
    "catalog.updateProductMeta",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const name = args.name.trim();
      if (name.length === 0 || name.length > 80) throw new Error("NAME_INVALID");
      const before = await ctx.db.get(args.productId);
      if (!before) throw new Error("PRODUCT_NOT_FOUND");
      await ctx.db.patch(args.productId, {
        name,
        pack_label: args.pack_label,
        sort_order: args.sort_order,
        ...(args.sku_family !== undefined ? { sku_family: args.sku_family } : {}),
        ...(args.initials !== undefined ? { initials: args.initials } : {}),
        ...(args.hue !== undefined ? { hue: args.hue } : {}),
        updated_at: Date.now(),
      });
      await logAudit(ctx, {
        actor_id: mgrId,
        action: "product.updated",
        entity_type: "pos_products",
        entity_id: args.productId,
        source: "booth_inline",
        device_id: deviceId,
        metadata: { field: "meta" },
      });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

/**
 * Replace the full component set for a product. Manager-session-gated, no PIN
 * (components are recipe wiring, not money — CLAUDE.md #9). Validates EVERY
 * component (qty integer > 0, SKU exists + active) BEFORE any delete/insert
 * so a bad row in position N doesn't leave rows 1..N-1 already deleted
 * (fail-before-write atomicity).
 *
 * Replace-set shape: the UI hands us the desired component set and we delete
 * existing rows (via `by_product` index) then insert the new set. UIs don't
 * want to incrementally patch component rows row-by-row.
 */
export const setProductComponents = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    productId: v.id("pos_products"),
    components: v.array(
      v.object({
        inventory_sku_id: v.id("pos_inventory_skus"),
        qty: v.number(),
      }),
    ),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      productId: Id<"pos_products">;
      components: Array<{ inventory_sku_id: Id<"pos_inventory_skus">; qty: number }>;
    },
    { ok: true }
  >(
    "catalog.setProductComponents",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const product = await ctx.db.get(args.productId);
      if (!product) throw new Error("PRODUCT_NOT_FOUND");
      // Validate each component first (fail before any write).
      for (const c of args.components) {
        if (!Number.isInteger(c.qty) || c.qty <= 0) throw new Error("QTY_INVALID");
        const sku = await ctx.db.get(c.inventory_sku_id);
        if (!sku) throw new Error("SKU_NOT_FOUND");
        if (!sku.active) throw new Error("SKU_INACTIVE");
      }
      // Replace-set: delete existing rows for this product, insert the new set.
      const existing = await ctx.db
        .query("pos_product_components")
        .withIndex("by_product", (q) => q.eq("product_id", args.productId))
        .collect();
      for (const row of existing) await ctx.db.delete(row._id);
      for (const c of args.components) {
        await ctx.db.insert("pos_product_components", {
          product_id: args.productId,
          inventory_sku_id: c.inventory_sku_id,
          qty: c.qty,
        });
      }
      await ctx.db.patch(args.productId, { updated_at: Date.now() });
      await logAudit(ctx, {
        actor_id: mgrId,
        action: "product.updated",
        entity_type: "pos_products",
        entity_id: args.productId,
        source: "booth_inline",
        device_id: deviceId,
        metadata: { components_changed: true, count: args.components.length },
      });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

/**
 * Soft-delete a product (active=false). Manager-session-gated, NO PIN — this
 * is a catalog-curation action, not a money move (CLAUDE.md #9). Archived
 * products disappear from the public `catalog` query (which filters
 * `active: true`) but remain visible in admin `listAllProducts`.
 *
 * Historical pos_transaction_lines are unaffected — snapshot rule #1
 * (CLAUDE.md): `unit_price` and `product_name_snapshot` are frozen at sale
 * time so receipts/history render correctly for archived products.
 */
export const archiveProduct = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    productId: v.id("pos_products"),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      productId: Id<"pos_products">;
    },
    { ok: true }
  >(
    "catalog.archiveProduct",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const product = await ctx.db.get(args.productId);
      if (!product) throw new Error("PRODUCT_NOT_FOUND");
      await ctx.db.patch(args.productId, { active: false, updated_at: Date.now() });
      // Historical pos_transaction_lines unaffected (snapshot rule #1).
      await logAudit(ctx, {
        actor_id: mgrId,
        action: "product.archived",
        entity_type: "pos_products",
        entity_id: args.productId,
        source: "booth_inline",
        device_id: deviceId,
      });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});
