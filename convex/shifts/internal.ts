import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { stepValidator } from "./schema";
import { wibDayWindow } from "../lib/time";

const shiftEventFields = {
  device_id: v.string(),
  type: v.union(
    v.literal("start_of_day"),
    v.literal("lock"),
    v.literal("resume"),
    v.literal("signoff_close"),
    v.literal("handover_out"),
    v.literal("handover_in"),
    v.literal("manager_takeover"),
  ),
  staff_id: v.id("staff"),
  shift_started_at: v.number(),
  shift_ended_at: v.union(v.number(), v.null()),
  steps: v.array(stepValidator),
  count_changed: v.union(v.number(), v.null()),
  takeover: v.union(v.boolean(), v.null()),
  outgoing_uncounted: v.union(v.boolean(), v.null()),
  stale_autoclose: v.union(v.boolean(), v.null()),
  linked_event_id: v.union(v.id("pos_shift_events"), v.null()),
  summary: v.union(
    v.object({
      durationMs: v.number(),
      totalSalesIdr: v.number(),
      txnCount: v.number(),
      manualBcaCount: v.number(),
      manualBcaTotalIdr: v.number(),
    }),
    v.null(),
  ),
};

// _latestShiftEvent_internal deleted (ADR-053): only shifts.public callers consumed it; that
// file is now deleted. pos_shift_events is kept read-only for legacy audit history.

export const _recordShiftEvent_internal = internalMutation({
  args: { ...shiftEventFields, outletId: v.id("outlets") },
  handler: async (ctx, args) => {
    const { outletId, ...fields } = args;
    return ctx.db.insert("pos_shift_events", {
      ...fields,
      created_at: Date.now(),
      outlet_id: outletId,  // v2.0 Task 12 (ENFORCE): always stamped
    });
  },
});

export const _shiftStartAnchor_internal = internalQuery({
  args: { deviceId: v.string(), outletId: v.id("outlets") },
  handler: async (
    ctx,
    { deviceId, outletId },
  ): Promise<{ shift_started_at: number; staff_id: Id<"staff"> } | null> => {
    // C4: bound the scan to TODAY's WIB window instead of an arbitrary .take(50)
    // ceiling (a busy day could push the anchor past 50 rows → silent miss →
    // ?? now → 0-duration/0-sales summary). Stale prior-day shifts are now
    // auto-closed by completeStartOfDay, so the current shift's anchor always
    // lives within today's WIB day; a day's event count is small enough to
    // collect in full. Walk back to the most recent shift-START event.
    const { dayStartMs } = wibDayWindow(Date.now());
    // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outletId may be undefined).
    const today = await ctx.db
      .query("pos_shift_events")
      .withIndex("by_outlet_device_created", (q) =>
        q.eq("outlet_id", outletId).eq("device_id", deviceId).gte("created_at", dayStartMs),
      )
      .order("desc")
      .collect();
    const anchor = today.find(
      (e) =>
        e.type === "start_of_day" ||
        e.type === "handover_in" ||
        e.type === "manager_takeover",
    );
    // null is acceptable: with stale shifts auto-closed, a genuinely anchorless
    // booth is the only remaining null case (unreachable in normal flow). The
    // caller's `?? now` then applies only to that edge.
    return anchor
      ? { shift_started_at: anchor.shift_started_at, staff_id: anchor.staff_id }
      : null;
  },
});

/**
 * Aggregate sales + manual-BCA stats for the end-of-day sign-off summary.
 *
 * Consumes:
 *   - transactions._dailySalesSummary_internal → { totalSalesIdr, txnCount, flaggedCount }
 *   - transactions._manualBcaReconciliation_internal → { items, count, totalIdr }
 *
 * Returns a flat object stored on the pos_shift_events.summary field. The
 * `flaggedCount` from _dailySalesSummary_internal is intentionally NOT stored
 * in the summary field (the schema doesn't include it); it's available from
 * the audit log if needed. `manualBca.items` is also dropped — the per-item
 * detail is already available via the transactions query; only count + totalIdr
 * are summary-level aggregates.
 */
export const _buildSignoffSummary_internal = internalQuery({
  args: {
    shiftStartMs: v.number(),
    endMs: v.number(),
    outletId: v.id("outlets"),
  },
  handler: async (
    ctx,
    { shiftStartMs, endMs, outletId },
  ): Promise<{
    durationMs: number;
    totalSalesIdr: number;
    txnCount: number;
    manualBcaCount: number;
    manualBcaTotalIdr: number;
  }> => {
    // v2.0 Stream 5: pass outletId so the aggregates are outlet-scoped.
    const [sales, manualBca] = await Promise.all([
      ctx.runQuery(
        internal.transactions.internal._dailySalesSummary_internal,
        { dayStartMs: shiftStartMs, dayEndMs: endMs, outletId },
      ),
      ctx.runQuery(
        internal.transactions.internal._manualBcaReconciliation_internal,
        { dayStartMs: shiftStartMs, dayEndMs: endMs, outletId },
      ),
    ]);
    return {
      durationMs: Math.max(0, endMs - shiftStartMs),
      totalSalesIdr: sales.totalSalesIdr,
      txnCount: sales.txnCount,
      manualBcaCount: manualBca.count,
      manualBcaTotalIdr: manualBca.totalIdr,
    };
  },
});

// _commitManagerTakeover_internal deleted (ADR-053): superseded by managerOverride
// in shiftsInternal.ts, which force-ends a stranded pos_shifts row without creating
// a new session (the original staffer re-authenticates via standard login).
