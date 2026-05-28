import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { logAudit } from "../audit/internal";

/**
 * Atomically redeem a voucher against a transaction.
 *
 * Three outcomes:
 * - { overRedeemed: false, alreadyRedeemed: false } — normal redemption: increments
 *   used_count, writes a pos_voucher_redemptions row, emits audit row.
 * - { overRedeemed: true,  alreadyRedeemed: false } — max_redemptions exceeded at
 *   call time: no redemption row written, no count change, over-redeem flagged in audit.
 * - { overRedeemed: false, alreadyRedeemed: true  } — idempotent re-fire: a redemption
 *   row for this transaction_id already exists, nothing changed. Safe to call twice
 *   (e.g. webhook + polling race).
 *
 * ADR-010: one voucher per transaction enforced by the by_transaction index check.
 * ADR-007: every code path that matters emits an audit row.
 *
 * Race safety: Convex serialises concurrent mutations, so the by_transaction existence
 * check + the insert/patch are atomic within one transaction — double-fire (e.g. webhook
 * + polling) is prevented by the Convex runtime, not an application-level compare-and-swap.
 */
export const _redeemVoucher_internal = internalMutation({
  args: {
    voucher_id: v.id("pos_vouchers"),
    transaction_id: v.id("pos_transactions"),
    code_snapshot: v.string(),
    discount_amount: v.number(),
  },
  handler: async (ctx, args): Promise<{ overRedeemed: boolean; alreadyRedeemed: boolean }> => {
    // Idempotency guard: if this transaction already has a redemption row, bail out.
    const existing = await ctx.db
      .query("pos_voucher_redemptions")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.transaction_id))
      .first();
    if (existing) {
      return { overRedeemed: false, alreadyRedeemed: true };
    }

    const voucher = await ctx.db.get(args.voucher_id);
    if (!voucher) throw new Error("VOUCHER_NOT_FOUND");

    // Over-redeem check: if max_redemptions is set and already exhausted, flag and return.
    if (voucher.max_redemptions != null && voucher.used_count >= voucher.max_redemptions) {
      await logAudit(ctx, {
        actor_id: "system",
        action: "voucher.over_redeemed",
        entity_type: "pos_vouchers",
        entity_id: args.voucher_id,
        source: "system",
        metadata: {
          transaction_id: args.transaction_id,
          code: args.code_snapshot,
          used_count: voucher.used_count,
          max_redemptions: voucher.max_redemptions,
        },
      });
      return { overRedeemed: true, alreadyRedeemed: false };
    }

    // Normal redemption: write row, increment counter, audit.
    await ctx.db.insert("pos_voucher_redemptions", {
      voucher_id: args.voucher_id,
      transaction_id: args.transaction_id,
      code_snapshot: args.code_snapshot,
      discount_amount: args.discount_amount,
      redeemed_at: Date.now(),
    });
    await ctx.db.patch(args.voucher_id, { used_count: voucher.used_count + 1 });

    await logAudit(ctx, {
      actor_id: "system",
      action: "voucher.redeemed",
      entity_type: "pos_vouchers",
      entity_id: args.voucher_id,
      source: "system",
      metadata: {
        transaction_id: args.transaction_id,
        code: args.code_snapshot,
        discount_amount: args.discount_amount,
        used_count: voucher.used_count + 1,
      },
    });

    return { overRedeemed: false, alreadyRedeemed: false };
  },
});
