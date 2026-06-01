import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession } from "../auth/sessions";

/**
 * Commit a staff role change. Owns the last-active-manager guard so the
 * read-and-patch happens in a single mutation transaction (no race window
 * between the check and the write). Called by `staff/actions.setStaffRole`
 * AFTER the manager PIN has been verified in the action layer.
 *
 * The guard scans `staff` via the `by_role` index then JS-filters for
 * `active && _id !== targetId`. `_listActiveManagers_internal` returns code+name
 * only (no _id), so it can't support an exclude-by-id query — direct scan is
 * the correct read here. The staff table is tiny (single-booth).
 */
export const _setStaffRoleCommit_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    role: v.union(v.literal("staff"), v.literal("manager")),
    mgrId: v.id("staff"),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.staffId);
    if (!target) throw new Error("STAFF_NOT_FOUND");
    if (target.role === "manager" && args.role === "staff") {
      const managers = await ctx.db
        .query("staff")
        .withIndex("by_role", (q) => q.eq("role", "manager"))
        .collect();
      const otherActive = managers.filter(
        (m) => m.active && m._id !== args.staffId,
      );
      if (otherActive.length === 0) throw new Error("LAST_ACTIVE_MANAGER");
    }
    await ctx.db.patch(args.staffId, { role: args.role });
    await logAudit(ctx, {
      actor_id: args.mgrId,
      action: "staff.updated",
      entity_type: "staff",
      entity_id: args.staffId,
      source: "booth_inline",
      metadata: { field: "role", role: args.role },
    });
    return { ok: true as const };
  },
});

/**
 * Commit a staff deactivation. Owns SELF_DEACTIVATE + LAST_ACTIVE_MANAGER guards
 * so read+patch are atomic. Called by `staff/actions.deactivateStaff` AFTER
 * manager PIN verification.
 *
 * Guard order is deliberate:
 *   1. SELF_DEACTIVATE  (cheapest, semantically clearest — no DB read)
 *   2. STAFF_NOT_FOUND  (target lookup)
 *   3. already-inactive (idempotent no-op for retries past the original commit)
 *   4. LAST_ACTIVE_MANAGER (index scan + JS filter)
 *   5. patch + audit
 *
 * No session teardown: `requireSession` rejects inactive staff, so the target's
 * live session self-invalidates on its next request.
 */
export const _deactivateStaffCommit_internal = internalMutation({
  args: { staffId: v.id("staff"), mgrId: v.id("staff") },
  handler: async (ctx, args) => {
    if (args.staffId === args.mgrId) throw new Error("SELF_DEACTIVATE");
    const target = await ctx.db.get(args.staffId);
    if (!target) throw new Error("STAFF_NOT_FOUND");
    if (!target.active) return { ok: true as const }; // idempotent no-op
    if (target.role === "manager") {
      const managers = await ctx.db
        .query("staff")
        .withIndex("by_role", (q) => q.eq("role", "manager"))
        .collect();
      const otherActive = managers.filter(
        (m) => m.active && m._id !== args.staffId,
      );
      if (otherActive.length === 0) throw new Error("LAST_ACTIVE_MANAGER");
    }
    await ctx.db.patch(args.staffId, { active: false });
    await logAudit(ctx, {
      actor_id: args.mgrId,
      action: "staff.deactivated",
      entity_type: "staff",
      entity_id: args.staffId,
      source: "booth_inline",
    });
    return { ok: true as const };
  },
});

export const _createStaffCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    name: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
    pin_hash: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      name: string;
      role: "staff" | "manager";
      pin_hash: string;
    },
    { _id: Id<"staff">; name: string; role: "staff" | "manager" }
  >(
    "staff.createStaff",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId); // defensive — also provides mgrId/deviceId
      const newId = await ctx.db.insert("staff", {
        name: args.name, pin_hash: args.pin_hash, role: args.role,
        active: true, created_at: Date.now(),
      });
      await logAudit(ctx, {
        actor_id: mgrId, action: "staff.created",
        entity_type: "staff", entity_id: newId,
        source: "booth_inline", device_id: deviceId,
      });
      return { _id: newId, name: args.name, role: args.role };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});
