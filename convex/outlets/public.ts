import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireManagerSession } from "../auth/sessions";

export const listOutlets = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }) => {
    await requireManagerSession(ctx, sessionId);
    const rows = await ctx.db.query("outlets").withIndex("by_active", (q) => q.eq("active", true)).collect();
    return rows.map((o) => ({ _id: o._id, code: o.code, name: o.name, active: o.active }));
  },
});
