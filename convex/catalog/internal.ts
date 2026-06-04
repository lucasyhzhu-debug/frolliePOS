import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";

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
 * Active SKU list for cross-module consumers.
 *
 * pos_inventory_skus is OWNED BY catalog (ADR-034 + direct access at
 * catalog/public.ts). Other modules (inventory recon R4, reporting) read
 * the active set through this internal query — never via direct table access.
 */
export const _getActiveSkus_internal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ _id: Id<"pos_inventory_skus">; sku: string; name: string }>> => {
    const rows = await ctx.db
      .query("pos_inventory_skus")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return rows.map((r) => ({ _id: r._id, sku: r.sku, name: r.name }));
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
    // Fan the per-product component reads out in parallel (I8 — was a sequential
    // N+1 await loop). Read-only, so order doesn't matter; flatten at the end.
    const perProduct = await Promise.all(
      args.productIds.map(async (productId) => {
        const components = await ctx.db
          .query("pos_product_components")
          .withIndex("by_product", (q) => q.eq("product_id", productId))
          .collect();
        return components.map((c) => ({ productId, skuId: c.inventory_sku_id, qty: c.qty }));
      }),
    );
    return perProduct.flat();
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
    // Parallel point lookups (I8 — was a sequential get loop). Missing ids drop out.
    const rows = await Promise.all(args.productIds.map((id) => ctx.db.get(id)));
    return rows.flatMap((p) =>
      p
        ? [{
            _id: p._id,
            name: p.name,
            price_idr: p.price_idr,
            tax_rate: p.tax_rate,
            active: p.active,
            sku_family: p.sku_family,
            code: p.code,
          }]
        : [],
    );
  },
});

/**
 * Batch read of inventory SKUs by id, projected to the minimal surface the
 * inventory module needs (name + low_threshold). Exposed so inventory can
 * compose alert/recount views without reaching into catalog-owned
 * `pos_inventory_skus` directly (ADR-034 module boundary — inventory is the
 * consumer here, catalog is the owner).
 *
 * Missing ids are silently dropped (same pattern as
 * `_getProductsByIds_internal`); the caller treats absence as the sku being
 * deleted/inactive and decides locally.
 */
export const _getSkusByIds_internal = internalQuery({
  args: { skuIds: v.array(v.id("pos_inventory_skus")) },
  handler: async (ctx, args): Promise<Array<{
    skuId: Id<"pos_inventory_skus">;
    name: string;
    low_threshold: number;
  }>> => {
    // Parallel point lookups — missing ids drop out via flatMap.
    const rows = await Promise.all(args.skuIds.map((id) => ctx.db.get(id)));
    return rows.flatMap((r) =>
      r ? [{ skuId: r._id, name: r.name, low_threshold: r.low_threshold }] : [],
    );
  },
});

/**
 * Patch a single SKU's `low_threshold`. Exposed so inventory's manager-gated
 * threshold-edit mutation can update the catalog-owned `pos_inventory_skus`
 * row without inventory writing the catalog table directly (ADR-034 module
 * boundary — inventory is the consumer, catalog owns the table).
 *
 * Caller is responsible for auth/audit/idempotency; this internal is a thin
 * write seam.
 */
export const _setLowThreshold_internal = internalMutation({
  args: { skuId: v.id("pos_inventory_skus"), lowThreshold: v.number() },
  handler: async (ctx, args): Promise<void> => {
    // I11: defense-in-depth — public surface (inventory.setLowThreshold)
    // enforces the same invariant, but an internal caller bypassing the
    // public mutation must still hit a hard guard. Negative or non-integer
    // thresholds are nonsensical (on_hand is a whole-piece count; the
    // low-stock check is `on_hand < threshold`).
    if (!Number.isInteger(args.lowThreshold) || args.lowThreshold < 0) {
      throw new Error("INVALID_LOW_THRESHOLD");
    }
    await ctx.db.patch(args.skuId, { low_threshold: args.lowThreshold });
  },
});

const SKU_SLUG_RE = /^[a-z0-9-]{1,32}$/;

/**
 * Single-writer commit for `catalog.createInventorySku` (v0.5.5). Mirrors
 * `_createProductCommit_internal` exactly: action front-half handles PIN gate +
 * action-level cache; this internal owns the row insert + audit in one
 * transaction. Validation guards repeated as defense-in-depth.
 *
 * No pos_stock_levels seed: `upsertStockLevel` lazy-inits on first movement
 * (convex/inventory/internal.ts:20-42); all reads default absent rows to 0.
 *
 * v0.5.3b-style :commit-key wrap: action retry after a crash between commit
 * and action-level cache write would re-execute and double-insert. The
 * withIdempotency on the `:commit`-derived key short-circuits the retry. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md.
 */
