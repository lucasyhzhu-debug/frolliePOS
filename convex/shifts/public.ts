import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deriveBoothState, BoothState, resolveStaffName } from "./lib";
import { wibDayWindow } from "../lib/time";
import { withIdempotency } from "../idempotency/internal";
import { requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { stepValidator } from "./schema";

/**
 * Write-side booth-state guard (review C-2). Reads the latest shift event for
 * the device, derives the current booth state via the pure `deriveBoothState`
 * (NO duplicated state logic), and throws `errorCode` unless the booth is in the
 * required source state. Called AFTER `requireSession` (auth first) and inside
 * each lifecycle mutation's idempotency handler.
 *
 * Returns the derived state so callers (e.g. completeStartOfDay) can branch on
 * the stale-autoclose flag without a second read.
 *
 * Error strings (stable, documented in ADR-050):
 *   BOOTH_NOT_CLOSED · BOOTH_NOT_OPEN · BOOTH_NOT_LOCKED · NO_HANDOVER_PENDING
 */
async function assertBoothState(
  ctx: MutationCtx,
  deviceId: string,
  required: BoothState,
  errorCode: string,
): Promise<ReturnType<typeof deriveBoothState>> {
  const latest = await ctx.runQuery(
    internal.shifts.internal._latestShiftEvent_internal,
    { deviceId },
  );
  const { dayStartMs } = wibDayWindow(Date.now());
  const derived = deriveBoothState(latest, dayStartMs);
  if (derived.state !== required) throw new Error(errorCode);
  return derived;
}

// Shared args type used by handoverOut and completeHandoverIn.
type HandoverArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{
    key: string;
    label: string;
    type: "instruction" | "count";
    confirmed_at: number;
  }>;
  countChanged?: number;
};

export const boothState = query({
  args: { deviceId: v.string() },
  handler: async (
    ctx,
    { deviceId },
  ): Promise<{
    state: BoothState;
    staffId: Id<"staff"> | null;
    staffName: string | null;
    staleAutoclose: boolean;
  }> => {
    const latest = await ctx.runQuery(
      internal.shifts.internal._latestShiftEvent_internal,
      { deviceId },
    );
    const { dayStartMs } = wibDayWindow(Date.now());
    const derived = deriveBoothState(latest, dayStartMs);
    let staffName: string | null = null;
    if (derived.staffId) {
      const names = await ctx.runQuery(
        internal.auth.internal._listStaffNames_internal,
        {},
      );
      staffName = resolveStaffName(names, derived.staffId, "") || null;
    }
    return { ...derived, staffName };
  },
});

type CompleteStartOfDayArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{
    key: string;
    label: string;
    type: "instruction" | "count";
    confirmed_at: number;
  }>;
  countChanged?: number;
};

type CompleteStartOfDayResult = { ok: true; eventId: Id<"pos_shift_events"> };

/**
 * Record that the start-of-day SOP checklist was completed for this device.
 * Creates a `start_of_day` shift event, which transitions the booth to "open".
 *
 * ADR-013 (idempotency): wrapped with `withIdempotency`. `authCheck` runs
 * `requireSession` BEFORE cache lookup (rule #20). The handler RE-CALLS
 * `requireSession` to get the typed session object — duplication is intentional.
 *
 * `shift_started_at` is set to `Date.now()` inside the handler (ADR-031:
 * server time wins — never accept timestamps from the client).
 */
