import { ConvexError, v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { stepValidator } from "./schema";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { internal } from "../_generated/api";

const summaryValidator = v.object({
  durationMs: v.number(),
  totalSalesIdr: v.number(),
  txnCount: v.number(),
  manualBcaCount: v.number(),
  manualBcaTotalIdr: v.number(),
});

export const _getActiveShift_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<Doc<"pos_shifts"> | null> => {
    return await ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_active", (q) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .unique();
  },
});

export const _startShift_internal = internalMutation({
  args: {
    outletId: v.id("outlets"),
    deviceId: v.string(),
    staffId: v.id("staff"),
    startedVia: v.union(v.literal("sop"), v.literal("manager_skip"), v.literal("handover")),
    openCount: v.union(v.number(), v.null()),
    steps: v.array(stepValidator),
    prevShiftId: v.union(v.id("pos_shifts"), v.null()),
  },
  handler: async (ctx, args): Promise<Id<"pos_shifts">> => {
    const now = Date.now();
    return await ctx.db.insert("pos_shifts", {
      outlet_id: args.outletId,
      device_id: args.deviceId,
      staff_id: args.staffId,
      started_at: now,
      started_via: args.startedVia,
      ended_at: null,
      ended_via: null,
      open_count: args.openCount,
      close_count: null,
      outgoing_uncounted: null,
      steps: args.steps,
      summary: null,
      prev_shift_id: args.prevShiftId,
      created_at: now,
    });
  },
});

export const _endShift_internal = internalMutation({
  args: {
    shiftId: v.id("pos_shifts"),
    endedVia: v.union(v.literal("handover"), v.literal("end_of_day"), v.literal("manager_override")),
    closeCount: v.union(v.number(), v.null()),
    steps: v.array(stepValidator),
    outgoingUncounted: v.union(v.boolean(), v.null()),
    summary: v.union(summaryValidator, v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.shiftId, {
      ended_at: Date.now(),
      ended_via: args.endedVia,
      close_count: args.closeCount,
      steps: args.steps.length ? args.steps : (await ctx.db.get(args.shiftId))!.steps,
      outgoing_uncounted: args.outgoingUncounted,
      summary: args.summary,
    });
    return null;
  },
});

// ─── _managerSkipOpenCommit_internal ─────────────────────────────────────────
//
// Atomic commit for managerSkipOpen: sets outlet open (via:"manager_skip"),
// starts a manager_skip shift, emits audit. Wrapped with withIdempotency so a
// crash between action commit and action-level cache write is handled safely.
//
// Note: internal mutations wrapped with withIdempotency do NOT take an authCheck
// (rule #20 applies to public mutations; the action's withActionCache authCheck
// already gated entry). Mirror _managerOverrideCommit_internal which omits it.

export const _managerSkipOpenCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    outletId: v.id("outlets"),
    deviceId: v.string(),
    staffId: v.id("staff"),
  },
  handler: withIdempotency<
    { idempotencyKey: string; outletId: Id<"outlets">; deviceId: string; staffId: Id<"staff"> },
    { ok: true; shiftId: Id<"pos_shifts"> }
  >(
    "shifts.managerSkipOpen",
    async (ctx, args): Promise<{ ok: true; shiftId: Id<"pos_shifts"> }> => {
      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, {
        outletId: args.outletId,
      });
      if (status.is_open) throw new Error("BOOTH_ALREADY_OPEN");
      await ctx.runMutation(internal.outlets.status._setOutletOpen_internal, {
        outletId: args.outletId, staffId: args.staffId, via: "manager_skip",
      });
      const shiftId = await ctx.runMutation(internal.shifts.shiftsInternal._startShift_internal, {
        outletId: args.outletId, deviceId: args.deviceId, staffId: args.staffId,
        startedVia: "manager_skip", openCount: null, steps: [], prevShiftId: null,
      });
      await logAudit(ctx, {
        actor_id: args.staffId, action: "outlet.opened", entity_type: "outlets",
        entity_id: args.outletId, source: "booth_inline",
        metadata: { via: "manager_skip", shift_id: shiftId },
      });
      return { ok: true as const, shiftId };
    },
  ),
});

export const _lastEndedShift_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<Doc<"pos_shifts"> | null> => {
    const rows = await ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_started", (q) => q.eq("outlet_id", outletId))
      .order("desc")
      .take(5);
    return rows.find((r) => r.ended_at !== null) ?? null;
  },
});

