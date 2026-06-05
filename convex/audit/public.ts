import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { requireManagerSession } from "../auth/sessions";
import { auditListHandler } from "./internal";

/**
 * Public audit log — manager session required. Rows are enriched with a
 * server-derived `actor_name` (ADR-034 cross-module read via
 * _listStaffNames_internal; "BE pre-derives labels" — v0.5.3a). The raw
 * `_list_internal` variant stays label-free for server/test callers.
 */
export const list = query({
  args: {
    sessionId: v.id("staff_sessions"),
    limit: v.optional(v.number()),
    action: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireManagerSession(ctx, args.sessionId);
    const rows = await auditListHandler(ctx, args);

    const staffNames = await ctx.runQuery(
      internal.auth.internal._listStaffNames_internal,
      {},
    );
    const nameById = new Map(staffNames.map((s) => [String(s._id), s.name]));

    return rows.map((r) => ({
      ...r,
      actor_name:
        r.actor_id === "system"
          ? "System"
          : nameById.get(String(r.actor_id)) ?? String(r.actor_id),
    }));
  },
});
