"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { verifyManagerPinOrThrow } from "../auth/verifyPin";

/**
 * Promote or demote a staff member. Manager session + manager PIN required.
 * Mirrors `auth.actions.resetStaffPin`'s action-level idempotency pattern:
 *   1. Cache pre-check via `_lookup_internal` (short-circuit on retry).
 *   2. `verifyManagerPinOrThrow` — proves the caller is an active manager and
 *      records lockout/fail against the MANAGER on a bad PIN.
 *   3. `_setStaffRoleCommit_internal` — owns the last-active-manager guard +
 *      patch + audit row in one mutation transaction.
 *   4. Write the response into the idempotency cache.
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
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { ok: true };

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

    const response = { ok: true } as const;
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "staff.setStaffRole",
      response: JSON.stringify(response),
    });
    return response;
  },
});

/**
 * Deactivate a staff member. Manager session + manager PIN required.
 * Mirrors `setStaffRole`'s action-level idempotency pattern exactly.
 * SELF_DEACTIVATE + LAST_ACTIVE_MANAGER guards live in the internal mutation
 * so the read+patch is atomic.
 */
export const deactivateStaff = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    staffId: v.id("staff"),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { ok: true };

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

    const response = { ok: true } as const;
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "staff.deactivateStaff",
      response: JSON.stringify(response),
    });
    return response;
  },
});
