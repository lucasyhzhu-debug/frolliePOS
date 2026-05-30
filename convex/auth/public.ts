import { query, mutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";

/**
 * List active staff for the login screen.
 * Public: pre-auth (login screen calls this before any session exists).
 * Returns name + role + _id only; pin_hash never leaves the server.
 */
export const getActiveStaff = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("staff")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return rows.map((s) => ({ _id: s._id, name: s.name, role: s.role }));
  },
});

export const getSession = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.sessionId);
    if (!s || s.ended_at != null) return null;
    const staff = await ctx.db.get(s.staff_id);
    if (!staff || !staff.active) return null;
    return {
      sessionId: s._id,
      staff: { _id: staff._id, name: staff.name, role: staff.role },
      deviceId: s.device_id,
      startedAt: s.started_at,
    };
  },
});

export const logout = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<{ idempotencyKey: string; sessionId: Id<"staff_sessions"> }, null>(
    "auth.logout",
    async (ctx, args) => {
      const session = await ctx.db.get(args.sessionId);
      if (!session || session.ended_at != null) return null;
      await ctx.db.patch(args.sessionId, {
        ended_at: Date.now(),
        end_reason: "manual_lock",
      });
      await logAudit(ctx, {
        actor_id: session.staff_id, action: "staff.logout",
        entity_type: "staff_session", entity_id: args.sessionId,
        source: "booth_inline", device_id: session.device_id,
      });
      return null;
    },
    {
      // intentional: logout is idempotent — a stale or already-ended session must
      // remain a graceful no-op (handler body returns null without throwing). The
      // idempotency key dedupes genuine double-taps of the Lock button. Strict
      // authCheck would surface a NO_SESSION error to the PWA, breaking the UX
      // contract that "Lock" is safe to retry.
      authCheck: async () => {},
    },
  ),
});
