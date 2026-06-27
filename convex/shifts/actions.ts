"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { verifyPinOrThrow, verifyManagerPinOrThrow, assertManagerSessionInAction } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";
import { wibDayWindow } from "../lib/time";
import { resolveStaffName } from "./lib";

// managerTakeover deleted (ADR-053): replaced by managerOverride in this file, which
// force-ends a stranded pos_shifts row without creating a new session. The original
// staffer (or manager) re-authenticates via standard login after the override.

// ─── _sendSignoffSummary ──────────────────────────────────────────────────────
//
// Deferred internal action scheduled from `handover`, `endOfDay`, and
// `_managerOverrideCommit_internal`. Builds the full Telegram payload (including
// manual-BCA items) and sends it via `sendTemplate` to the managers role.
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

// _sendTakeoverSummary deleted (ADR-053): was the deferred Telegram action for the
// displaced staff's shift summary on managerTakeover. Both managerTakeover and
// _commitManagerTakeover_internal are deleted; managerOverride does not need a
// displaced-staff summary (the original holder resumes normally after the override).

// ─── managerOverride ──────────────────────────────────────────────────────────
//
// Force-ends a stranded shift without starting a new one. The blocked staffer
// can then log in normally. Requires an off-session manager PIN (same pattern
// as managerTakeover — no live session because nobody may be logged in).
//
// ADR-046: authCheck (pre-cache) is the cheap role/active check. Argon2 verify
// stays inside fn so a legit cache-hit replay skips it.

export const managerOverride = action({
  args: {
    idempotencyKey: v.string(),
    deviceId: v.string(),
    managerStaffId: v.id("staff"),
    managerPin: v.string(),
    resultingState: v.union(v.literal("close"), v.literal("release")),
  },
  handler: async (ctx, args): Promise<{ ok: true }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "shifts.managerOverride" },
      // authCheck (pre-cache, ADR-046): cheap role/active assert, NO PIN.
      async () => {
        const mgr = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
          staffId: args.managerStaffId,
        });
        if (!mgr || !mgr.active || mgr.role !== "manager") throw new Error("NOT_MANAGER");
      },
      // body: argon2 PIN verify (skipped on replay), then commit.
      async () => {
        const mgr = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
          staffId: args.managerStaffId,
        });
        if (!mgr || !mgr.active || mgr.role !== "manager") throw new Error("NOT_MANAGER");
        await verifyPinOrThrow(ctx, {
          staffId: args.managerStaffId,
          deviceId: args.deviceId,
          pinHash: mgr.pin_hash,
          pin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });
        return ctx.runMutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          deviceId: args.deviceId,
          managerStaffId: args.managerStaffId,
          closeOutlet: args.resultingState === "close",
          source: "booth_inline",
        });
      },
    ),
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