export const _createInventorySkuCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    mgrId: v.id("staff"),
    deviceId: v.string(),
    sku: v.string(),
    name: v.string(),
    low_threshold: v.number(),
    code: v.optional(v.string()),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      mgrId: Id<"staff">;
      deviceId: string;
      sku: string;
      name: string;
      low_threshold: number;
      code?: string;
      initials?: string;
      hue?: number;
    },
    { skuId: Id<"pos_inventory_skus"> }
  >(
    "catalog._createInventorySkuCommit_internal",
    async (ctx, args): Promise<{ skuId: Id<"pos_inventory_skus"> }> => {
      const sku = args.sku.trim();
      if (!SKU_SLUG_RE.test(sku)) throw new Error("SKU_INVALID");
      const name = args.name.trim();
      if (name.length === 0 || name.length > 80) throw new Error("NAME_INVALID");
      if (!Number.isInteger(args.low_threshold) || args.low_threshold < 0) {
        throw new Error("LOW_THRESHOLD_INVALID");
      }
      const code = args.code?.trim() ? args.code.trim() : undefined;

      const existingSku = await ctx.db
        .query("pos_inventory_skus")
        .withIndex("by_sku", (q) => q.eq("sku", sku))
        .first();
      if (existingSku) throw new Error("SKU_EXISTS");
      if (code !== undefined) {
        const existingCode = await ctx.db
          .query("pos_inventory_skus")
          .withIndex("by_code", (q) => q.eq("code", code))
          .first();
        if (existingCode) throw new Error("CODE_EXISTS");
      }

      const now = Date.now();
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku,
        code,
        name,
        unit: "piece",
        low_threshold: args.low_threshold,
        initials: args.initials,
        hue: args.hue,
        active: true,
        created_at: now,
      });
      await logAudit(ctx, {
        actor_id: args.mgrId,
        action: "inventory_sku.created",
        entity_type: "inventory_sku",
        entity_id: skuId,
        source: "booth_inline",
        device_id: args.deviceId,
        metadata: { sku, name, low_threshold: args.low_threshold },
      });
      return { skuId };
    },
  ),
});

/**
 * Single-writer commit for `catalog.createProduct` (v0.5.3b Task 8). The
 * action front-half (`catalog/actions.ts`) handles PIN gate + idempotency
 * cache; this internal owns the row insert + audit in one transaction so
 * the audit row can never desync from the product row. Price-integer guard
 * is repeated here as defense-in-depth (the action also validates upstream).
 *
 * v0.5.3b post-review fix: action retry after a crash between commit and
 * action-level cache write would re-execute and double-insert the product.
 * withIdempotency on the `:commit`-derived key short-circuits the retry. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md and
 * refunds._commitRefund_internal for the canonical shape.
 *
 * v0.5.5 extension: three new optional args (`withInventorySku`,
 * `inventorySkuLowThreshold`, `inventorySkuComponentQty`) enable an
 * all-or-nothing bundled flow — one PIN entry, one Convex transaction,
 * one `${key}:commit` idempotency key. The bundled flow does a
 * lookup-or-create on the SKU (never throws SKU_EXISTS — reuse wins) and
 * inserts a pos_product_components link at the supplied qty. Unbundled path
 * is unchanged for back-compat.
 */
