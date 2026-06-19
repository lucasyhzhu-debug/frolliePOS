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

      // Task 9 adds:
      // await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
      //   eventId, staffId, summary,
      // });

      return { ok: true as const, durationMs: summary.durationMs };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});