export const completeStartOfDay = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    countChanged: v.optional(v.number()),
  },
  handler: withIdempotency<CompleteStartOfDayArgs, CompleteStartOfDayResult>(
    "shifts.completeStartOfDay",
    async (ctx, args): Promise<CompleteStartOfDayResult> => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      // C-2 write-side guard: start-of-day is only valid from CLOSED.
      // `deriveBoothState` returns state:"closed" (with staleAutoclose:true) for a
      // non-closed event left over from a PRIOR WIB day, so the stale case PASSES
      // this guard and is handled below. A still-open SAME-DAY booth is rejected.
      const latest = await ctx.runQuery(
        internal.shifts.internal._latestShiftEvent_internal,
        { deviceId },
      );
      const { dayStartMs } = wibDayWindow(now);
      const derived = deriveBoothState(latest, dayStartMs);
      if (derived.state !== "closed") throw new Error("BOOTH_NOT_CLOSED");

      // Spec §2 stale-shift edge: a non-closed event from a PRIOR WIB day means a
      // shift was never closed. Auto-close the prior shift here (its summary still
      // fires to Founders) BEFORE opening today's shift, so a forgotten close does
      // not suppress the morning start-of-day record or silently drop the prior
      // shift's sales summary.
      if (derived.staleAutoclose && latest) {
        // Stale shift window: start = the displaced shift-start anchor; end = the
        // event's own shift_ended_at if it carried one (a `lock` left overnight
        // carries its lock time), else the WIB end-of-day of the stale day.
        const staleStart = latest.shift_started_at;
        const staleEnd =
          latest.shift_ended_at ??
          wibDayWindow(latest.shift_started_at).dayEndMs;

        // Build the prior shift's summary over its window (same flat shape as
        // endOfDaySignOff stores on the event).
        const summary = await ctx.runQuery(
          internal.shifts.internal._buildSignoffSummary_internal,
          { shiftStartMs: staleStart, endMs: staleEnd },
        );

        const staleEventId: Id<"pos_shift_events"> = await ctx.runMutation(
          internal.shifts.internal._recordShiftEvent_internal,
          {
            device_id: deviceId,
            type: "signoff_close",
            staff_id: latest.staff_id,
            shift_started_at: staleStart,
            shift_ended_at: staleEnd,
            steps: [],
            count_changed: null,
            takeover: null,
            outgoing_uncounted: null,
            stale_autoclose: true,
            linked_event_id: null,
            summary: {
              durationMs: summary.durationMs,
              totalSalesIdr: summary.totalSalesIdr,
              txnCount: summary.txnCount,
              manualBcaCount: summary.manualBcaCount,
              manualBcaTotalIdr: summary.manualBcaTotalIdr,
            },
          },
        );

        await logAudit(ctx, {
          actor_id: latest.staff_id,
          action: "shift.signoff",
          entity_type: "pos_shift_events",
          entity_id: staleEventId,
          source: "booth_inline",
          metadata: { stale_autoclose: true },
        });

        // Fire the DISPLACED staff's Founders summary (spec §2). Reuses the same
        // deferred action endOfDaySignOff/handoverOut use, so payload shape +
        // endedBy:"self" parity holds. Keyed on the stale event id for dedupe.
        await ctx.scheduler.runAfter(
          0,
          internal.shifts.actions._sendSignoffSummary,
          {
            eventId: staleEventId,
            staffId: latest.staff_id,
            shiftStartMs: staleStart,
            shiftEndMs: staleEnd,
            totalSalesIdr: summary.totalSalesIdr,
            txnCount: summary.txnCount,
            manualBcaCount: summary.manualBcaCount,
            manualBcaTotalIdr: summary.manualBcaTotalIdr,
            idempotencyKeySuffix: staleEventId,
          },
        );
      }

      const eventId: Id<"pos_shift_events"> = await ctx.runMutation(
        internal.shifts.internal._recordShiftEvent_internal,
        {
          device_id: deviceId,
          type: "start_of_day",
          staff_id: staffId,
          shift_started_at: now,
          shift_ended_at: null,
          steps: args.steps,
          count_changed: args.countChanged ?? null,
          takeover: null,
          outgoing_uncounted: null,
          stale_autoclose: null,
          linked_event_id: null,
          summary: null,
        },
      );
      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.start_of_day",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { count_changed: args.countChanged ?? null },
      });
      return { ok: true as const, eventId };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});

type EndOfDaySignOffArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{
    key: string;
    label: string;
    type: "instruction" | "count";
    confirmed_at: number;
  }>;
  countChanged?: number;
};

type EndOfDaySignOffResult = { ok: true; durationMs: number };

/**
 * Record that the end-of-day SOP checklist was completed. Creates a
 * `signoff_close` shift event (transitions booth to "closed"), builds the
 * shift summary (sales aggregate + manual-BCA totals), ends the session, and
 * emits an audit log row.
 *
 * Session end: raw patch of `{ ended_at, end_reason }` is the correct path —
 * `requireSession` gates on `ended_at != null`, and no additional index fields
 * need to be cleared. Confirmed by inspecting `convex/auth/sessions.ts`.
 *
 * Telegram founders summary (Task 9 wires this): add
 * `ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {...})`
 * after the audit call. Deferred so this task's test remains Telegram-free.
 *
 * ADR-013 (idempotency): authCheck runs `requireSession` BEFORE cache lookup
 * (rule #20). Handler RE-CALLS `requireSession` — intentional dual-call.
 */
