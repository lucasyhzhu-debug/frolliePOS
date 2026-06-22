import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const _getOutlet_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: (ctx, { outletId }) => ctx.db.get(outletId),
});

export const _requireOutletCode_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }) => {
    const o = await ctx.db.get(outletId);
    if (!o) throw new Error("OUTLET_NOT_FOUND");
    return o.code;
  },
});

// Migration-tolerant fallback: the single active outlet during the optional window.
export const _getDefaultOutlet_internal = internalQuery({
  args: {},
  handler: (ctx) =>
    ctx.db.query("outlets").withIndex("by_active", (q) => q.eq("active", true)).first(),
});
