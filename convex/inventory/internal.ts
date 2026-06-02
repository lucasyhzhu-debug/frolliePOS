import { internalMutation, internalQuery, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";
import { internal } from "../_generated/api";
import { reconstructOnHand, computeDrift } from "./lib";

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
export async function upsertStockLevel(
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
    const touched = new Set<Id<"pos_inventory_skus">>();
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
      // Track for the post-loop low-stock check. Populate ONLY in the non-dedup
      // branch so a re-fired sale (webhook + retry) doesn't re-trigger alerts.
      touched.add(line.skuId);
    }
    // v0.5.2 (ADR-042): low-stock check once per uniquely-decremented SKU.
    // SKU-deduped (Set) so two lines sharing one SKU only trigger one check.
    // "Fail-isolation" is at the Telegram-dispatch boundary (scheduled via
    // runAfter(0) inside checkLowStockOne), NOT here — the check's own
    // DB writes (flag, audit) are intentionally in the same transaction as the
    // sale movement, so a write failure rolls back the sale. Do NOT wrap in
    // try/catch.
    //
    // v0.5.2 simplify: batched so one runQuery against catalog covers all
    // touched SKUs (was: one per SKU via the single-id _checkLowStock_internal).
    if (touched.size > 0) {
      await ctx.runMutation(internal.inventory.internal._checkLowStockBatch_internal, {
        skuIds: Array.from(touched),
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
 * on the shelf; if actually damaged, staff uses the v0.6 spoilage flow as a
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

// _applyLevelDelta_internal removed in v0.5.2 simplify. Recount now calls
// the shared `upsertStockLevel` helper directly (exported above), matching
// the sale + refund paths. Saves a sub-transaction + a duplicate level
// lookup (recordRecount reads the level row to compute `delta`; the inline
// helper writes via the same `level._id` reference).

/**
 * Reactive low-stock check body, factored out so the single-id and batch
 * variants share the comparison + flag-write + dispatch-schedule logic.
 * `sku` is the pre-fetched catalog row (name + low_threshold); callers
 * are responsible for the catalog read.
 *
 * Three branches:
 * - `on_hand < threshold` AND no flag → insert flag, audit, schedule dispatch.
 * - `on_hand >= threshold` AND flag exists → delete flag (re-arm; silent — the
 *   operator already knows things recovered).
 * - Otherwise → no-op.
 */
async function checkLowStockOne(
  ctx: MutationCtx,
  skuId: Id<"pos_inventory_skus">,
  sku: { name: string; low_threshold: number },
): Promise<void> {
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
    });
    await logAudit(ctx, {
      actor_id: "system",
      action: "stock.low_stock_alerted",
      entity_type: "pos_inventory_skus",
      entity_id: skuId,
      source: "system",
      metadata: { on_hand: onHand, low_threshold: sku.low_threshold },
    });
    // v0.5.2 simplify: dispatch through the shared `dispatchRoleAlert`
    // helper. C2: thread `alerted_at` into the idempotency key so each
    // flag-insert cycle is unique (keying on on_hand would collide
    // across yo-yo bounces within the 24h action-cache window).
    await ctx.scheduler.runAfter(0, internal.telegram.dispatch.dispatchRoleAlert, {
      role: "inventory",
      kind: "low_stock_alert",
      payload: {
        sku_name: sku.name,
        on_hand: onHand,
        low_threshold: sku.low_threshold,
      },
      idempotencyKey: `lowstock:${skuId}:${now}`,
    });
  } else if (!below && flag) {
    await ctx.db.delete(flag._id);
  }
}

/**
 * Reactive low-stock check for a single SKU (v0.5.2, ADR-042). Called from
 * stock-changing paths via `ctx.scheduler.runAfter(0, ...)` so the
 * side-effect is decoupled from the mutation's primary writes.
 *
 * Reads catalog's `low_threshold` via the ADR-034 catalog internal (never
 * touches `pos_inventory_skus` directly from this module). Compares against
 * the denormalised `pos_stock_levels.on_hand`. The `pos_low_stock_alerts` row
 * is a dedup flag — its presence means "we've already alerted; don't spam".
 *
 * Hot paths (`_recordSaleMovement_internal`, `recordRecount`) should use the
 * batch variant `_checkLowStockBatch_internal` to avoid N catalog round-trips.
 * This single-id mutation is retained for ad-hoc callers + tests.
 */
export const _checkLowStock_internal = internalMutation({
  args: { skuId: v.id("pos_inventory_skus") },
  handler: async (ctx, { skuId }) => {
    const [sku] = await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, { skuIds: [skuId] });
    if (!sku) return;
    await checkLowStockOne(ctx, skuId, sku);
  },
});

/**
 * Batch variant of `_checkLowStock_internal` (v0.5.2). Takes an array of
 * SKU ids, reads catalog once via the existing batch seam, then runs the
 * shared body per SKU. Saves N-1 catalog round-trips on the hot sale +
 * recount paths.
 */
