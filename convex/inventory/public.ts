import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireSession, requireManagerSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";
import { upsertStockLevel } from "./internal";

/**
 * Reactive map of inventory_sku_id → on_hand for ACTIVE SKUs only.
 * Active-status comes from catalog via its internal API (ADR-034: inventory
 * does not read catalog-owned pos_inventory_skus directly). Consumed by
 * useCart (live cart validation) and the catalog query.
 *
 * v2.0 Task 9B: this query has NO sessionId, so outlet_id is not available.
 * The index reads remain global. TODO Task 12: inject sessionId so this can
 * scope by outlet.
 */
export const getStockLevels = query({
  args: {},
  handler: async (ctx): Promise<Record<string, number>> => {
    const activeIds = await ctx.runQuery(
      internal.catalog.internal._getActiveSkuIds_internal,
      {},  // outletId: undefined → falls back to global by_active index
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
 *   inserts the level via `upsertStockLevel` with `delta = entered`.
 *
 * After the per-SKU loop:
 * - If nothing was touched, return early with `{ changed: 0 }` — no state
 *   stamp, no dispatch.
 * - Otherwise, patch (or insert) `pos_recount_state.last_recount_at` so the
 *   dashboard can show "last recount at X" and the daily summary can flag
 *   when a recount is overdue.
 * - Schedule `telegram.dispatch.dispatchRoleAlert` (recount_notice kind) via
 *   `runAfter(0, ...)` so a Telegram outage can't roll back the recount
 *   writes. The action is audited via the standard sendTemplate fail path
 *   plus `telegram.skipped` on role-unbound.
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
      const { staffId, outlet_id } = await requireSession(ctx, args.sessionId);
      const staff = await ctx.db.get(staffId);
      // Invariant: requireSession proved an active session bound to this
      // staffId — if the row vanished between session-check and now,
      // something is corrupt. Surface it rather than silently falling back.
      if (!staff) throw new Error("STAFF_MISSING_INVARIANT");
      const now = Date.now();
      const touched: Id<"pos_inventory_skus">[] = [];
      const noticeLines: { sku_name: string; before: number; after: number; delta: number }[] = [];

      // v0.5.2 simplify: batch the SKU lookup ONCE upfront. Pre-fix this was
      // a per-iteration runQuery inside the loop (N round-trips for N SKUs).
      // The catalog internal already accepts an array of skuIds; one call
      // returns the full lookup table.
      const skuLookup = await ctx.runQuery(
        internal.catalog.internal._getSkusByIds_internal,
        { skuIds: args.counts.map((c) => c.skuId) },
      );
      const nameBySku = new Map<string, string>(
        skuLookup.map((s) => [String(s.skuId), s.name]),
      );

      // C1: dedup-guard the input counts. Same SKU listed twice in one
      // recount payload is ambiguous (which "entered" wins?) and pre-fix
      // produced a double-write of stock movements with both deltas applied
      // against the same on_hand cache. Reject upfront with DUPLICATE_SKU.
      const seenSkus = new Set<Id<"pos_inventory_skus">>();
      for (const { skuId, entered } of args.counts) {
        if (seenSkus.has(skuId)) throw new Error("DUPLICATE_SKU");
        seenSkus.add(skuId);
        // I9: a non-integer count is physically nonsensical (the shelf
        // holds whole pieces). Reject before the negative check so the
        // error is specific.
        if (!Number.isInteger(entered)) throw new Error("NON_INTEGER_COUNT");
        if (entered < 0) throw new Error("NEGATIVE_COUNT");
        // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outlet_id may be undefined).
        const level = await ctx.db
          .query("pos_stock_levels")
          .withIndex("by_outlet_sku", (q) =>
            q.eq("outlet_id", outlet_id).eq("inventory_sku_id", skuId),
          )
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
          // v2.0 Task 9E: stamp outlet_id on recount movements (mirrors
          // sale/refund/spoilage paths). outlet_id is resolved from the session
          // at the top of the handler; undefined for pre-migration rows.
          outlet_id,
        });
        // v0.5.2 simplify: call the shared upsertStockLevel helper directly
        // (was: _applyLevelDelta_internal sub-transaction). Saves a runMutation
        // round-trip AND the helper's own duplicate level-row lookup — the
        // outer loop already read `level` two lines up.
        // v2.0 Task 9E: pass outlet_id so the level row is stamped/scoped correctly.
        await upsertStockLevel(ctx, skuId, delta, now, outlet_id);
        await logAudit(ctx, {
          actor_id: staffId,
          action: "stock.recount",
          entity_type: "pos_inventory_skus",
          entity_id: skuId,
          source: "booth_inline",
          metadata: { before, after: entered, delta },
        });
        // Invariant: the SKU id came from `level` (which we just read via the
        // by_sku index keyed on a real pos_inventory_skus row OR from args
        // pre-validated by Convex's v.id validator). A miss means catalog
        // corruption — surface it loudly rather than masking with String(skuId).
        const name = nameBySku.get(String(skuId));
        if (!name) throw new Error("SKU_MISSING_INVARIANT");
        noticeLines.push({ sku_name: name, before, after: entered, delta });
        touched.push(skuId);
      }

      if (touched.length === 0) return { ok: true as const, changed: 0 };

      // v2.0 Task 5: recount state is per-outlet.
      const state = outlet_id
        ? await ctx.db.query("pos_recount_state").withIndex("by_outlet", (q) => q.eq("outlet_id", outlet_id)).first()
        : await ctx.db.query("pos_recount_state").first();
      if (state) {
        await ctx.db.patch(state._id, { last_recount_at: now });
      } else {
        await ctx.db.insert("pos_recount_state", {
          last_recount_at: now,
          outlet_id,
        });
      }

      // ADR-041: Telegram dispatch is scheduled — never inline — so the
      // recount writes commit even if Telegram is down. recorded_at_iso uses
      // the same `now` snapshot, allowed inside Convex functions because it's
      // an explicit Date.now() (not the no-arg Date() constructor).
      const recorded_at_iso = new Date(now).toISOString();
      await ctx.scheduler.runAfter(0, internal.telegram.dispatch.dispatchRoleAlert, {
        role: "managers",
        kind: "recount_notice",
        payload: {
          staff_name: staff.name,
          recorded_at_iso,
          lines: noticeLines,
        },
        // Per-outlet key (rule #27): a bare timestamp key would dedupe across
        // outlets via the action-cache — two same-ms recounts at different outlets
        // would silently drop the second alert. outlet_id makes the key per-outlet.
        idempotencyKey: `recount:${outlet_id}:${recorded_at_iso}`,
        outletId: outlet_id,
      });
      // ADR-042: low-stock check per touched SKU. Recount can cross threshold
      // in either direction; the check is the single source of truth for
      // flag insertion + dispatch + re-arm.
      //
      // v0.5.2 simplify: batched so one runQuery against catalog covers all
      // touched SKUs (was: one per SKU via the single-id _checkLowStock_internal).
      // v2.0 Task 9B: pass outlet_id so checkLowStockOne uses outlet-scoped indexes.
      await ctx.runMutation(internal.inventory.internal._checkLowStockBatch_internal, {
        skuIds: touched,
        outlet_id,
      });
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
      // I10: integer guard (matches recount I9). A fractional threshold has
      // no operational meaning — on_hand is a whole-piece count.
      if (!Number.isInteger(args.lowThreshold)) throw new Error("NON_INTEGER_THRESHOLD");
      if (args.lowThreshold < 0) throw new Error("NEGATIVE_THRESHOLD");
      // I4: read prior threshold via the existing catalog seam so the audit
      // row carries both before/after — manager audit drill-down needs the
      // delta, not just the new value.
      const [skuBefore] = await ctx.runQuery(
        internal.catalog.internal._getSkusByIds_internal,
        { skuIds: [args.skuId] },
      );
      const beforeThreshold = skuBefore?.low_threshold ?? 0;
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
        metadata: { before: beforeThreshold, after: args.lowThreshold },
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
    const { outlet_id } = await requireSession(ctx, args.sessionId);
    // v2.0 Task 9B: pass outlet_id to scope active SKU list by outlet when available.
    const activeIds: Id<"pos_inventory_skus">[] = await ctx.runQuery(
      internal.catalog.internal._getActiveSkuIds_internal,
      { outletId: outlet_id },
    );
    const skus: Array<{ skuId: Id<"pos_inventory_skus">; name: string; low_threshold: number }> =
      await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, {
        skuIds: activeIds,
      });
    // v2.0 Task 9B: scope stock levels to outlet when available.
    const levels = outlet_id
      ? await ctx.db
          .query("pos_stock_levels")
          .withIndex("by_outlet_sku", (q) => q.eq("outlet_id", outlet_id))
          .collect()
      : await ctx.db.query("pos_stock_levels").collect();
    // v0.5.2 simplify: Convex Ids ARE strings at runtime; Map.get works without
    // the String() cast. Drop the cast on both sides of the lookup.
    const levelBySku = new Map(levels.map((l) => [l.inventory_sku_id, l.on_hand]));
    return skus.map((s) => {
      const onHand = levelBySku.get(s.skuId) ?? 0;
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
    const { outlet_id } = await requireSession(ctx, args.sessionId);
    const skus: Array<{ skuId: Id<"pos_inventory_skus">; name: string; low_threshold: number }> =
      await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, {
        skuIds: [args.skuId],
      });
    // v0.5.2 simplify: requireSession validated; args.skuId is a v.id-validated
    // catalog reference. A missing row IS catalog corruption — surface loudly
    // rather than masking with String(skuId) / 0 fallbacks.
    const sku = skus[0];
    if (!sku) throw new Error("SKU_MISSING_INVARIANT");
    // v2.0 Task 9B: scope stock level + movements by outlet.
    // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outlet_id may be undefined).
    const level = await ctx.db
      .query("pos_stock_levels")
      .withIndex("by_outlet_sku", (q) =>
        q.eq("outlet_id", outlet_id).eq("inventory_sku_id", args.skuId),
      )
      .first();
    // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outlet_id may be undefined).
    const movements = await ctx.db
      .query("pos_stock_movements")
      .withIndex("by_outlet_sku_created", (q) =>
        q.eq("outlet_id", outlet_id).eq("inventory_sku_id", args.skuId),
      )
      .order("desc")
      .take(30);
    return {
      name: sku.name,
      // on_hand ?? 0 stays — a missing level row legitimately means
      // "no stock recorded yet" (first sale before any stock-in), NOT corruption.
      on_hand: level?.on_hand ?? 0,
      low_threshold: sku.low_threshold,
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
    const { outlet_id } = await requireSession(ctx, args.sessionId);
    // v2.0 Task 5: per-outlet recount state.
    const row = outlet_id
      ? await ctx.db.query("pos_recount_state").withIndex("by_outlet", (q) => q.eq("outlet_id", outlet_id)).first()
      : await ctx.db.query("pos_recount_state").first();
    return { last_recount_at: row?.last_recount_at ?? null };
  },
});

