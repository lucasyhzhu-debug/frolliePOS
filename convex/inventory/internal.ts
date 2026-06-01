import { internalMutation, internalQuery, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";

/**
 * Upsert pattern for pos_stock_levels — the denormalised cache reconciled by
 * nightly cron (CLAUDE.md business rule #8). Used by sale-decrement, refund-
 * credit, manager-adjust, and (v0.5.2) recount/low-stock paths.
 *
 * `delta` can be negative (sale decrement) or positive (refund credit / stock-in).
 * Negative on_hand is ALLOWED — ADR-018 says we don't block; we flag on the
 * transaction. The cache reflects what actually moved.
 *
 * Server time wins per ADR-031: caller passes `now` from a single `Date.now()`
 * snapshot so all rows in a single mutation share the same timestamp.
 */
async function upsertStockLevel(
  ctx: MutationCtx,
  skuId: Id<"pos_inventory_skus">,
  delta: number,
  now: number,
): Promise<void> {
  const level = await ctx.db
    .query("pos_stock_levels")
    .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
    .first();
  if (level) {
    await ctx.db.patch(level._id, {
      on_hand: level.on_hand + delta,
      updated_at: now,
    });
  } else {
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuId,
      on_hand: delta,
      updated_at: now,
    });
  }
}

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
      await upsertStockLevel(ctx, line.skuId, -line.qty, now);

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
    const now = Date.now();
    await upsertStockLevel(ctx, args.skuId, -args.qty, now);
  },
});

/**
 * Refund-flow stock re-credit per ADR-019. For each refunded line, look up the
 * IMMUTABLE sale movements (the proof of what got decremented at sale time)
 * and write POSITIVE counterpart movements (source: "refund"). Increments the
 * on_hand cache (opposite of sale). Default assumption: returned items go back
 * on the shelf; if actually damaged, staff uses the v0.5.2 spoilage flow as a
 * second step.
 *
 * I3 (v0.5.1 PR B post-review): pre-I3 this re-derived components by querying
 * pos_product_components for the line's product_id at refund-time. That broke
 * recipe-drift safety — if a manager edited a product's recipe between sale and
 * refund, the refund would re-credit the NEW recipe's SKUs/qtys, not what was
 * actually decremented at sale time. Worse, it read pos_transaction_lines
 * directly (ADR-034 violation — that table is transactions-owned). The fix
 * reads pos_stock_movements (inventory-owned) and ratios down by qty: each
 * sale movement carries the FULL line qty's decrement, so component_qty =
 * abs(sale_movement.qty) / line.qty, and refund_qty's credit is
 * component_qty * refund_qty. Avoids both the cross-module read AND the
 * recipe-drift bug in one shot.
 *
 * Caller (refunds._commitRefund_internal) now passes line_qty for each line so
 * we can do the per-unit ratio without reading pos_transaction_lines.
 */
export const _refundReCredit_internal = internalMutation({
  args: {
    refundId: v.id("pos_refunds"),
    transactionId: v.id("pos_transactions"),
    lines: v.array(v.object({
      line_id: v.id("pos_transaction_lines"),
      line_qty: v.number(),    // I3: original line qty (immutable post-paid) — needed
                                // to ratio the sale movements down to per-unit components.
      qty: v.number(),         // refund qty
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const { line_id, line_qty, qty } of args.lines) {
      // I3: read the historic sale movements for this line (immutable proof of
      // what got decremented at sale time). by_line_and_sku index keys on
      // source_transaction_line_id so this is a single indexed range scan.
      const saleMovements = await ctx.db
        .query("pos_stock_movements")
        .withIndex("by_line_and_sku", (q) => q.eq("source_transaction_line_id", line_id))
        .collect();

      // Defensive: line_qty > 0 enforced upstream (REFUND_QTY_INVALID), but
      // belt-and-braces here since this function trusts the caller's qty
      // and a zero would NaN the ratio.
      if (line_qty <= 0) throw new Error("LINE_QTY_INVALID");

      for (const m of saleMovements) {
        // Only credit sale-source movements. A future re-credit must never
        // re-credit an earlier refund's own movement (filtering on source="sale"
        // is the invariant that lets partial refunds compose safely).
        if (m.source !== "sale") continue;

        // sale movement qty is signed-negative (decrement). Per-unit consumption
        // for THIS SKU on THIS line = abs(m.qty) / line_qty. Refund credit for
        // refund_qty = per-unit * refund_qty. All integers — line_qty divides
        // m.qty exactly because the sale wrote component_qty * line_qty.
        const perUnit = Math.abs(m.qty) / line_qty;
        const movementQty = perUnit * qty;  // POSITIVE — re-credit
        const skuId: Id<"pos_inventory_skus"> = m.inventory_sku_id;

        await ctx.db.insert("pos_stock_movements", {
          inventory_sku_id: skuId,
          qty: movementQty,
          source: "refund",
          source_transaction_line_id: line_id,
          created_at: now,
        });

        // INCREMENT the denormalised on_hand cache (opposite of sale).
        await upsertStockLevel(ctx, skuId, movementQty, now);

        // ADR-007: append-only audit row. action is a plain string; no enum extension needed.
        await logAudit(ctx, {
          actor_id: "system",
          action: "stock.refund_movement",
          entity_type: "pos_inventory_skus",
          entity_id: skuId,
          source: "system",
          metadata: {
            refund_id: args.refundId,
            transaction_id: args.transactionId,
            line_id,
            qty: movementQty,
          },
        });
      }
    }
  },
});