// ─── _managerOverrideCommit_internal ─────────────────────────────────────────
//
// Atomic commit for managerOverride: reads the active shift holder; if none,
// no-ops (idempotent); else builds a signoff summary, ends the shift with
// ended_via="manager_override" + outgoing_uncounted=true, emits audit, and
// schedules the Telegram signoff summary.
//
// Mirrors _managerSkipOpenCommit_internal's withIdempotency wrap.
// Internal mutations wrapped with withIdempotency do NOT take an authCheck
// (the action's withActionCache authCheck already gated entry).

export const _managerOverrideCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    deviceId: v.string(),
    managerStaffId: v.id("staff"),
    closeOutlet: v.boolean(),
    source: v.union(v.literal("booth_inline"), v.literal("telegram_approval")),
    expectedShiftId: v.optional(v.string()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      deviceId: string;
      managerStaffId: Id<"staff">;
      closeOutlet: boolean;
      source: "booth_inline" | "telegram_approval";
      expectedShiftId?: string;
    },
    { ok: true }
  >(
    "shifts.managerOverride",
    async (ctx, args): Promise<{ ok: true }> => {
      const now = Date.now();
      // Resolve outlet from the device binding (auth owns registered_devices).
      const outletId = await ctx.runQuery(internal.auth.internal._getDeviceOutletId_internal, {
        deviceId: args.deviceId,
      });

      // Resolve the live holder BEFORE any write so a stale off-booth request can
      // never close the booth (C1): the snapshot guard below must run before the
      // close block.
      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, {
        outletId,
      });

      // C1: off-booth snapshot consistency. The approver decided from a snapshot
      // (the card showed "held by X"). If the live holder no longer matches that
      // snapshot — handover/turnover/natural end during the token's 60-min TTL —
      // refuse to act on stale intent rather than force-end an unrelated shift or
      // wrongly close the booth. The inline path passes no expectedShiftId (manager
      // is present, acting on live state) and is unaffected.
      if (args.expectedShiftId !== undefined) {
        if (!holder || (holder._id as unknown as string) !== args.expectedShiftId) {
          // ConvexError so the code survives prod redaction and the /approve UI
          // can show its stale-shift message (plain Error → "Server Error").
          throw new ConvexError("SHIFT_CHANGED");
        }
      }

      // Close the outlet regardless of whether a holder exists (edge case: off-booth
      // override with closeOutlet:true when no shift is active — still must close).
      if (args.closeOutlet) {
        await ctx.runMutation(internal.outlets.status._setOutletClosed_internal, {
          outletId, staffId: args.managerStaffId,
        });
        // I1 (ADR-007): the override's close path must be auditable. _setOutletClosed_internal
        // is a bare db.patch (no audit — endOfDay audits separately at its own callsite), so
        // emit the outlet.closed row here. Reuses the endOfDay verb; metadata.via distinguishes.
        await logAudit(ctx, {
          actor_id: args.managerStaffId, action: "outlet.closed",
          entity_type: "outlets", entity_id: outletId, source: args.source,
          metadata: { via: "manager_override" },
        });
      }

      // No stranded holder → idempotent no-op (the blocked staffer can just log in).
      if (!holder) return { ok: true as const };

      const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
        shiftStartMs: holder.started_at, endMs: now, outletId,
      });
      await ctx.runMutation(internal.shifts.shiftsInternal._endShift_internal, {
        shiftId: holder._id, endedVia: "manager_override", closeCount: null,
        steps: [], outgoingUncounted: true,
        summary: {
          durationMs: summary.durationMs, totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount, manualBcaCount: summary.manualBcaCount,
          manualBcaTotalIdr: summary.manualBcaTotalIdr,
        },
      });
      await logAudit(ctx, {
        actor_id: args.managerStaffId, action: "shift.manager_override",
        entity_type: "pos_shifts", entity_id: holder._id, source: args.source,
        metadata: {
          durationMs: summary.durationMs,
          displaced_staff_id: holder.staff_id,
          resulting_state: args.closeOutlet ? "closed" : "released",
        },
      });
      await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
        eventId: holder._id, staffId: holder.staff_id, shiftStartMs: holder.started_at, shiftEndMs: now,
        totalSalesIdr: summary.totalSalesIdr, txnCount: summary.txnCount,
        manualBcaCount: summary.manualBcaCount, manualBcaTotalIdr: summary.manualBcaTotalIdr,
        idempotencyKeySuffix: holder._id, outletId,
      });
      return { ok: true as const };
    },
  ),
});
