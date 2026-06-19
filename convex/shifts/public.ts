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
