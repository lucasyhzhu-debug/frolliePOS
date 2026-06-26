import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

export const _getOutletStatus_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<{ is_open: boolean }> => {
    const outlet = await ctx.db.get(outletId);
    return { is_open: outlet?.is_open === true };
  },
});

export const _setOutletOpen_internal = internalMutation({
  args: {
    outletId: v.id("outlets"),
    staffId: v.id("staff"),
    via: v.union(v.literal("sop"), v.literal("manager_skip")),
  },
  handler: async (ctx, { outletId, staffId, via }): Promise<null> => {
    await ctx.db.patch(outletId, {
      is_open: true,
      opened_at: Date.now(),
      opened_by: staffId,
      opened_via: via,
      closed_at: null,
      closed_by: null,
    });
    return null;
  },
});

export const _setOutletClosed_internal = internalMutation({
  args: { outletId: v.id("outlets"), staffId: v.id("staff") },
  handler: async (ctx, { outletId, staffId }): Promise<null> => {
    await ctx.db.patch(outletId, {
      is_open: false,
      closed_at: Date.now(),
      closed_by: staffId,
    });
    return null;
  },
});
