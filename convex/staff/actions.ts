"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { verifyManagerPinOrThrow } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";

/**
 * Promote or demote a staff member. Manager session + manager PIN required.
 * Uses `withActionCache` (v0.5.3b post-review extraction) to wrap the standard
 * action-level lookup/run/write idempotency pattern. The inner runMutation
 * still passes `${key}:commit` so the wrapped internal short-circuits any
 * crash-retry between commit and cache-write.
 *
 * Last-manager guard lives in the internal mutation (not here) so the read +
 * patch are atomic. The action layer cannot atomically check-then-write.
 */
export const setStaffRole = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    staffId: v.id("staff"),
    role: v.union(v.literal("staff"), v.literal("manager")),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "staff.setStaffRole" },
      async () => {
        const { managerId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        // Pass derived `:commit` key so the wrapped internal short-circuits an
        // action retry after a crash between commit and action-level cache write
        // (mirrors refunds._commitRefund_internal pattern).
        await ctx.runMutation(internal.staff.internal._setStaffRoleCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          staffId: args.staffId,
          role: args.role,
          mgrId: managerId,
        });
        return { ok: true } as const;
      },
    ),
});

/**
 * Deactivate a staff member. Manager session + manager PIN required.
 * Same withActionCache wrap as setStaffRole. SELF_DEACTIVATE +
 * LAST_ACTIVE_MANAGER guards live in the internal so the read+patch is atomic.
 */
export const deactivateStaff = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    staffId: v.id("staff"),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "staff.deactivateStaff" },
      async () => {
        const { managerId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        // Pass derived `:commit` key so the wrapped internal short-circuits an
        // action retry after a crash between commit and action-level cache write
        // (mirrors refunds._commitRefund_internal pattern).
        await ctx.runMutation(internal.staff.internal._deactivateStaffCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          staffId: args.staffId,
          mgrId: managerId,
        });
        return { ok: true } as const;
      },
    ),
});
