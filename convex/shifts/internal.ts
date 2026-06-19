import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { stepValidator } from "./schema";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";
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

export const _latestShiftEvent_internal = internalQuery({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) =>
    ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) => q.eq("device_id", deviceId))
      .order("desc")
      .first(),
});

export const _recordShiftEvent_internal = internalMutation({
  args: shiftEventFields,
  handler: async (ctx, args) =>
    ctx.db.insert("pos_shift_events", { ...args, created_at: Date.now() }),
});

export const _shiftStartAnchor_internal = internalQuery({
  args: { deviceId: v.string() },
  handler: async (
    ctx,
    { deviceId },
  ): Promise<{ shift_started_at: number; staff_id: Id<"staff"> } | null> => {
    // C4: bound the scan to TODAY's WIB window instead of an arbitrary .take(50)
    // ceiling (a busy day could push the anchor past 50 rows → silent miss →
    // ?? now → 0-duration/0-sales summary). Stale prior-day shifts are now
    // auto-closed by completeStartOfDay, so the current shift's anchor always
    // lives within today's WIB day; a day's event count is small enough to
    // collect in full. Walk back to the most recent shift-START event.
    const { dayStartMs } = wibDayWindow(Date.now());
    const today = await ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) =>
        q.eq("device_id", deviceId).gte("created_at", dayStartMs),
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
  },
  handler: async (
    ctx,
    { shiftStartMs, endMs },
  ): Promise<{
    durationMs: number;
    totalSalesIdr: number;
    txnCount: number;
    manualBcaCount: number;
    manualBcaTotalIdr: number;
  }> => {
    const [sales, manualBca] = await Promise.all([
      ctx.runQuery(
        internal.transactions.internal._dailySalesSummary_internal,
        { dayStartMs: shiftStartMs, dayEndMs: endMs },
      ),
      ctx.runQuery(
        internal.transactions.internal._manualBcaReconciliation_internal,
        { dayStartMs: shiftStartMs, dayEndMs: endMs },
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

/**
 * Atomic commit for `managerTakeover`:
 *   1. Force-end ALL active `staff_sessions` for the device (`by_device_active`
 *      index, `ended_at = null`). The displaced staff session(s) become
 *      `force_logout`. There may be zero (booth was already locked/idle).
 *   2. Create a new `staff_sessions` row for the manager.
 *   3. Record a `manager_takeover` shift event:
 *        - `takeover: true`, `outgoing_uncounted: true` (displaced staff's count
 *          was never handed over — Task 9 defers the Founders summary).
 *        - `shift_started_at = now` (fresh shift for the manager).
 *   4. Emit audit `shift.manager_takeover` (actor = manager).
 *
 * Wrapped with `withIdempotency` so a crash between the action's commit call and
 * the action-level cache write does not double-commit (mirrors staff/internal.ts
 * _setStaffRoleCommit_internal pattern).
 *
 * Task 9 placeholder: wire
 *   `ctx.scheduler.runAfter(0, internal.shifts.actions._sendTakeoverSummary, {...})`
 * here after the audit call to dispatch the displaced-staff Founders summary.
 *
 * Returns `{ sessionId, eventId }`.
 */
export const _commitManagerTakeover_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    deviceId: v.string(),
    managerStaffId: v.id("staff"),
  },
  handler: withIdempotency<
    { idempotencyKey: string; deviceId: string; managerStaffId: Id<"staff"> },
    { sessionId: Id<"staff_sessions">; eventId: Id<"pos_shift_events"> }
  >(
    "shifts.managerTakeover",
    async (ctx, args) => {
      const now = Date.now();

      // Step 0 (MUST come first): Read the lock event BEFORE any writes so the
      // displaced-staff window is captured from the correct event. After the
      // manager_takeover insert (Step 3) the same query would find that new event
      // (shift_started_at = now) and produce a [now, now] window with 0 sales.
      //
      // The latest event at this point MUST be the `lock` that preceded the
      // takeover flow. It carries:
      //   lock.shift_started_at  = displaced staff's ORIGINAL shift start
      //   lock.shift_ended_at    = the moment the booth was locked
      const latestBeforeTakeover = await ctx.db
        .query("pos_shift_events")
        .withIndex("by_device_created", (q) => q.eq("device_id", args.deviceId))
        .order("desc")
        .first();

      // Defensive fallback: if the latest event is not a `lock` (unexpected —
      // takeover should only come from locked), fall back to whatever anchor we
      // have so duration may be wrong but we never produce a [now,now] silent zero.
      const displacedShiftStartMs =
        latestBeforeTakeover?.type === "lock"
          ? latestBeforeTakeover.shift_started_at
          : (latestBeforeTakeover?.shift_started_at ?? now);
      const displacedShiftEndMs =
        latestBeforeTakeover?.type === "lock"
          ? (latestBeforeTakeover.shift_ended_at ?? latestBeforeTakeover.created_at ?? now)
          : now;

      // Steps 1 + 2: Force-end active sessions and create the manager session.
      // Routed through auth._managerTakeoverSession_internal (ADR-034: staff_sessions
      // is owned by auth; shifts must not access it directly).
      // Explicit type annotation breaks the Convex inference cycle (TS7022/7024).
      const takeoverSession: {
        sessionId: Id<"staff_sessions">;
        displacedStaffId: Id<"staff"> | null;
      } = await ctx.runMutation(
        internal.auth.internal._managerTakeoverSession_internal,
        { deviceId: args.deviceId, managerStaffId: args.managerStaffId },
      );
      const { sessionId, displacedStaffId } = takeoverSession;

      // Step 3: Record manager_takeover shift event.
      // shift_started_at = now (fresh shift for the manager).
      // outgoing_uncounted: true — the displaced staff's count was never handed
      // over; Task 9 dispatches the deferred Founders summary.
      const eventId: Id<"pos_shift_events"> = await ctx.db.insert(
        "pos_shift_events",
        {
          device_id: args.deviceId,
          type: "manager_takeover",
          staff_id: args.managerStaffId,
          shift_started_at: now,
          shift_ended_at: null,
          steps: [],
          count_changed: null,
          takeover: true,
          outgoing_uncounted: true,
          stale_autoclose: null,
          linked_event_id: null,
          summary: null,
          created_at: now,
        },
      );

      // Step 4: Audit.
      await logAudit(ctx, {
        actor_id: args.managerStaffId,
        action: "shift.manager_takeover",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        device_id: args.deviceId,
        metadata: { outgoing_uncounted: true },
      });

      // Schedule deferred Founders summary for the displaced staff (v1.2 #6).
      await ctx.scheduler.runAfter(
        0,
        internal.shifts.actions._sendTakeoverSummary,
        {
          eventId,
          displacedStaffId,
          deviceId: args.deviceId,
          displacedShiftStartMs,
          displacedShiftEndMs,
          idempotencyKeySuffix: eventId,
        },
      );

      return { sessionId, eventId };
    },
    { staffIdFromArgs: (a) => a.managerStaffId },
  ),
});