export const _checkLowStockBatch_internal = internalMutation({
  args: { skuIds: v.array(v.id("pos_inventory_skus")) },
  handler: async (ctx, { skuIds }) => {
    if (skuIds.length === 0) return;
    const skus = await ctx.runQuery(
      internal.catalog.internal._getSkusByIds_internal,
      { skuIds },
    );
    const skuByIdStr = new Map<string, { name: string; low_threshold: number }>(
      skus.map((s) => [String(s.skuId), { name: s.name, low_threshold: s.low_threshold }]),
    );
    for (const skuId of skuIds) {
      const sku = skuByIdStr.get(String(skuId));
      if (!sku) continue;
      await checkLowStockOne(ctx, skuId, sku);
    }
  },
});

// _dispatchLowStockAlert_internal + _dispatchRecountNotice_internal removed
// in v0.5.2 simplify. Both collapsed into the shared
// `internal.telegram.dispatch.dispatchRoleAlert` helper — the role + kind +
// payload + idempotencyKey parameters carry everything the per-feature
// wrappers were doing inline. See convex/telegram/dispatch.ts.

/**
 * Single writer for spoilage events (v0.6, Task S3). Called by BOTH:
 *   - inventory.actions.recordSpoilage (booth path, manager-PIN)        — Task S4
 *   - approvals.actions.approveSpoilage (off-booth Telegram path)        — Task S5
 *
 * The two callers differ only in `source` ("booth_inline" vs "telegram_approval")
 * and `actor_id`. All other behavior is identical: N pos_stock_movements rows
 * (negative qty, source="spoilage", grouped by spoilage_event_id) + per-SKU
 * on_hand decrement via the shared upsertStockLevel helper + ONE
 * stock.spoilage audit row with the full line breakdown in metadata.
 *
 * Validators (LINES_EMPTY / REASON_INVALID / QTY_INVALID) live here so neither
 * caller has to revalidate — boundary-trust pattern.
 *
 * Server time wins (ADR-031): single `now` snapshot reused across every movement
 * row, on_hand patch, and the audit row.
 *
 * Negative qty convention matches sale/refund paths: spoilage decrements, so
 * movement.qty is signed-negative. Reverses through the same on_hand cache the
 * sale path writes; ADR-018 allows negative on_hand without blocking.
 */
export const _recordSpoilage_internal = internalMutation({
  args: {
    spoilage_event_id: v.string(),
    lines: v.array(v.object({
      inventory_sku_id: v.id("pos_inventory_skus"),
      qty: v.number(),
    })),
    reason: v.string(),
    actor_id: v.id("staff"),
    source: v.union(v.literal("booth_inline"), v.literal("telegram_approval")),
    device_id: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ event_id: string; line_count: number; total_qty: number }> => {
    if (args.lines.length === 0) throw new Error("LINES_EMPTY");
    if (args.reason.trim().length === 0 || args.reason.length > 200) {
      throw new Error("REASON_INVALID");
    }

    const now = Date.now();
    let total = 0;
    const lineLog: Array<{ sku_id: string; qty: number }> = [];

    for (const line of args.lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) throw new Error("QTY_INVALID");

      await ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: line.inventory_sku_id,
        qty: -line.qty,
        source: "spoilage",
        spoilage_event_id: args.spoilage_event_id,
        spoilage_reason: args.reason,
        recorded_by_staff_id: args.actor_id,
        created_at: now,
      });

      // Decrement on_hand cache via the shared upsert helper — matches the
      // sale/refund paths and inserts a row when none exists yet (first-ever
      // SKU activity; ADR-018 allows negative on_hand).
      await upsertStockLevel(ctx, line.inventory_sku_id, -line.qty, now);

      total += line.qty;
      lineLog.push({ sku_id: String(line.inventory_sku_id), qty: line.qty });
    }

    // ONE audit per event (not per line) — metadata.lines carries the breakdown
    // so dashboards can drill in without a per-line scan of audit_log.
    await logAudit(ctx, {
      actor_id: args.actor_id,
      action: "stock.spoilage",
      entity_type: "pos_stock_movements",
      entity_id: args.spoilage_event_id,
      source: args.source,
      device_id: args.device_id,
      metadata: {
        event_id: args.spoilage_event_id,
        total_qty: total,
        line_count: args.lines.length,
        reason: args.reason,
        lines: lineLog,
      },
    });

    return {
      event_id: args.spoilage_event_id,
      line_count: args.lines.length,
      total_qty: total,
    };
  },
});

