"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { verifyManagerPinOrThrow, assertManagerSessionInAction } from "../auth/verifyPin";
import { mintUrlSafeToken } from "../lib/tokens";
import { withActionCache } from "../idempotency/action";

/**
 * Manager-PIN gated: record a spoilage event from the booth (v0.6 Task S4).
 *
 * Flow:
 *   1. Action-level cache lookup (withActionCache) — replay returns the cached
 *      { event_id, line_count, total_qty } BEFORE running argon2id verify
 *      (slow path). Matches the v0.5.3b pattern established in
 *      catalog.actions.createProduct and vouchers.actions.createVoucher.
 *   2. Fail-cheap validators (LINES_EMPTY / REASON_INVALID) BEFORE the PIN
 *      funnel — a malformed request doesn't burn argon2 cycles. The deeper
 *      validators (QTY_INVALID, reason length) live in S3's writer for
 *      boundary-trust.
 *   3. Manager-PIN funnel — verifyManagerPinOrThrow (CLAUDE.md rule #18,
 *      never call argon2 directly).
 *   4. Mint spoilage_event_id via mintUrlSafeToken(16) — same pure V8+Node
 *      primitive used for approval and receipt tokens.
 *   5. Commit via _recordSpoilage_internal (S3) with source="booth_inline".
 *      That single-writer also handles N pos_stock_movements rows + per-SKU
 *      on_hand decrement + the stock.spoilage audit row (ADR-007).
 *
 * Errors: LINES_EMPTY, REASON_INVALID, QTY_INVALID, INVALID_PIN, MANAGER_SESSION_REQUIRED,
 * SESSION_INVALID, LOCKED_OUT:<secs>.
 *
 * Server time wins (ADR-031) — the S3 writer captures a single Date.now()
 * snapshot for all movement rows + on_hand patches + the audit row.
 */
export const recordSpoilage = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    lines: v.array(
      v.object({
        inventory_sku_id: v.id("pos_inventory_skus"),
        qty: v.number(),
      }),
    ),
    reason: v.string(),
    managerPin: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ event_id: string; line_count: number; total_qty: number }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "inventory.recordSpoilage" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async () => {
        // ── Fail-before-PIN guards (cheap rejection; avoid argon2 cycles) ──
        if (args.lines.length === 0) throw new Error("LINES_EMPTY");
        if (args.reason.trim().length === 0) throw new Error("REASON_INVALID");

        // ── Manager-PIN funnel (CLAUDE.md #18 — never call argon2 directly) ──
        const { managerId, deviceId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });

        // v2.0 Task 9E: resolve outlet from the manager session so stock
        // movements and the on_hand cache update are stamped with outlet_id.
        const session = await ctx.runQuery(api.auth.public.getSession, {
          sessionId: args.sessionId,
        });
        const outlet_id = session?.staff.outlet_id;

        // ── Mint event id (pure V8+Node portable; matches token convention) ──
        const event_id = mintUrlSafeToken(16);

        // ── Commit (S3 single-writer — movements + on_hand + audit) ──
        return await ctx.runMutation(
          internal.inventory.internal._recordSpoilage_internal,
          {
            spoilage_event_id: event_id,
            lines: args.lines,
            reason: args.reason,
            actor_id: managerId,
            source: "booth_inline",
            device_id: deviceId,
            outlet_id,
          },
        );
      },
    ),
});