/**
 * Manager-gated query returning the drift log for /mgr/stock drift tab
 * (v0.6, ADR-044, Task R8). Bounded at 100 rows ordered by detection time
 * desc (Convex default sort by _creationTime matches detected_at since rows
 * are inserted with detected_at = Date.now()).
 *
 * Default excludes resolved rows (the open-drift list the operator acts on).
 * `includeResolved: true` returns all 100 most-recent rows for audit/history.
 *
 * Drift resolution is bookkeeping (CLAUDE.md rule #22 — same logic as
 * `markRefundSettled` ADR-038): manager-session is sufficient; no PIN gate.
 *
 * `r.resolved_at == null` uses loose equality to match both `null` and
 * `undefined` per the v0.5.2 lesson — Convex optional-field filters at the
 * DB layer don't behave reliably for "absent", so the filter lives in JS.
 */
export const listStockDrift = query({
  args: {
    sessionId: v.id("staff_sessions"),
    includeResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Doc<"pos_stock_drift_log">[]> => {
    const { outlet_id } = await requireManagerSession(ctx, args.sessionId);
    // v2.0 Task 9B: scope drift log by outlet when available.
    // by_outlet_unresolved has fields [outlet_id, resolved_at]; we eq on outlet_id
    // alone to get all drift rows for that outlet, then filter resolved_at in JS
    // (Convex optional-field filter lesson — ADR-optional-field-gotcha).
    const rows = outlet_id
      ? await ctx.db
          .query("pos_stock_drift_log")
          .withIndex("by_outlet_unresolved", (q) => q.eq("outlet_id", outlet_id))
          .order("desc")
          .take(100)
      : await ctx.db.query("pos_stock_drift_log").order("desc").take(100);
    return args.includeResolved ? rows : rows.filter((r) => r.resolved_at == null);
  },
});

/**
 * Manager-gated mutation that resolves a drift row by delegating to R4's
 * `_resolveDrift_internal` (v0.6, ADR-044, Task R8).
 *
 * Manager-session, NOT manager-PIN (CLAUDE.md rule #22): drift resolution is
 * a bookkeeping ack of a physically-resolved discrepancy — it moves no money
 * and changes no identity. Same logic as `markRefundSettled` (ADR-038).
 *
 * ADR-013 (idempotency) + rule #20: `authCheck` runs `requireManagerSession`
 * BEFORE the cache lookup so a cached response can't be replayed against a
 * non-manager session. The handler RE-CALLS `requireManagerSession` to get
 * the typed `{ staffId, deviceId }` for the internal call — the duplication
 * is intentional (see docs/PATTERNS/idempotency-dual-call-authcheck.md).
 *
 * The internal mutation handles its own idempotency for double-resolve
 * (second call on already-resolved row is a no-op + skips audit), so the
 * audit-row count stays at 1 across replays of the same idempotencyKey.
 */
export const resolveDrift = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    driftId: v.id("pos_stock_drift_log"),
    note: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      driftId: Id<"pos_stock_drift_log">;
      note: string;
    },
    { ok: true }
  >(
    "inventory.resolveDrift",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(
        ctx,
        args.sessionId,
      );
      await ctx.runMutation(internal.inventory.internal._resolveDrift_internal, {
        driftId: args.driftId,
        resolved_by: mgrId,
        note: args.note,
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
