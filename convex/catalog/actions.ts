"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { verifyManagerPinOrThrow, assertManagerSessionInAction } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";

/**
 * Manager-PIN gated: create a new product (v0.5.3b Task 8). Uses
 * `withActionCache` (v0.5.3b post-review extraction) for the standard
 * action-level lookup/run/write idempotency pattern. The inner runMutation
 * still passes `${key}:commit` so the wrapped internal short-circuits any
 * crash-retry between commit and cache-write.
 *
 * PIN is required because new products carry a price (CLAUDE.md #9 — money
 * change always gates on manager PIN).
 *
 * v0.5.5 extension: three optional bundled-SKU args forward to the internal.
 * Captures deviceId from the PIN gate for audit threading on all three audit
 * rows (product.created, inventory_sku.created, product.components_set).
 */
export const createProduct = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    managerPin: v.string(),
    sku_family: v.string(),
    code: v.string(),
    name: v.string(),
    pack_label: v.string(),
    price_idr: v.number(),
    tax_rate: v.number(),
    sort_order: v.number(),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
    // v0.5.5: bundled-SKU flow (A.1b). All three must be present together
    // (the internal validates this).
    withInventorySku: v.optional(v.boolean()),
    inventorySkuLowThreshold: v.optional(v.number()),
    inventorySkuComponentQty: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    productId: Id<"pos_products">;
    inventorySkuId?: Id<"pos_inventory_skus">;
    skuCreated?: boolean;
    componentQty?: number;
  }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "catalog.createProduct" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async () => {
        const PRODUCT_CODE = /^[A-Z][A-Z0-9_]*$/;  // accepts DUBAI_8PC and component-style codes
        if (!PRODUCT_CODE.test(args.code)) throw new Error("INVALID_PRODUCT_CODE");
        const { managerId, deviceId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        // Pass derived `:commit` key so the wrapped internal short-circuits an
        // action retry after a crash between commit and action-level cache write
        // (mirrors refunds._commitRefund_internal pattern).
        return await ctx.runMutation(internal.catalog.internal._createProductCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          mgrId: managerId,
          deviceId,
          sku_family: args.sku_family,
          code: args.code,
          name: args.name,
          pack_label: args.pack_label,
          price_idr: args.price_idr,
          tax_rate: args.tax_rate,
          sort_order: args.sort_order,
          initials: args.initials,
          hue: args.hue,
          withInventorySku: args.withInventorySku,
          inventorySkuLowThreshold: args.inventorySkuLowThreshold,
          inventorySkuComponentQty: args.inventorySkuComponentQty,
        });
      },
    ),
});

/**
 * Manager-PIN gated: create a new inventory SKU (v0.5.5). Mirrors
 * createProduct exactly:
 *   - withActionCache lookup/run/write for action-level idempotency
 *   - verifyManagerPinOrThrow inside the run() callback (cache hit skips PIN)
 *   - inner runMutation passes `${key}:commit` so an action retry crashed
 *     between commit and action-level cache write is absorbed by the inner
 *     withIdempotency wrap (mirrors refunds._commitRefund_internal pattern).
 *
 * Identity/structure write (CLAUDE.md #22) — manager-PIN tier.
 */
export const createInventorySku = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    managerPin: v.string(),
    sku: v.string(),
    name: v.string(),
    low_threshold: v.number(),
    code: v.optional(v.string()),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ skuId: Id<"pos_inventory_skus"> }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "catalog.createInventorySku" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async () => {
        const { managerId, deviceId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        return await ctx.runMutation(internal.catalog.internal._createInventorySkuCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          mgrId: managerId,
          deviceId,
          sku: args.sku,
          name: args.name,
          low_threshold: args.low_threshold,
          code: args.code,
          initials: args.initials,
          hue: args.hue,
        });
      },
    ),
});

/**
 * Manager-PIN gated: change a product's price and/or tax_rate (v0.5.3b Task 8).
 * Same withActionCache wrap as createProduct. Snapshot-on-line rule
 * (CLAUDE.md #1) means past transactions are NOT rewritten — only future
 * sales see the new price.
 */
export const updateProductPricing = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    managerPin: v.string(),
    productId: v.id("pos_products"),
    price_idr: v.number(),
    tax_rate: v.number(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "catalog.updateProductPricing" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async () => {
        const { managerId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        // Pass derived `:commit` key so the wrapped internal short-circuits an
        // action retry after a crash between commit and action-level cache write
        // (mirrors refunds._commitRefund_internal pattern).
        await ctx.runMutation(internal.catalog.internal._updatePricingCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          mgrId: managerId,
          productId: args.productId,
          price_idr: args.price_idr,
          tax_rate: args.tax_rate,
        });
        return { ok: true } as const;
      },
    ),
});