export const endOfDaySignOff = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    countChanged: v.optional(v.number()),
  },
  handler: withIdempotency<EndOfDaySignOffArgs, EndOfDaySignOffResult>(
    "shifts.endOfDaySignOff",
    async (ctx, args): Promise<EndOfDaySignOffResult> => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      // C-2 write-side guard: sign-off is only valid from an OPEN booth.
      await assertBoothState(ctx, deviceId, "open", "BOOTH_NOT_OPEN");

      // Resolve shift start anchor to compute duration + sales window.
      const anchor = await ctx.runQuery(
        internal.shifts.internal._shiftStartAnchor_internal,
        { deviceId },
      );
      const shiftStartMs = anchor?.shift_started_at ?? now;

      // Build the shift summary (sales aggregate + manual-BCA totals).
      const summary = await ctx.runQuery(
        internal.shifts.internal._buildSignoffSummary_internal,
        { shiftStartMs, endMs: now },
      );

      // Record the signoff_close shift event (transitions booth → "closed").
      const eventId: Id<"pos_shift_events"> = await ctx.runMutation(
        internal.shifts.internal._recordShiftEvent_internal,
        {
          device_id: deviceId,
          type: "signoff_close",
          staff_id: staffId,
          shift_started_at: shiftStartMs,
          shift_ended_at: now,
          steps: args.steps,
          count_changed: args.countChanged ?? null,
          takeover: null,
          outgoing_uncounted: null,
          stale_autoclose: null,
          linked_event_id: null,
          summary: {
            durationMs: summary.durationMs,
            totalSalesIdr: summary.totalSalesIdr,
            txnCount: summary.txnCount,
            manualBcaCount: summary.manualBcaCount,
            manualBcaTotalIdr: summary.manualBcaTotalIdr,
          },
        },
      );

      // End the session (ADR-003). Routed through auth._endShiftSession_internal
      // (ADR-034: staff_sessions is owned by auth; shifts must not patch it
      // directly). `end_reason: "force_logout"` is PLAN-mandated for signoff.
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId,
        endReason: "force_logout",
      });

      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.signoff",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { durationMs: summary.durationMs },
      });

      // Schedule deferred Telegram signoff summary → founders (v1.2 #6).
      await ctx.scheduler.runAfter(
        0,
        internal.shifts.actions._sendSignoffSummary,
        {
          eventId,
          staffId,
          shiftStartMs,
          shiftEndMs: now,
          totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount,
          manualBcaCount: summary.manualBcaCount,
          manualBcaTotalIdr: summary.manualBcaTotalIdr,
          idempotencyKeySuffix: eventId,
        },
      );

      return { ok: true as const, durationMs: summary.durationMs };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});

type HandoverOutResult = { ok: true; durationMs: number };

/**
 * Record that the outgoing staff has completed the handover-out SOP checklist.
 * Creates a `handover_out` shift event (transitions booth to "handover_pending"),
 * builds the shift summary, and ends the outgoing session.
 *
 * Task 9 wires Telegram notification for the outgoing summary. Deferred so
 * this task's test remains Telegram-free.
 *
 * ADR-013 (idempotency): authCheck runs `requireSession` BEFORE cache lookup
 * (rule #20). Handler RE-CALLS `requireSession` — intentional dual-call.
 */
