import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { logAudit } from "../audit/internal";

/**
 * Record sale-driven stock movements for a confirmed transaction.
 * ADR-026 dedup: checks the by_line_and_sku unique index before inserting;
 * idempotent — safe to call twice (e.g. webhook + polling race).
 * ADR-018: on_hand may go negative; never hard-blocks.
 */
export const _recordSaleMovement_internal = internalMutation({
  args: {
    transactionId: v.id("pos_transactions"),
    lines: v.array(v.object({
      lineId: v.id("pos_transaction_lines"),
      skuId: v.id("pos_inventory_skus"),
      qty: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const line of args.lines) {
      // ADR-026: dedup guard — skip if movement for this (line, sku) pair exists.
      const existing = await ctx.db
        .query("pos_stock_movements")
        .withIndex("by_line_and_sku", (q) =>
          q.eq("source_transaction_line_id", line.lineId).eq("inventory_sku_id", line.skuId),
        )
        .first();
      if (existing) continue;

      await ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: line.skuId,
        qty: -line.qty,
        source: "sale",
        source_transaction_line_id: line.lineId,
        created_at: now,
      });

      // Decrement the denormalised on_hand cache (ADR-018: negative allowed).
      const level = await ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", line.skuId))
        .first();
      if (level) {
        await ctx.db.patch(level._id, { on_hand: level.on_hand - line.qty, updated_at: now });
      } else {
        await ctx.db.insert("pos_stock_levels", {
          inventory_sku_id: line.skuId, on_hand: -line.qty, updated_at: now,
        });
      }

      // ADR-007: append-only audit row. action is a plain string; no enum extension needed.
      await logAudit(ctx, {
        actor_id: "system",
        action: "stock.sale_movement",
        entity_type: "pos_inventory_skus",
        entity_id: line.skuId,   // logAudit accepts entity_id?: string; Id<T> is assignable
        source: "system",
        metadata: { transaction_id: args.transactionId, qty: -line.qty },
      });
    }
  },
});

/**
 * Return projected on-hand for a set of SKUs if the given quantities were
 * consumed right now. Used by the sale screen to flag low/negative stock
 * before the transaction is confirmed.
 * ADR-018: result can be negative — callers flag, not block.
 */
export const _projectedOnHand_internal = internalQuery({
  args: {
    skuQtys: v.array(v.object({ skuId: v.id("pos_inventory_skus"), qty: v.number() })),
  },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    // Parallel per-SKU level reads (I8 — was a sequential N+1 loop). Read-only.
    const levels = await Promise.all(
      args.skuQtys.map(({ skuId }) =>
        ctx.db
          .query("pos_stock_levels")
          .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
          .first(),
      ),
    );
    const result: Record<string, number> = {};
    args.skuQtys.forEach(({ skuId, qty }, i) => {
      result[skuId] = (levels[i]?.on_hand ?? 0) - qty;
    });
    return result;
  },
});

/**
 * Read current on_hand for a set of SKU IDs. Used by transactions/internal
 * to check post-decrement stock levels without touching inventory-owned tables
 * directly (ADR-034 module boundary).
 *
 * Returns a record keyed by skuId string. Missing SKUs (no level row) are
 * reported as 0 — consistent with the "no row = nothing received yet" convention
 * used by _recordSaleMovement_internal.
 */
export const _getOnHandBySkus_internal = internalQuery({
  args: {
    skuIds: v.array(v.id("pos_inventory_skus")),
  },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    // Parallel per-SKU level reads (I8 — was a sequential N+1 loop). Read-only.
    const levels = await Promise.all(
      args.skuIds.map((skuId) =>
        ctx.db
          .query("pos_stock_levels")
          .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
          .first(),
      ),
    );
    const result: Record<string, number> = {};
    args.skuIds.forEach((skuId, i) => {
      result[skuId as unknown as string] = levels[i]?.on_hand ?? 0;
    });
    return result;
  },
});

/**
 * Decrement on_hand directly without writing a movement row. Used by v0.5
 * stock-adjustment flows where the movement was already written separately.
 * Intentionally unexported for public use in v0.3 — kept for v0.5 callers.
 * ADR-018: may produce negative on_hand.
 */
export const _decrementOnHandUnchecked_internal = internalMutation({
  args: { skuId: v.id("pos_inventory_skus"), qty: v.number() },
  handler: async (ctx, args) => {
    const level = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_sku", (q) => q.eq("inventory_sku_id", args.skuId))
      .first();
    const now = Date.now();
    if (level) {
      await ctx.db.patch(level._id, { on_hand: level.on_hand - args.qty, updated_at: now });
    } else {
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: args.skuId, on_hand: -args.qty, updated_at: now,
      });
    }
  },
});
