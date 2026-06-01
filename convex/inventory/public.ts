import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireSession, requireManagerSession } from "../auth/sessions";
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

type SetThresholdResult = { ok: true };

/**
 * Manager-gated mutation to update a SKU's `low_threshold` (v0.5.2, ADR-042).
 *
 * ADR-013 (idempotency) + rule #21: `authCheck` runs `requireManagerSession`
 * BEFORE the cache lookup so a cached response can't be replayed against a
 * non-manager session. The handler RE-CALLS `requireManagerSession` to get
 * the typed staffId for the audit row — the duplication is intentional and
 * cheap (one indexed query against `staff_sessions`).
 *
 * Rejects `lowThreshold < 0` (NEGATIVE_THRESHOLD) — a negative threshold has
 * no operational meaning (the low-stock check is `on_hand < threshold`, and
 * `on_hand < 0` is its own "negative" status bucket).
 *
 * Writes `stock.low_threshold_set` audit row with `source: booth_inline` and
 * the new threshold in metadata.
 */
export const setLowThreshold = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    skuId: v.id("pos_inventory_skus"),
    lowThreshold: v.number(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      skuId: Id<"pos_inventory_skus">;
      lowThreshold: number;
    },
    SetThresholdResult
  >(
    "inventory.setLowThreshold",
    async (ctx, args) => {
      const { staffId } = await requireManagerSession(ctx, args.sessionId);
      if (args.lowThreshold < 0) throw new Error("NEGATIVE_THRESHOLD");
      await ctx.runMutation(internal.catalog.internal._setLowThreshold_internal, {
        skuId: args.skuId,
        lowThreshold: args.lowThreshold,
      });
      await logAudit(ctx, {
        actor_id: staffId,
        action: "stock.low_threshold_set",
        entity_type: "pos_inventory_skus",
        entity_id: args.skuId,
        source: "booth_inline",
        metadata: { low_threshold: args.lowThreshold },
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
 * Staff-gated query returning one row per active inventory SKU with the
 * derived status bucket for the inventory dashboard (v0.5.2).
 *
 * Status precedence: `negative` (on_hand < 0) > `low` (0 <= on_hand <
 * low_threshold) > `ok`. Threshold === 0 with on_hand === 0 yields `ok`
 * because `0 < 0` is false — matches `_checkLowStock_internal` semantics.
 *
 * Missing `pos_stock_levels` rows are treated as `on_hand = 0` (first-ever
 * count scenario — same convention as recordRecount + _checkLowStock).
 *
 * `levelBySku` Map is keyed by `String(id)` because Convex Ids don't behave
 * intuitively as Map keys across runs — string-keyed lookup is the safe
 * pattern (mirrors `getStockLevels` above).
 */
type InventoryRow = {
  skuId: Id<"pos_inventory_skus">;
  name: string;
  on_hand: number;
  low_threshold: number;
  status: "ok" | "low" | "negative";
};

export const listInventory = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<InventoryRow[]> => {
    await requireSession(ctx, args.sessionId);
    const activeIds: Id<"pos_inventory_skus">[] = await ctx.runQuery(
      internal.catalog.internal._getActiveSkuIds_internal,
      {},
    );
    const skus: Array<{ skuId: Id<"pos_inventory_skus">; name: string; low_threshold: number }> =
      await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, {
        skuIds: activeIds,
      });
    const levels = await ctx.db.query("pos_stock_levels").collect();
    const levelBySku = new Map(levels.map((l) => [String(l.inventory_sku_id), l.on_hand]));
    return skus.map((s) => {
      const onHand = levelBySku.get(String(s.skuId)) ?? 0;
      let status: "ok" | "low" | "negative" = "ok";
      if (onHand < 0) status = "negative";
      else if (onHand < s.low_threshold) status = "low";
      return {
        skuId: s.skuId,
        name: s.name,
        on_hand: onHand,
        low_threshold: s.low_threshold,
        status,
      };
    });
  },
});

/**
 * Staff-gated query for the per-SKU drill-down: current level, threshold,
 * and the last 30 stock movements in DESC order (v0.5.2). Backs the SKU
 * detail screen on the inventory dashboard.
 */
export const getSkuDetail = query({
  args: {
    sessionId: v.id("staff_sessions"),
    skuId: v.id("pos_inventory_skus"),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionId);
    const skus: Array<{ skuId: Id<"pos_inventory_skus">; name: string; low_threshold: number }> =
      await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, {
        skuIds: [args.skuId],
      });
    const sku = skus[0];
    const level = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_sku", (q) => q.eq("inventory_sku_id", args.skuId))
      .first();
    const movements = await ctx.db
      .query("pos_stock_movements")
      .withIndex("by_sku_created", (q) => q.eq("inventory_sku_id", args.skuId))
      .order("desc")
      .take(30);
    return {
      name: sku?.name ?? String(args.skuId),
      on_hand: level?.on_hand ?? 0,
      low_threshold: sku?.low_threshold ?? 0,
      movements,
    };
  },
});

/**
 * Staff-gated query for the `pos_recount_state` singleton. Returns
 * `last_recount_at: null` when the row hasn't been seeded (no recount has
 * ever been recorded) — callers render "no recount yet" in that case.
 */
export const getRecountState = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionId);
    const row = await ctx.db.query("pos_recount_state").first();
    return { last_recount_at: row?.last_recount_at ?? null };
  },
});