/**
 * Nightly stock-recon writer (v0.6, Task R4, ADR-044).
 *
 * For each ACTIVE SKU (via catalog._getActiveSkus_internal — ADR-034 module
 * boundary): reconstruct on_hand from the immutable pos_stock_movements ledger
 * and compare to cached pos_stock_levels.on_hand. On drift, write a
 * pos_stock_drift_log row + a stock.recon_drift audit row, and add the entry
 * to the returned drifted[] list.
 *
 * ADR-044 spirit: REPORT-ONLY. We never silently auto-correct
 * pos_stock_levels to match the ledger — manager investigates the source of
 * the drift (missed spoilage, missed recount, double-decrement bug) and
 * resolves explicitly via _resolveDrift_internal. Silent self-healing would
 * mask the bug we're trying to surface.
 *
 * Inactive SKUs are excluded — they're not in the daily flow and a stale
 * cache row from before archival is not actionable.
 *
 * sku_code snapshot: catalog R2 helper returns `sku` (not `code`); we
 * snapshot it onto drift_log.sku_code at write time so the report row
 * survives later SKU renames (mirrors voucher code_snapshot rationale).
 */
export const _runStockRecon_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<{
    scanned: number;
    drifted: Array<{ sku_code: string; delta: number; cached: number; reconstructed: number }>;
  }> => {
    const skus = await ctx.runQuery(internal.catalog.internal._getActiveSkus_internal, {});
    const now = Date.now();
    const drifted: Array<{ sku_code: string; delta: number; cached: number; reconstructed: number }> = [];

    for (const sku of skus) {
      const movements = await ctx.db
        .query("pos_stock_movements")
        .withIndex("by_sku_created", (q) => q.eq("inventory_sku_id", sku._id))
        .collect();
      const reconstructed = reconstructOnHand(movements);
      const level = await ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", sku._id))
        .first();
      const cached = level?.on_hand ?? 0;
      const { drift, delta } = computeDrift(cached, reconstructed);
      if (drift) {
        await ctx.db.insert("pos_stock_drift_log", {
          inventory_sku_id: sku._id,
          sku_code: sku.sku,
          cached_on_hand: cached,
          reconstructed_on_hand: reconstructed,
          delta,
          detected_at: now,
        });
        await logAudit(ctx, {
          actor_id: "system",
          action: "stock.recon_drift",
          entity_type: "pos_inventory_skus",
          entity_id: sku._id,
          source: "system",
          metadata: { sku_code: sku.sku, cached, reconstructed, delta },
        });
        drifted.push({ sku_code: sku.sku, delta, cached, reconstructed });
      }
    }
    return { scanned: skus.length, drifted };
  },
});

/**
 * Per-cron audit-skip helper for the stock-recon cron. Pattern mirrors
 * telegram._auditFoundersSkip_internal — no generic auditSkip exists;
 * each cron owns its skip mutation in its own module (staffreview-verified
 * pattern from v0.4 founders-summary work).
 *
 * Reasons:
 *   - "no_drift"     — recon ran clean (0 drifted SKUs); skip dispatch.
 *   - "role_unbound" — `inventory` Telegram role not bound; nothing to notify.
 *   - "send_failed"  — Telegram send threw; we logged and moved on (no retry storm).
 */
export const _auditStockReconSkip_internal = internalMutation({
  args: {
    reason: v.union(v.literal("no_drift"), v.literal("role_unbound"), v.literal("send_failed")),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: "system",
      action: "stock.recon_skip",
      entity_type: "pos_stock_drift_log",
      entity_id: "system",
      source: "system",
      metadata: { reason: args.reason, ...(args.metadata ?? {}) },
    });
  },
});

/**
 * Manager-driven drift resolution (v0.6, Task R4, ADR-044).
 *
 * Marks a pos_stock_drift_log row resolved with the manager's note and emits
 * a stock.recon_drift_resolved audit row. Called from the booth resolve UI
 * (R8) after the manager investigates and corrects the underlying cause
 * (typically via a recount or spoilage event).
 *
 * Idempotent: a second call on an already-resolved row is a silent no-op
 * (no second audit row). Lets the booth retry without duplicating history.
 *
 * NOTE_TOO_LONG cap at 500 chars — keeps audit_log metadata bounded.
 */
export const _resolveDrift_internal = internalMutation({
  args: {
    driftId: v.id("pos_stock_drift_log"),
    resolved_by: v.id("staff"),
    note: v.string(),
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await ctx.db.get(args.driftId);
    if (!row) throw new Error("DRIFT_NOT_FOUND");
    if (row.resolved_at != null) return { ok: true as const };
    if (args.note.length > 500) throw new Error("NOTE_TOO_LONG");

    await ctx.db.patch(args.driftId, {
      resolved_at: Date.now(),
      resolved_by_staff_id: args.resolved_by,
      resolution_note: args.note,
    });
    await logAudit(ctx, {
      actor_id: args.resolved_by,
      action: "stock.recon_drift_resolved",
      entity_type: "pos_stock_drift_log",
      entity_id: args.driftId,
      source: "booth_inline",
      device_id: args.device_id,
      metadata: { sku_code: row.sku_code, delta: row.delta, note: args.note },
    });
    return { ok: true as const };
  },
});
