"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { verifyManagerPinOrThrow, assertManagerSessionInAction } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";
import { parseWibDayLabel } from "../lib/time";
import { internal } from "../_generated/api";

const LAST4_RE = /^\d{4}$/;

/**
 * Manager-PIN gated manual settlement entry (v0.7). The VERIFIED launch path —
 * the auto-poll is KYB-gated (spec R2). Mirrors vouchers.createVoucher:
 *   authCheck (pre-cache, ADR-046) → validate → verifyManagerPinOrThrow → commit.
 * net is computed server-side (ADR-031/-015 — never client-supplied money math).
 * Errors: DATE_INVALID, AMOUNT_INVALID, NET_INVALID, LAST4_INVALID,
 * MANAGER_SESSION_REQUIRED, SESSION_INVALID, NOT_MANAGER, INVALID_PIN, LOCKED_OUT:<secs>.
 *
 * Idempotency: the action-level `withActionCache` absorbs a same-key replay
 * before `fn()` runs, so the inner mutation is never re-invoked on a normal
 * retry. The inner `_upsertSettlementDay_internal` is itself idempotent by
 * `settlement_key` (upsert-by-day), which covers the narrow window where an
 * action crashes between the inner commit and the cache write — so no separate
 * `${key}:commit` / `withIdempotency` layer is needed here (matches createVoucher).
 */
export const enterSettlementManually = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    settlementDate: v.string(),
    grossAmount: v.number(),
    mdrAmount: v.number(),
    transactionCount: v.number(),
    bcaAccountLast4: v.string(),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"pos_settlements">> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "settlements.enterSettlementManually" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async (): Promise<Id<"pos_settlements">> => {
        // Strict YYYY-MM-DD + impossible-date rejection (2026-13-45, 2026-02-30)
        // via the canonical labelled-WIB-day parser (lib/time.ts), so the
        // settlement key can never desync from a real Xendit settlement date.
        try {
          parseWibDayLabel(args.settlementDate);
        } catch {
          throw new Error("DATE_INVALID");
        }
        if (!LAST4_RE.test(args.bcaAccountLast4)) throw new Error("LAST4_INVALID");
        for (const n of [args.grossAmount, args.mdrAmount, args.transactionCount]) {
          if (!Number.isInteger(n) || n < 0) throw new Error("AMOUNT_INVALID");
        }
        // A settled day is, by definition, ≥1 collected txn with positive gross —
        // reject degenerate zero-gross / zero-count entries (incoherent data).
        if (args.grossAmount < 1 || args.transactionCount < 1) throw new Error("AMOUNT_INVALID");
        const net = args.grossAmount - args.mdrAmount;
        if (net < 0) throw new Error("NET_INVALID");

        const { managerId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });

        return await ctx.runMutation(internal.settlements.internal._upsertSettlementDay_internal, {
          settlement_date: args.settlementDate,
          gross_amount: args.grossAmount,
          mdr_amount: args.mdrAmount,
          net_amount: net,
          transaction_count: args.transactionCount,
          source: "manual",
          entered_by: managerId,
          bca_account_destination: args.bcaAccountLast4,
        });
      },
    ),
});
