import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { stepValidator } from "./schema";

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
