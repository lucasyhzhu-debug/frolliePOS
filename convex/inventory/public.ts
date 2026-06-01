import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";

/**
 * Reactive map of inventory_sku_id → on_hand for ACTIVE SKUs only.
 * Active-status comes from catalog via its internal API (ADR-034: inventory
 * does not read catalog-owned pos_inventory_skus directly). Consumed by
 * useCart (live cart validation) and the catalog query.
 */
export const getStockLevels = query({
  args: {},
  handler: async (ctx): Promise<Record<string, number>> => {
    const activeIds = await ctx.runQuery(
      internal.catalog.internal._getActiveSkuIds_internal,
      {},
    );
    const activeSet = new Set<Id<"pos_inventory_skus">>(activeIds);

    const levels = await ctx.db.query("pos_stock_levels").collect();
    const result: Record<string, number> = {};
    for (const lvl of levels) {
      if (activeSet.has(lvl.inventory_sku_id)) {
        result[lvl.inventory_sku_id] = lvl.on_hand;
      }
    }
    return result;
  },
});

type RecountResult = { ok: true; changed: number };

/**
 * Record a physical recount for one or more SKUs (v0.5.2, ADR-041).
 *
 * Per-SKU semantics:
 * - `entered < 0` → throws `NEGATIVE_COUNT`. Recount is a physical count;
 *   negatives are user-error, not a valid state.
 * - `delta === 0` (entered === current on_hand) → skipped entirely. No
 *   movement row, no audit, no notice line. The recount UI may surface
 *   "no change" to the operator; this mutation just doesn't write churn.
 * - First-ever count (no `pos_stock_levels` row) → treats `before = 0`,
 *   inserts the level via `_applyLevelDelta_internal` with `delta = entered`.
 *
 * After the per-SKU loop:
 * - If nothing was touched, return early with `{ changed: 0 }` — no state
 *   stamp, no dispatch.
 * - Otherwise, patch (or insert) `pos_recount_state.last_recount_at` so the
 *   dashboard can show "last recount at X" and the daily summary can flag
 *   when a recount is overdue.
 * - Schedule `_dispatchRecountNotice_internal` via `runAfter(0, ...)` so a
 *   Telegram outage can't roll back the recount writes. The action is
 *   audited via the standard sendTemplate fail path.
 * - Run `_checkLowStock_internal` once per touched SKU. Recount can push a
 *   SKU below threshold (new alert) OR back above threshold (re-arm) — both
 *   are valid outcomes.
 *
 * ADR-013 (idempotency): wrapped by `withIdempotency` with an `authCheck`
 * that re-validates the session BEFORE cache lookup (rule #21). The handler
 * RE-CALLS `requireSession` inside to get the typed session object — the
 * duplication is intentional: it keeps the rule mechanical and is cheap
 * (one indexed query). Do not collapse.
 */
export const recordRecount = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    counts: v.array(v.object({
      skuId: v.id("pos_inventory_skus"),
      entered: v.number(),
    })),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      counts: { skuId: Id<"pos_inventory_skus">; entered: number }[];
    },
    RecountResult
  >(
    "inventory.recordRecount",
    async (ctx, args) => {
      const { staffId } = await requireSession(ctx, args.sessionId);
      const staff = await ctx.db.get(staffId);
      const now = Date.now();
      const touched: Id<"pos_inventory_skus">[] = [];
      const noticeLines: { sku_name: string; before: number; after: number; delta: number }[] = [];

      for (const { skuId, entered } of args.counts) {
        if (entered < 0) throw new Error("NEGATIVE_COUNT");
        const level = await ctx.db
          .query("pos_stock_levels")
          .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuId))
          .first();
        const before = level?.on_hand ?? 0;
        const delta = entered - before;
        if (delta === 0) continue;

        await ctx.db.insert("pos_stock_movements", {
          inventory_sku_id: skuId,
          qty: delta,
          source: "recount",
          created_at: now,
          recorded_by_staff_id: staffId,
        });
        await ctx.runMutation(internal.inventory.internal._applyLevelDelta_internal, {
          skuId,
          delta,
        });
        await logAudit(ctx, {
          actor_id: staffId,
          action: "stock.recount",
          entity_type: "pos_inventory_skus",
          entity_id: skuId,
          source: "booth_inline",
          metadata: { before, after: entered, delta },
        });
        const [sku] = await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, {
          skuIds: [skuId],
        });
        noticeLines.push({
          sku_name: sku?.name ?? String(skuId),
          before,
          after: entered,
          delta,
        });
        touched.push(skuId);
      }

      if (touched.length === 0) return { ok: true as const, changed: 0 };

      const state = await ctx.db.query("pos_recount_state").first();
      if (state) {
        await ctx.db.patch(state._id, { last_recount_at: now, updated_by_staff_id: staffId });
      } else {
        await ctx.db.insert("pos_recount_state", {
          last_recount_at: now,
          updated_by_staff_id: staffId,
        });
      }

      // ADR-041: Telegram dispatch is scheduled — never inline — so the
      // recount writes commit even if Telegram is down. recorded_at_iso uses
      // the same `now` snapshot, allowed inside Convex functions because it's
      // an explicit Date.now() (not the no-arg Date() constructor).
      await ctx.scheduler.runAfter(0, internal.inventory.internal._dispatchRecountNotice_internal, {
        staff_name: staff?.name ?? "Staff",
        recorded_at_iso: new Date(now).toISOString(),
        lines: noticeLines,
      });
      // ADR-042: low-stock check per touched SKU. Recount can cross threshold
      // in either direction; the check is the single source of truth for
      // flag insertion + dispatch + re-arm.
      for (const skuId of touched) {
        await ctx.runMutation(internal.inventory.internal._checkLowStock_internal, { skuId });
      }
      return { ok: true as const, changed: touched.length };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});