export const handoverOut = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    countChanged: v.optional(v.number()),
  },
  handler: withIdempotency<HandoverArgs, HandoverOutResult>(
    "shifts.handoverOut",
    async (ctx, args): Promise<HandoverOutResult> => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      // C-2 write-side guard: handover-out is only valid from an OPEN booth.
      await assertBoothState(ctx, deviceId, "open", "BOOTH_NOT_OPEN");

      // Resolve shift start anchor to compute duration + sales window.
      const anchor = await ctx.runQuery(
        internal.shifts.internal._shiftStartAnchor_internal,
        { deviceId },
      );
      const shiftStartMs = anchor?.shift_started_at ?? now;

      // Build the shift summary (sales aggregate + manual-BCA totals).
      const summary = await ctx.runQuery(
        internal.shifts.internal._buildSignoffSummary_internal,
        { shiftStartMs, endMs: now },
      );

      // Record the handover_out shift event (transitions booth → "handover_pending").
      const eventId: Id<"pos_shift_events"> = await ctx.runMutation(
        internal.shifts.internal._recordShiftEvent_internal,
        {
          device_id: deviceId,
          type: "handover_out",
          staff_id: staffId,
          shift_started_at: shiftStartMs,
          shift_ended_at: now,
          steps: args.steps,
          count_changed: args.countChanged ?? null,
          takeover: null,
          outgoing_uncounted: null,
          stale_autoclose: null,
          linked_event_id: null,
          summary: {
            durationMs: summary.durationMs,
            totalSalesIdr: summary.totalSalesIdr,
            txnCount: summary.txnCount,
            manualBcaCount: summary.manualBcaCount,
            manualBcaTotalIdr: summary.manualBcaTotalIdr,
          },
        },
      );

      // End the outgoing session (ADR-003). Routed through auth (ADR-034).
      // `end_reason: "force_logout"` is PLAN-mandated for handover-out.
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId,
        endReason: "force_logout",
      });

      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.handover_out",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { durationMs: summary.durationMs },
      });

      // Schedule deferred Telegram signoff summary → founders (v1.2 #6).
      await ctx.scheduler.runAfter(
        0,
        internal.shifts.actions._sendSignoffSummary,
        {
          eventId,
          staffId,
          shiftStartMs,
          shiftEndMs: now,
          totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount,
          manualBcaCount: summary.manualBcaCount,
          manualBcaTotalIdr: summary.manualBcaTotalIdr,
          idempotencyKeySuffix: eventId,
        },
      );

      return { ok: true as const, durationMs: summary.durationMs };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});

type LockShiftArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
};

type LockShiftResult = { ok: true };

/**
 * Lock the booth (e.g. staff steps away). Records a `lock` shift event so the
 * booth transitions to "locked", and ends the current session with
 * `end_reason: "manual_lock"` (ADR-003). The `shift_started_at` from the anchor
 * is preserved on the event so accumulated shift hours survive the lock.
 *
 * The incoming staff must call `loginWithPin` (fresh session) and then
 * `recordResume` to re-open the booth.
 *
 * ADR-013 (idempotency): authCheck runs `requireSession` BEFORE cache lookup
 * (rule #20). Handler RE-CALLS `requireSession` — intentional dual-call.
 */
export const lockShift = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
  },
  handler: withIdempotency<LockShiftArgs, LockShiftResult>(
    "shifts.lockShift",
    async (ctx, args): Promise<LockShiftResult> => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      // C-2 write-side guard: lock is only valid from an OPEN booth.
      await assertBoothState(ctx, deviceId, "open", "BOOTH_NOT_OPEN");

      // Preserve the original shift start so accumulated hours survive the lock.
      const anchor = await ctx.runQuery(
        internal.shifts.internal._shiftStartAnchor_internal,
        { deviceId },
      );
      const shiftStartMs = anchor?.shift_started_at ?? now;

      const eventId: Id<"pos_shift_events"> = await ctx.runMutation(
        internal.shifts.internal._recordShiftEvent_internal,
        {
          device_id: deviceId,
          type: "lock",
          staff_id: staffId,
          shift_started_at: shiftStartMs,
          shift_ended_at: now,
          steps: [],
          count_changed: null,
          takeover: null,
          outgoing_uncounted: null,
          stale_autoclose: null,
          linked_event_id: null,
          summary: null,
        },
      );

      // End the session (ADR-003). Lock still ends the session; "locked" is a
      // booth-state layer derived from the shift event, not the session. Routed
      // through auth (ADR-034). `end_reason: "manual_lock"` is PLAN-mandated.
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId,
        endReason: "manual_lock",
      });

      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.lock",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { shift_started_at: shiftStartMs },
      });

      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});

type RecordResumeArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
};

type RecordResumeResult = { ok: true };

/**
 * Record that the same staff has resumed the shift after a lock. Called after a
 * fresh `loginWithPin` (the new session is passed as `sessionId`). Creates a
 * `resume` shift event (transitions booth to "open") and preserves the original
 * `shift_started_at` from the anchor so accumulated shift hours are not reset.
 *
 * `_shiftStartAnchor_internal` walks back past the `lock` event to the original
 * start_of_day / handover_in / manager_takeover, so the original start is
 * correctly recovered even after one or more lock/resume cycles.
 *
 * The session is NOT ended here (the staff is resuming work).
 *
 * ADR-013 (idempotency): authCheck runs `requireSession` BEFORE cache lookup
 * (rule #20). Handler RE-CALLS `requireSession` — intentional dual-call.
 */
