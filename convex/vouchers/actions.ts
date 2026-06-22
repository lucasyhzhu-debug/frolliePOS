"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { verifyManagerPinOrThrow, assertManagerSessionInAction } from "../auth/verifyPin";
import { withActionCache } from "../idempotency/action";

/**
 * Code format: uppercase A–Z, digits, underscore, hyphen. 3–32 chars.
 * The action normalises args.code to uppercase BEFORE validation so a FE that
 * submits "welcome10" persists as "WELCOME10" (canonical storage).
 */
const CODE_RE = /^[A-Z0-9_-]+$/;
const CODE_MIN = 3;
const CODE_MAX = 32;

/**
 * Manager-PIN gated: create a new voucher (v0.6 Task V4).
 *
 * Flow:
 *   1. Action-level cache lookup (withActionCache) — replay returns the cached
 *      Id<"pos_vouchers"> BEFORE running argon2id verify (slow path), per the
 *      action-level idempotency pattern documented in idempotency/internal.ts.
 *   2. Validate inputs (code shape/length, value bounds, optional field
 *      ranges, expiry not in the past). All validation runs BEFORE the PIN
 *      funnel — fail-cheap on malformed input.
 *   3. Uniqueness check via _getVoucherByCode_internal (normalised code).
 *   4. Manager-PIN funnel — verifyManagerPinOrThrow (CLAUDE.md rule #18,
 *      single params object signature per convex/auth/verifyPin.ts:67-93).
 *   5. Commit via _createVoucher_internal (V3) which inserts the row and
 *      emits voucher.created audit (ADR-007).
 *
 * Errors: CODE_INVALID, VALUE_INVALID, MIN_INVALID, MAX_INVALID,
 * EXPIRES_IN_PAST, CODE_EXISTS, INVALID_PIN, MANAGER_SESSION_REQUIRED, SESSION_INVALID,
 * LOCKED_OUT:<secs>.
 *
 * Money rules: integer rupiah only (ADR-015 / CLAUDE.md #14). For percentage
 * type, value is 1–100 (integer). For amount type, value > 0 integer.
 * Server time wins for expiry-past check (ADR-031 / CLAUDE.md #15).
 */
export const createVoucher = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    code: v.string(),
    type: v.union(v.literal("percentage"), v.literal("amount")),
    value: v.number(),
    min_cart_value: v.optional(v.number()),
    max_redemptions: v.optional(v.number()),
    expires_at: v.optional(v.number()),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"pos_vouchers">> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "vouchers.createVoucher" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async (): Promise<Id<"pos_vouchers">> => {
        // ── Validation (fail-before-PIN: cheap rejection of malformed input) ──
        const code = args.code.toUpperCase();
        if (
          code.length < CODE_MIN ||
          code.length > CODE_MAX ||
          !CODE_RE.test(code)
        ) {
          throw new Error("CODE_INVALID");
        }
        if (!Number.isInteger(args.value)) throw new Error("VALUE_INVALID");
        if (args.type === "percentage" && !(args.value > 0 && args.value <= 100)) {
          throw new Error("VALUE_INVALID");
        }
        if (args.type === "amount" && args.value <= 0) {
          throw new Error("VALUE_INVALID");
        }
        if (
          args.min_cart_value !== undefined &&
          (!Number.isInteger(args.min_cart_value) || args.min_cart_value < 0)
        ) {
          throw new Error("MIN_INVALID");
        }
        if (
          args.max_redemptions !== undefined &&
          (!Number.isInteger(args.max_redemptions) || args.max_redemptions < 1)
        ) {
          throw new Error("MAX_INVALID");
        }
        if (args.expires_at !== undefined && args.expires_at <= Date.now()) {
          throw new Error("EXPIRES_IN_PAST");
        }

        // ── Resolve outlet from session (v2.0 Task 12: enforced) ──
        const sessionRow = await ctx.runQuery(
          internal.auth.internal._resolveSession_internal,
          { sessionId: args.sessionId },
        );
        if (!sessionRow) throw new Error("NO_SESSION");
        const outletId = sessionRow.outlet_id;

        // ── Uniqueness (normalised code, before PIN — fail-cheap) ──
        const existing = await ctx.runQuery(
          internal.vouchers.internal._getVoucherByCode_internal,
          { code, outletId },
        );
        if (existing) throw new Error("CODE_EXISTS");

        // ── Manager-PIN funnel (CLAUDE.md #18 — never call argon2 directly) ──
        const { managerId, deviceId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });

        // ── Commit (V3 internal — inserts + audits voucher.created) ──
        return await ctx.runMutation(internal.vouchers.internal._createVoucher_internal, {
          code,
          type: args.type,
          value: args.value,
          min_cart_value: args.min_cart_value,
          max_redemptions: args.max_redemptions,
          expires_at: args.expires_at,
          createdBy: managerId,
          deviceId,
          outletId,
        });
      },
    ),
});
