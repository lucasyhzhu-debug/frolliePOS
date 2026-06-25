import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { stepValidator } from "./schema";

type HandoverArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{ key: string; label: string; type: "instruction" | "count"; confirmed_at: number }>;
  closeCount?: number;
};
type HandoverResult = { ok: true; durationMs: number };

type OpenBoothArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{ key: string; label: string; type: "instruction" | "count"; confirmed_at: number }>;
  openCount?: number;
};
type OpenBoothResult = { ok: true; shiftId: Id<"pos_shifts"> };

export const openBooth = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    openCount: v.optional(v.number()),
  },
  handler: withIdempotency<OpenBoothArgs, OpenBoothResult>(
    "shifts.openBooth",
    async (ctx, args): Promise<OpenBoothResult> => {
      const { staffId, deviceId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);

      // Level-1 guard: start-of-day is only valid from a CLOSED outlet.
      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (status.is_open) throw new Error("BOOTH_ALREADY_OPEN");

      await ctx.runMutation(internal.outlets.status._setOutletOpen_internal, {
        outletId, staffId, via: "sop",
      });
      const shiftId: Id<"pos_shifts"> = await ctx.runMutation(
        internal.shifts.shiftsInternal._startShift_internal,
        {
          outletId, deviceId, staffId, startedVia: "sop",
          openCount: args.openCount ?? null, steps: args.steps, prevShiftId: null,
        },
      );
      await logAudit(ctx, {
        actor_id: staffId, action: "outlet.opened", entity_type: "outlets",
        entity_id: outletId, source: "booth_inline",
        metadata: { via: "sop", shift_id: shiftId, open_count: args.openCount ?? null },
      });
      return { ok: true as const, shiftId };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});

export const handover = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    closeCount: v.optional(v.number()),
  },
  handler: withIdempotency<HandoverArgs, HandoverResult>(
    "shifts.handover",
    async (ctx, args): Promise<HandoverResult> => {
      const { staffId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      if (!holder) throw new Error("NO_ACTIVE_SHIFT");
      if (holder.staff_id !== staffId) throw new Error("NOT_SHIFT_HOLDER");

      const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
        shiftStartMs: holder.started_at, endMs: now, outletId,
      });
      await ctx.runMutation(internal.shifts.shiftsInternal._endShift_internal, {
        shiftId: holder._id, endedVia: "handover", closeCount: args.closeCount ?? null,
        steps: args.steps, outgoingUncounted: null,
        summary: {
          durationMs: summary.durationMs, totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount, manualBcaCount: summary.manualBcaCount,
          manualBcaTotalIdr: summary.manualBcaTotalIdr,
        },
      });
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId, endReason: "force_logout",
      });
      await logAudit(ctx, {
        actor_id: staffId, action: "shift.handover", entity_type: "pos_shifts",
        entity_id: holder._id, source: "booth_inline",
        metadata: { durationMs: summary.durationMs },
      });
      await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
        eventId: holder._id, staffId, shiftStartMs: holder.started_at, shiftEndMs: now,
        totalSalesIdr: summary.totalSalesIdr, txnCount: summary.txnCount,
        manualBcaCount: summary.manualBcaCount, manualBcaTotalIdr: summary.manualBcaTotalIdr,
        idempotencyKeySuffix: holder._id, outletId,
      });
      return { ok: true as const, durationMs: summary.durationMs };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});

export const startShift = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    openCount: v.optional(v.number()),
  },
  handler: withIdempotency<OpenBoothArgs, OpenBoothResult>(
    "shifts.startShift",
    async (ctx, args): Promise<OpenBoothResult> => {
      const { staffId, deviceId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);

      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (!status.is_open) throw new Error("BOOTH_NOT_OPEN");

      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      if (holder) throw new Error("SHIFT_IN_PROGRESS");

      const prev = await ctx.runQuery(internal.shifts.shiftsInternal._lastEndedShift_internal, { outletId });
      const shiftId: Id<"pos_shifts"> = await ctx.runMutation(
        internal.shifts.shiftsInternal._startShift_internal,
        {
          outletId, deviceId, staffId, startedVia: "handover",
          openCount: args.openCount ?? null, steps: args.steps,
          prevShiftId: prev?._id ?? null,
        },
      );
      await logAudit(ctx, {
        actor_id: staffId, action: "shift.start", entity_type: "pos_shifts",
        entity_id: shiftId, source: "booth_inline",
        metadata: { started_via: "handover", prev_shift_id: prev?._id ?? null },
      });
      return { ok: true as const, shiftId };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});

export const endOfDay = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    closeCount: v.optional(v.number()),
  },
  handler: withIdempotency<HandoverArgs, HandoverResult>(
    "shifts.endOfDay",
    async (ctx, args): Promise<HandoverResult> => {
      const { staffId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (!status.is_open) {
        // Idempotent close — end the session, no duplicate close.
        await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
          sessionId: args.sessionId, endReason: "force_logout",
        });
        return { ok: true as const, durationMs: 0 };
      }

      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      const shiftStartMs = holder?.started_at ?? now;
      const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
        shiftStartMs, endMs: now, outletId,
      });
      if (holder) {
        await ctx.runMutation(internal.shifts.shiftsInternal._endShift_internal, {
          shiftId: holder._id, endedVia: "end_of_day", closeCount: args.closeCount ?? null,
          steps: args.steps, outgoingUncounted: null,
          summary: {
            durationMs: summary.durationMs, totalSalesIdr: summary.totalSalesIdr,
            txnCount: summary.txnCount, manualBcaCount: summary.manualBcaCount,
            manualBcaTotalIdr: summary.manualBcaTotalIdr,
          },
        });
      }
      await ctx.runMutation(internal.outlets.status._setOutletClosed_internal, { outletId, staffId });
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId, endReason: "force_logout",
      });
      await logAudit(ctx, {
        actor_id: staffId, action: "outlet.closed", entity_type: "outlets",
        entity_id: outletId, source: "booth_inline",
        metadata: { durationMs: summary.durationMs, shift_id: holder?._id ?? null },
      });
      if (holder) {
        await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
          eventId: holder._id, staffId, shiftStartMs, shiftEndMs: now,
          totalSalesIdr: summary.totalSalesIdr, txnCount: summary.txnCount,
          manualBcaCount: summary.manualBcaCount, manualBcaTotalIdr: summary.manualBcaTotalIdr,
          idempotencyKeySuffix: holder._id, outletId,
        });
      }
      return { ok: true as const, durationMs: summary.durationMs };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