export const recordResume = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
  },
  handler: withIdempotency<RecordResumeArgs, RecordResumeResult>(
    "shifts.recordResume",
    async (ctx, args): Promise<RecordResumeResult> => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      // C-2 write-side guard: resume is only valid from a LOCKED booth.
      await assertBoothState(ctx, deviceId, "locked", "BOOTH_NOT_LOCKED");

      // Recover the original shift start — _shiftStartAnchor_internal skips
      // `lock` events and returns the most recent start_of_day / handover_in /
      // manager_takeover, so hours accumulated before the lock are preserved.
      const anchor = await ctx.runQuery(
        internal.shifts.internal._shiftStartAnchor_internal,
        { deviceId },
      );
      const shiftStartMs = anchor?.shift_started_at ?? now;

      const eventId: Id<"pos_shift_events"> = await ctx.runMutation(
        internal.shifts.internal._recordShiftEvent_internal,
        {
          device_id: deviceId,
          type: "resume",
          staff_id: staffId,
          shift_started_at: shiftStartMs,
          shift_ended_at: null,
          steps: [],
          count_changed: null,
          takeover: null,
          outgoing_uncounted: null,
          stale_autoclose: null,
          linked_event_id: null,
          summary: null,
        },
      );

      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.resume",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { shift_started_at: shiftStartMs },
      });

      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});

type CompleteHandoverInResult = { ok: true; eventId: Id<"pos_shift_events"> };

/**
 * Record that the incoming staff has completed the handover-in SOP checklist.
 * The incoming staff MUST already have a fresh session (from `loginWithPin`).
 * Creates a `handover_in` shift event (transitions booth to "open" for the new
 * staff), with `shift_started_at = now` marking the start of the new shift.
 * Links to the pending `handover_out` event via `linked_event_id` if the latest
 * event is a `handover_out` (else null).
 *
 * The incoming session is NOT ended here.
 *
 * ADR-013 (idempotency): authCheck runs `requireSession` BEFORE cache lookup
 * (rule #20). Handler RE-CALLS `requireSession` — intentional dual-call.
 */
export const completeHandoverIn = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    countChanged: v.optional(v.number()),
  },
  handler: withIdempotency<HandoverArgs, CompleteHandoverInResult>(
    "shifts.completeHandoverIn",
    async (ctx, args): Promise<CompleteHandoverInResult> => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      // Fetch the latest shift event to link to the pending handover_out.
      const pending = await ctx.runQuery(
        internal.shifts.internal._latestShiftEvent_internal,
        { deviceId },
      );

      // C-2 write-side guard: handover-in is only valid from a HANDOVER_PENDING
      // booth. Derived from the SAME `pending` read (no second query) via the pure
      // deriveBoothState — upgrades the old soft `linked_event_id` fallback to a
      // hard state assertion. A stale prior-day handover_out derives to "closed",
      // so it is correctly rejected here.
      const { dayStartMs } = wibDayWindow(now);
      if (deriveBoothState(pending, dayStartMs).state !== "handover_pending") {
        throw new Error("NO_HANDOVER_PENDING");
      }

      // Extract once: evaluated twice (linked_event_id + audit metadata).
      const linkedEventId = pending?.type === "handover_out" ? pending._id : null;

      // Record the handover_in shift event (transitions booth → "open").
      // shift_started_at = now: marks the beginning of the new staff's shift.
      const eventId: Id<"pos_shift_events"> = await ctx.runMutation(
        internal.shifts.internal._recordShiftEvent_internal,
        {
          device_id: deviceId,
          type: "handover_in",
          staff_id: staffId,
          shift_started_at: now,
          shift_ended_at: null,
          steps: args.steps,
          count_changed: args.countChanged ?? null,
          takeover: null,
          outgoing_uncounted: null,
          stale_autoclose: null,
          linked_event_id: linkedEventId,
          summary: null,
        },
      );

      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.handover_in",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { linked_event_id: linkedEventId },
      });

      return { ok: true as const, eventId };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});
