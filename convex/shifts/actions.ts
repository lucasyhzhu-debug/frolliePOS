"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { verifyPinOrThrow } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";

/**
 * Manager takeover: a manager proves their PIN at the locked booth to take over
 * directly, without waiting for the outgoing staff to do a formal handover-out.
 *
 * Why an ACTION (not a mutation):
 *   PIN verification uses argon2id (`verifyPinOrThrow`), which requires the Node
 *   runtime (ActionCtx). All DB writes are delegated to the atomic internal mutation
 *   `_commitManagerTakeover_internal` so force-end + session-create + event-record
 *   happen atomically.
 *
 * ADR-046 (auth-before-cache): `authCheck` is a cheap role/active check that runs
 * BEFORE the action-level cache lookup. The expensive argon2 PIN verify stays inside
 * `fn` so a legit cache-hit replay skips it.
 *
 * Note: The auth check for this action does NOT require a live session from the
 * caller — the manager proves identity solely via `managerStaffId` + `managerPin`.
 * This is intentional for the "booth is locked, no session exists" use-case.
 *
 * Task 9 adds: after the commit, schedule the displaced staff's Founders summary
 * via `ctx.scheduler.runAfter(0, internal.shifts.actions._sendTakeoverSummary, {...})`.
 */
export const managerTakeover = action({
  args: {
    idempotencyKey: v.string(),
    deviceId: v.string(),
    managerStaffId: v.id("staff"),
    managerPin: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sessionId: Id<"staff_sessions">; eventId: Id<"pos_shift_events"> }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "shifts.managerTakeover" },
      // ADR-046: authCheck runs BEFORE cache lookup — cheap role/active assert.
      // Does NOT verify PIN (expensive argon2 stays in fn so replays skip it).
      async () => {
        const mgr = await ctx.runQuery(
          internal.auth.internal._getStaffPinHash_internal,
          { staffId: args.managerStaffId },
        );
        if (!mgr || !mgr.active || mgr.role !== "manager") {
          throw new Error("NOT_MANAGER");
        }
      },
      async () => {
        // Re-fetch inside fn (TOCTOU: role/active may have changed since authCheck).
        const mgr = await ctx.runQuery(
          internal.auth.internal._getStaffPinHash_internal,
          { staffId: args.managerStaffId },
        );
        if (!mgr || !mgr.active || mgr.role !== "manager") {
          throw new Error("NOT_MANAGER");
        }

        // argon2id verify against the manager's own PIN hash.
        // Lockout pre-check + failed-attempt recording on wrong PIN (booth misses
        // count unconditionally toward lockout, SEC-01).
        await verifyPinOrThrow(ctx, {
          staffId: args.managerStaffId,
          deviceId: args.deviceId,
          pinHash: mgr.pin_hash,
          pin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });

        // Atomic DB commit: force-end active sessions → create manager session →
        // record manager_takeover shift event → audit log.
        // Pass derived `:commit` key so withIdempotency in the internal can
        // short-circuit a crash-retry between commit and action-level cache write.
        return ctx.runMutation(
          internal.shifts.internal._commitManagerTakeover_internal,
          {
            idempotencyKey: `${args.idempotencyKey}:commit`,
            deviceId: args.deviceId,
            managerStaffId: args.managerStaffId,
          },
        );
      },
    ),
});
