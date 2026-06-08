import { query } from "../_generated/server";
import { v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";

/**
 * Role-agnostic settlements read (ADR-012: staff + managers both). Any valid
 * session passes; an absent/ended session throws SESSION_INVALID. Newest
 * settlement_date first. Optional YYYY-MM-DD inclusive date-range filter.
 *
 * Cross-module: session resolved via auth internal surface (ADR-034 —
 * settlements/ must not read staff_sessions directly).
 *
 * Uses _resolveSessionRole_internal (returns null for missing/ended sessions)
 * rather than _resolveSession_internal because it is already exported and
 * semantically equivalent for a null-check gate. Role field is ignored here
 * since access is role-agnostic.
 */
export const listSettlements = query({
  args: {
    sessionId: v.id("staff_sessions"),
    fromDate: v.optional(v.string()),
    toDate: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"pos_settlements">[]> => {
    const resolved = await ctx.runQuery(
      internal.auth.internal._resolveSessionRole_internal,
      { sessionId: args.sessionId },
    );
    if (!resolved) throw new Error("SESSION_INVALID");

    // YYYY-MM-DD dates sort lexicographically, so push the inclusive range into
    // the index and let the engine return rows newest-first — matches the
    // .withIndex(range).order("desc") pattern used across the repo (e.g.
    // transactions/public.ts), no full-table fetch + JS re-sort.
    return await ctx.db
      .query("pos_settlements")
      .withIndex("by_settlement_date", (q) => {
        if (args.fromDate && args.toDate)
          return q.gte("settlement_date", args.fromDate).lte("settlement_date", args.toDate);
        if (args.fromDate) return q.gte("settlement_date", args.fromDate);
        if (args.toDate) return q.lte("settlement_date", args.toDate);
        return q;
      })
      .order("desc")
      .collect();
  },
});
