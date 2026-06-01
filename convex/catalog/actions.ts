"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { verifyManagerPinOrThrow } from "../auth/verifyPin";

/**
 * Manager-PIN gated: create a new product (v0.5.3b Task 8). Action-level
 * idempotency pattern mirrors `staff.actions.setStaffRole`:
 *   1. cache lookup (short-circuit on retry)
 *   2. verifyManagerPinOrThrow — lockout + argon2 + failed-attempt recording
 *   3. _createProductCommit_internal — atomic insert + audit
 *   4. write response to idempotency cache
 *
 * PIN is required because new products carry a price (CLAUDE.md #9 — money
 * change always gates on manager PIN).
 */
export const createProduct = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    managerPin: v.string(),
    sku_family: v.string(),
    name: v.string(),
    pack_label: v.string(),
    price_idr: v.number(),
    tax_rate: v.number(),
    sort_order: v.number(),
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ productId: Id<"pos_products"> }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { productId: Id<"pos_products"> };

    const { managerId } = await verifyManagerPinOrThrow(ctx, {
      sessionId: args.sessionId,
      managerPin: args.managerPin,
      idempotencyKey: args.idempotencyKey,
    });
    // Pass derived `:commit` key so the wrapped internal short-circuits an
    // action retry after a crash between commit and action-level cache write
    // (mirrors refunds._commitRefund_internal pattern).
    const res = await ctx.runMutation(internal.catalog.internal._createProductCommit_internal, {
      idempotencyKey: `${args.idempotencyKey}:commit`,
      mgrId: managerId,
      sku_family: args.sku_family,
      name: args.name,
      pack_label: args.pack_label,
      price_idr: args.price_idr,
      tax_rate: args.tax_rate,
      sort_order: args.sort_order,
      initials: args.initials,
      hue: args.hue,
    });
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "catalog.createProduct",
      response: JSON.stringify(res),
    });
    return res;
  },
});

/**
 * Manager-PIN gated: change a product's price and/or tax_rate (v0.5.3b Task 8).
 * Same action-level idempotency pattern as `createProduct`. Snapshot-on-line
 * rule (CLAUDE.md #1) means past transactions are NOT rewritten — only
 * future sales see the new price.
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
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { ok: true };

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
    const response = { ok: true } as const;
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "catalog.updateProductPricing",
      response: JSON.stringify(response),
    });
    return response;
  },
});
