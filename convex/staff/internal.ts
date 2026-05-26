import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession } from "../auth/sessions";

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
