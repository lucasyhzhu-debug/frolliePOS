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
 *
 * v0.5.3b post-review fix: action retry after a crash between commit and
 * action-level cache write would re-execute and double-emit the audit row.
 * withIdempotency on the `:commit`-derived key short-circuits the retry. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md and
 * refunds._commitRefund_internal for the canonical shape.
 *
 * Also: already-this-role short-circuit. A repeat patch with the same role is
 * a no-op (mirrors _deactivateStaffCommit_internal's `if (!target.active)`
 * idempotent guard), preventing a duplicate `staff.updated` audit row when a
 * manager re-confirms the same role.
 */
export const _setStaffRoleCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    role: v.union(v.literal("staff"), v.literal("manager")),
    mgrId: v.id("staff"),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      staffId: Id<"staff">;
      role: "staff" | "manager";
      mgrId: Id<"staff">;
    },
    { ok: true }
  >(
    "staff._setStaffRoleCommit_internal",
    async (ctx, args) => {
      const target = await ctx.db.get(args.staffId);
      if (!target) throw new Error("STAFF_NOT_FOUND");
      if (target.role === args.role) return { ok: true as const }; // idempotent no-op
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
  ),
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
 *
 * v0.5.3b post-review fix: action retry after a crash between commit and
 * action-level cache write would re-execute. The already-inactive guard above
 * catches the duplicate patch, but withIdempotency on the `:commit`-derived key
 * adds belt-and-braces and matches refunds._commitRefund_internal's shape. See
 * docs/PATTERNS/idempotency-dual-call-authcheck.md.
 */
export const _deactivateStaffCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    mgrId: v.id("staff"),
  },
  handler: withIdempotency<
    { idempotencyKey: string; staffId: Id<"staff">; mgrId: Id<"staff"> },
    { ok: true }
  >(
    "staff._deactivateStaffCommit_internal",
    async (ctx, args) => {
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
  ),
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
