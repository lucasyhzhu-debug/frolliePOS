import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { deriveBoothState, BoothState } from "./lib";
import { wibDayWindow } from "../lib/time";
import { withIdempotency } from "../idempotency/internal";
import { requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { stepValidator } from "./schema";

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
      staffName =
        names.find((s: { _id: Id<"staff">; name: string }) => String(s._id) === String(derived.staffId))?.name ??
        null;
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

      // Resolve shift start anchor to compute duration + sales window.
      const anchor = await ctx.runQuery(
        internal.shifts.internal._shiftStartAnchor_internal,
        { deviceId },
      );
      const shiftStartMs = anchor?.shift_started_at ?? now;

      // Build the shift summary (sales aggregate + manual-BCA totals).
      const summary = await ctx.runQuery(
        internal.shifts.internal._buildSignoffSummary_internal,
        { deviceId, shiftStartMs, endMs: now },
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

      // End the session (ADR-003). `requireSession` gates on `ended_at != null`;
      // no additional index fields to clear. `end_reason` is a closed union —
      // "force_logout" is the closest available literal for a signoff-initiated
      // end; the intent is recorded on the pos_shift_events row.
      await ctx.db.patch(args.sessionId, {
        ended_at: now,
        end_reason: "force_logout",
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

      // Resolve shift start anchor to compute duration + sales window.
      const anchor = await ctx.runQuery(
        internal.shifts.internal._shiftStartAnchor_internal,
        { deviceId },
      );
      const shiftStartMs = anchor?.shift_started_at ?? now;

      // Build the shift summary (sales aggregate + manual-BCA totals).
      const summary = await ctx.runQuery(
        internal.shifts.internal._buildSignoffSummary_internal,
        { deviceId, shiftStartMs, endMs: now },
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

      // End the outgoing session (ADR-003).
      await ctx.db.patch(args.sessionId, {
        ended_at: now,
        end_reason: "force_logout",
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
      // booth-state layer derived from the shift event, not the session.
      await ctx.db.patch(args.sessionId, {
        ended_at: now,
        end_reason: "manual_lock",
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

      // Fetch the latest shift event to link to the pending handover_out (if any).
      const pending = await ctx.runQuery(
        internal.shifts.internal._latestShiftEvent_internal,
        { deviceId },
      );

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
          linked_event_id:
            pending?.type === "handover_out" ? pending._id : null,
          summary: null,
        },
      );

      await logAudit(ctx, {
        actor_id: staffId,
        action: "shift.handover_in",
        entity_type: "pos_shift_events",
        entity_id: eventId,
        source: "booth_inline",
        metadata: { linked_event_id: pending?.type === "handover_out" ? pending._id : null },
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
