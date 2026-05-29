import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { requireManagerSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("pos_settings").first();
    return { founders_summary_enabled: row?.founders_summary_enabled ?? true };
  },
});

export const setFoundersSummaryEnabled = mutation({
  args: { sessionId: v.id("staff_sessions"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const { staffId } = await requireManagerSession(ctx, args.sessionId);
    const row = await ctx.db.query("pos_settings").first();
    if (row) {
      await ctx.db.patch(row._id, {
        founders_summary_enabled: args.enabled,
        updated_at: Date.now(),
        updated_by: staffId,
      });
    } else {
      await ctx.db.insert("pos_settings", {
        founders_summary_enabled: args.enabled,
        updated_at: Date.now(),
        updated_by: staffId,
      });
    }
    await logAudit(ctx, {
      actor_id: staffId,
      action: "settings.founders_summary_toggled",
      entity_type: "pos_settings",
      source: "booth_inline",
      metadata: { enabled: args.enabled },
    });
    return { ok: true };
  },
});
