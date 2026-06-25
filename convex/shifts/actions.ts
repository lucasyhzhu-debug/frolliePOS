"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { verifyPinOrThrow, verifyManagerPinOrThrow, assertManagerSessionInAction } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";
import { wibDayWindow } from "../lib/time";
import { resolveStaffName } from "./lib";

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

// ─── _sendSignoffSummary ──────────────────────────────────────────────────────
//
// Deferred internal action scheduled from `endOfDaySignOff` and `handoverOut`
// (both self-signoff paths). Builds the full Telegram payload (including
// manual-BCA items) and sends it via `sendTemplate` to the founders role.
//
// Runs after the mutation commits, so the session end + shift event are already
// persisted. Failure here does not roll back the signoff — it only affects
// the Telegram notification.
//
// `endedBy: "self"` for both paths (the staff performed their own signoff).

export const _sendSignoffSummary = internalAction({
  args: {
    eventId: v.union(v.id("pos_shift_events"), v.id("pos_shifts")),
    staffId: v.id("staff"),
    shiftStartMs: v.number(),
    shiftEndMs: v.number(),
    totalSalesIdr: v.number(),
    txnCount: v.number(),
    manualBcaCount: v.number(),
    manualBcaTotalIdr: v.number(),
    idempotencyKeySuffix: v.string(),
    outletId: v.id("outlets"),
  },
  handler: async (ctx, args): Promise<void> => {
    // Resolve staff display name and fetch manual-BCA items in parallel.
    // v2.0 Stream 5: pass outletId so the BCA tally is outlet-scoped.
    const [staffNames, manualBca] = await Promise.all([
      ctx.runQuery(internal.auth.internal._listStaffNames_internal, {}),
      ctx.runQuery(internal.transactions.internal._manualBcaReconciliation_internal, {
        dayStartMs: args.shiftStartMs,
        dayEndMs: args.shiftEndMs,
        outletId: args.outletId,
      }),
    ]);
    const staffName = resolveStaffName(staffNames, args.staffId);

    const { dateLabel } = wibDayWindow(args.shiftEndMs);

    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "staff_shift_signoff",
      payload: {
        dateLabel,
        staffName,
        shiftStartMs: args.shiftStartMs,
        shiftEndMs: args.shiftEndMs,
        durationMs: Math.max(0, args.shiftEndMs - args.shiftStartMs),
        totalSalesIdr: args.totalSalesIdr,
        txnCount: args.txnCount,
        manualBca: args.manualBcaCount > 0
          ? { count: args.manualBcaCount, totalIdr: args.manualBcaTotalIdr, items: manualBca.items }
          : undefined,
        endedBy: "self",
      },
      idempotencyKey: `signoff:${args.idempotencyKeySuffix}`,
      outletId: args.outletId, // v2.0 Spec-4 Task 5: route to per-outlet managers
    });
  },
});

// ─── _sendTakeoverSummary ─────────────────────────────────────────────────────
//
// Deferred internal action scheduled from `_commitManagerTakeover_internal`.
// Summarises the displaced staff's shift up to the takeover moment.
// `endedBy: "manager"`, `outgoingUncounted: true`.
//
// For the takeover case we don't have a pre-computed summary (the internal
// mutation deliberately avoids aggregation). We query the shift anchor to
// recover shiftStartMs, then build the same summary query.

export const _sendTakeoverSummary = internalAction({
  args: {
    eventId: v.id("pos_shift_events"),
    displacedStaffId: v.union(v.id("staff"), v.null()),
    deviceId: v.string(),
    // Pre-computed from the lock event in _commitManagerTakeover_internal,
    // captured BEFORE the manager_takeover event is inserted. Using the lock
    // event's window avoids the [now, now] bug: after the insert the anchor walk
    // would find the new manager_takeover event (shift_started_at = now).
    displacedShiftStartMs: v.number(),
    displacedShiftEndMs: v.number(),
    idempotencyKeySuffix: v.string(),
    outletId: v.id("outlets"),
  },
  handler: async (ctx, args): Promise<void> => {
    // Resolve displaced staff name + build sales aggregate in parallel.
    // The window was pre-computed from the lock event in the mutation, so it
    // correctly spans [displaced-staff-shift-start, lock-time].
    // v2.0 Stream 5: pass outletId so the aggregates are outlet-scoped.
    const [staffNames, sales, manualBca] = await Promise.all([
      ctx.runQuery(internal.auth.internal._listStaffNames_internal, {}),
      ctx.runQuery(internal.transactions.internal._dailySalesSummary_internal, {
        dayStartMs: args.displacedShiftStartMs,
        dayEndMs: args.displacedShiftEndMs,
        outletId: args.outletId,
      }),
      ctx.runQuery(internal.transactions.internal._manualBcaReconciliation_internal, {
        dayStartMs: args.displacedShiftStartMs,
        dayEndMs: args.displacedShiftEndMs,
        outletId: args.outletId,
      }),
    ]);
    // Displaced staff name (may be null if no one was on shift).
    const staffName = resolveStaffName(staffNames, args.displacedStaffId);

    const { dateLabel } = wibDayWindow(args.displacedShiftEndMs);

    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "staff_shift_signoff",
      payload: {
        dateLabel,
        staffName,
        shiftStartMs: args.displacedShiftStartMs,
        shiftEndMs: args.displacedShiftEndMs,
        durationMs: Math.max(0, args.displacedShiftEndMs - args.displacedShiftStartMs),
        totalSalesIdr: sales.totalSalesIdr,
        txnCount: sales.txnCount,
        manualBca: manualBca.count > 0
          ? { count: manualBca.count, totalIdr: manualBca.totalIdr, items: manualBca.items }
          : undefined,
        endedBy: "manager",
        outgoingUncounted: true,
      },
      idempotencyKey: `signoff:takeover:${args.idempotencyKeySuffix}`,
      outletId: args.outletId, // v2.0 Spec-4 Task 5: route to per-outlet managers
    });
  },
});

// ─── managerSkipOpen ──────────────────────────────────────────────────────────
//
// Manager opens the booth without going through the full SOP checklist.
// Requires an active manager session + PIN verification (argon2id).
//
// ADR-046: authCheck (pre-cache) asserts an active manager session WITHOUT
// verifying PIN. The expensive argon2 verify stays inside fn so a legit
// cache-hit replay skips it.

export const managerSkipOpen = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; shiftId: Id<"pos_shifts"> }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "shifts.managerSkipOpen" },
      // authCheck (pre-cache, ADR-046): active-manager session assert, NO PIN.
      async () => {
        await assertManagerSessionInAction(ctx, args.sessionId);
      },
      // body: verify the manager's PIN, resolve outlet from session, commit.
      async () => {
        await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        const sess = await ctx.runQuery(internal.auth.internal._resolveSession_internal, {
          sessionId: args.sessionId,
        });
        if (!sess) throw new Error("SESSION_INVALID");
        return ctx.runMutation(internal.shifts.shiftsInternal._managerSkipOpenCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          outletId: sess.outlet_id,
          deviceId: sess.deviceId,
          staffId: sess.staffId,
        });
      },
    ),
});
