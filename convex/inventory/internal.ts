import { internalAction, internalMutation, internalQuery, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";
import { internal, api } from "../_generated/api";

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

/**
 * Apply a signed delta to pos_stock_levels.on_hand for a single SKU. Inserts
 * the level row if none exists, otherwise patches in place. Returns the new
 * on_hand value so callers can include it in downstream payloads (e.g. the
 * recount manager-notice).
 *
 * v0.5.2 — extracted for recount (ADR-041). The sale + refund paths keep
 * using the local upsertStockLevel helper (different shape; intentional —
 * keeps regression surface zero in v0.5.2).
 */
export const _applyLevelDelta_internal = internalMutation({
  args: { skuId: v.id("pos_inventory_skus"), delta: v.number() },
  handler: async (ctx, { skuId, delta }) => {
    const now = Date.now();
    const level = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
      .first();
    if (level) {
      await ctx.db.patch(level._id, { on_hand: level.on_hand + delta, updated_at: now });
      return level.on_hand + delta;
    }
    await ctx.db.insert("pos_stock_levels", { inventory_sku_id: skuId, on_hand: delta, updated_at: now });
    return delta;
  },
});

/**
 * Reactive low-stock check for a single SKU (v0.5.2, ADR-042). Called from
 * stock-changing paths (sale decrement, refund credit, recount apply, stock-in)
 * via `ctx.scheduler.runAfter(0, ...)` so the side-effect is decoupled from the
 * mutation's primary writes.
 *
 * Reads catalog's `low_threshold` via the ADR-034 catalog internal (never
 * touches `pos_inventory_skus` directly from this module). Compares against
 * the denormalised `pos_stock_levels.on_hand`. The `pos_low_stock_alerts` row
 * is a dedup flag — its presence means "we've already alerted; don't spam".
 *
 * Three branches:
 * - `on_hand < threshold` AND no flag → insert flag, audit, schedule dispatch.
 * - `on_hand >= threshold` AND flag exists → delete flag (re-arm; silent — the
 *   operator already knows things recovered).
 * - Otherwise → no-op.
 */
export const _checkLowStock_internal = internalMutation({
  args: { skuId: v.id("pos_inventory_skus") },
  handler: async (ctx, { skuId }) => {
    const [sku] = await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, { skuIds: [skuId] });
    if (!sku) return;
    const level = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
      .first();
    const onHand = level?.on_hand ?? 0;
    const flag = await ctx.db
      .query("pos_low_stock_alerts")
      .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
      .first();

    const below = onHand < sku.low_threshold;
    if (below && !flag) {
      const now = Date.now();
      await ctx.db.insert("pos_low_stock_alerts", {
        inventory_sku_id: skuId,
        alerted_at: now,
        updated_at: now,
      });
      await logAudit(ctx, {
        actor_id: "system",
        action: "stock.low_stock_alerted",
        entity_type: "pos_inventory_skus",
        entity_id: skuId,
        source: "system",
        metadata: { on_hand: onHand, low_threshold: sku.low_threshold },
      });
      await ctx.scheduler.runAfter(0, internal.inventory.internal._dispatchLowStockAlert_internal, {
        sku_id: skuId,
        sku_name: sku.name,
        on_hand: onHand,
        low_threshold: sku.low_threshold,
      });
    } else if (!below && flag) {
      await ctx.db.delete(flag._id);
    }
  },
});

/**
 * Scheduled dispatch for low-stock alerts (v0.5.2, ADR-042). Routes through
 * the Telegram chat-registry to the `inventory` role and sends a `low_stock_alert`
 * template. Scheduled — never inline — so Telegram outages can't roll back the
 * flag-insert mutation that spawned it.
 *
 * Fail-isolated: if the `inventory` role isn't bound yet (common during early
 * setup), `getChatIdByRole` throws `"No Telegram chat assigned to role 'inventory'"`.
 * Swallow that one error string only — other errors propagate so genuine
 * Telegram outages surface in the Convex dashboard.
 *
 * idempotencyKey = `lowstock:<sku_id>:<on_hand>` so the same SKU at the same
 * on_hand level never re-sends; crossing two thresholds (e.g. 5→4→3 against a
 * threshold of 20) DOES emit two messages. Keyed on sku_id (not sku_name) since
 * display names are not guaranteed unique across SKUs.
 */
export const _dispatchLowStockAlert_internal = internalAction({
  args: {
    sku_id: v.id("pos_inventory_skus"),
    sku_name: v.string(),
    on_hand: v.number(),
    low_threshold: v.number(),
  },
  handler: async (ctx, args) => {
    let chatId: string;
    try {
      chatId = await ctx.runQuery(internal.telegram.chatRegistry.internal.getChatIdByRole, {
        role: "inventory",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) return;
      throw err;
    }
    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "inventory",
      kind: "low_stock_alert",
      payload: {
        sku_name: args.sku_name,
        on_hand: args.on_hand,
        low_threshold: args.low_threshold,
      },
      idempotencyKey: `lowstock:${args.sku_id}:${args.on_hand}`,
      chatIdOverride: chatId,
    });
  },
});