export const _createProductCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    mgrId: v.id("staff"),
    sku_family: v.string(),
    name: v.string(),
    pack_label: v.string(),
    price_idr: v.number(),
    tax_rate: v.number(),
    sort_order: v.number(),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
    // v0.5.5: bundled-SKU args. When withInventorySku is true, the same
    // transaction also ensures a matching pos_inventory_skus row (creates if
    // absent by sku_family.toLowerCase(); reuses if present) and inserts a
    // pos_product_components link at the supplied qty. All-or-nothing — any
    // throw rolls back the product insert too. See A.1b in
    // docs/superpowers/specs/2026-06-03-v0.5.5-inventory-sku-admin-and-error-boundary-design.md
    withInventorySku: v.optional(v.boolean()),
    inventorySkuLowThreshold: v.optional(v.number()),
    inventorySkuComponentQty: v.optional(v.number()),
    deviceId: v.optional(v.string()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      mgrId: Id<"staff">;
      sku_family: string;
      name: string;
      pack_label: string;
      price_idr: number;
      tax_rate: number;
      sort_order: number;
      initials?: string;
      hue?: number;
      withInventorySku?: boolean;
      inventorySkuLowThreshold?: number;
      inventorySkuComponentQty?: number;
      deviceId?: string;
    },
    {
      productId: Id<"pos_products">;
      inventorySkuId?: Id<"pos_inventory_skus">;
      skuCreated?: boolean;
      componentQty?: number;
    }
  >(
    "catalog._createProductCommit_internal",
    async (ctx, args) => {
      if (args.price_idr < 0 || !Number.isInteger(args.price_idr)) {
        throw new Error("PRICE_INVALID");
      }
      const now = Date.now();

      // Bundled-SKU pre-validation. Done BEFORE inserting the product so a
      // bad sku_family/threshold/qty doesn't leave a partial transaction in
      // the catch path. (Convex rolls back on throw anyway, but failing fast
      // keeps audit-row counts deterministic for tests.)
      let bundledSkuId: Id<"pos_inventory_skus"> | undefined;
      let bundledSkuCreated = false;
      let bundledQty: number | undefined;
      if (args.withInventorySku) {
        const skuSlug = args.sku_family.trim().toLowerCase();
        if (!/^[a-z0-9-]{1,32}$/.test(skuSlug)) {
          throw new Error("SKU_FAMILY_NOT_SLUGGABLE");
        }
        if (
          args.inventorySkuLowThreshold === undefined ||
          !Number.isInteger(args.inventorySkuLowThreshold) ||
          args.inventorySkuLowThreshold < 0
        ) {
          throw new Error("LOW_THRESHOLD_INVALID");
        }
        if (
          args.inventorySkuComponentQty === undefined ||
          !Number.isInteger(args.inventorySkuComponentQty) ||
          args.inventorySkuComponentQty < 1
        ) {
          throw new Error("QTY_INVALID");
        }
        bundledQty = args.inventorySkuComponentQty;
        const existing = await ctx.db
          .query("pos_inventory_skus")
          .withIndex("by_sku", (q) => q.eq("sku", skuSlug))
          .first();
        if (existing) {
          bundledSkuId = existing._id;
          bundledSkuCreated = false;
        } else {
          bundledSkuId = await ctx.db.insert("pos_inventory_skus", {
            sku: skuSlug,
            name: args.sku_family.trim(),
            unit: "piece",
            low_threshold: args.inventorySkuLowThreshold,
            active: true,
            created_at: now,
          });
          bundledSkuCreated = true;
        }
      }

      const productId = await ctx.db.insert("pos_products", {
        sku_family: args.sku_family,
        name: args.name.trim(),
        pack_label: args.pack_label,
        price_idr: args.price_idr,
        tax_rate: args.tax_rate,
        sort_order: args.sort_order,
        initials: args.initials,
        hue: args.hue,
        active: true,
        created_at: now,
        updated_at: now,
      });
      await logAudit(ctx, {
        actor_id: args.mgrId,
        action: "product.created",
        entity_type: "pos_products",
        entity_id: productId,
        source: "booth_inline",
        device_id: args.deviceId,
        metadata: { name: args.name, price_idr: args.price_idr },
      });

      if (args.withInventorySku && bundledSkuId !== undefined && bundledQty !== undefined) {
        if (bundledSkuCreated) {
          const skuSlug = args.sku_family.trim().toLowerCase();
          await logAudit(ctx, {
            actor_id: args.mgrId,
            action: "inventory_sku.created",
            entity_type: "inventory_sku",
            entity_id: bundledSkuId,
            source: "booth_inline",
            device_id: args.deviceId,
            metadata: {
              sku: skuSlug,
              name: args.sku_family.trim(),
              low_threshold: args.inventorySkuLowThreshold,
              source: "create_product_bundled",
            },
          });
        }
        await ctx.db.insert("pos_product_components", {
          product_id: productId,
          inventory_sku_id: bundledSkuId,
          qty: bundledQty,
        });
        await logAudit(ctx, {
          actor_id: args.mgrId,
          action: "product.components_set",
          entity_type: "pos_products",
          entity_id: productId,
          source: "booth_inline",
          device_id: args.deviceId,
          metadata: {
            product_id: productId,
            sku_id: bundledSkuId,
            qty: bundledQty,
            source: "create_product_bundled",
          },
        });
        return { productId, inventorySkuId: bundledSkuId, skuCreated: bundledSkuCreated, componentQty: bundledQty };
      }

      return { productId };
    },
  ),
});

/**
 * Single-writer commit for `catalog.updateProductPricing` (v0.5.3b Task 8).
 * Reads `before` for the from→to audit metadata then patches in the same
 * transaction. Snapshot-on-line rule (CLAUDE.md #1) means historic
 * transactions are unaffected by this edit.
 *
 * v0.5.3b post-review fix: action retry after a crash between commit and
 * action-level cache write would re-execute and double-emit the audit row.
 * withIdempotency on the `:commit`-derived key short-circuits the retry. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md and
 * refunds._commitRefund_internal for the canonical shape.
 */
export const _updatePricingCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    mgrId: v.id("staff"),
    productId: v.id("pos_products"),
    price_idr: v.number(),
    tax_rate: v.number(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      mgrId: Id<"staff">;
      productId: Id<"pos_products">;
      price_idr: number;
      tax_rate: number;
    },
    { ok: true }
  >(
    "catalog._updatePricingCommit_internal",
    async (ctx, args): Promise<{ ok: true }> => {
      if (args.price_idr < 0 || !Number.isInteger(args.price_idr)) {
        throw new Error("PRICE_INVALID");
      }
      const before = await ctx.db.get(args.productId);
      if (!before) throw new Error("PRODUCT_NOT_FOUND");
      await ctx.db.patch(args.productId, {
        price_idr: args.price_idr,
        tax_rate: args.tax_rate,
        updated_at: Date.now(),
      });
      await logAudit(ctx, {
        actor_id: args.mgrId,
        action: "product.updated",
        entity_type: "pos_products",
        entity_id: args.productId,
        source: "booth_inline",
        metadata: {
          field: "pricing",
          price_idr: { from: before.price_idr, to: args.price_idr },
        },
      });
      return { ok: true as const };
    },
  ),
});
