import { v } from "convex/values";
import { query } from "../_generated/server";
import { internal } from "../_generated/api";
import { deriveBoothState, BoothState } from "./lib";
import { wibDayWindow } from "../lib/time";
import type { Id } from "../_generated/dataModel";

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
        names.find((s) => String(s._id) === String(derived.staffId))?.name ??
        null;
    }
    return { ...derived, staffName };
  },
});
