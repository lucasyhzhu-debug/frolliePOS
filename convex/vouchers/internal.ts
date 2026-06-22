import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";

/**
 * Look up a voucher by code (uppercased). Exposed so the transactions funnel
 * can find a voucher without reading vouchers-owned tables directly (ADR-034).
 *
 * Explicit return type: this query is consumed cross-module via ctx.runQuery
 * (transactions funnel). Without the annotation, tsc -b collapses the inferred
 * type to `any`/`{}` at the call site (Convex cross-module circular inference).
 *
 * v2.0 Stream 5: uses by_outlet_code when outletId is provided.
 */
export const _getVoucherByCode_internal = internalQuery({
  args: { code: v.string(), outletId: v.optional(v.id("outlets")) },
  handler: async (ctx, args): Promise<Doc<"pos_vouchers"> | null> => {
    const code = args.code.toUpperCase();
    // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outletId may be undefined).
    return await ctx.db
      .query("pos_vouchers")
      .withIndex("by_outlet_code", (q) =>
        q.eq("outlet_id", args.outletId).eq("code", code),
      )
      .first();
  },
});

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
    outletId: v.optional(v.id("outlets")),
  },
  handler: async (ctx, args): Promise<{ overRedeemed: boolean; alreadyRedeemed: boolean }> => {
    // Idempotency guard: if this transaction already has a redemption row, bail out.
    // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outletId may be undefined).
    const existing = await ctx.db
      .query("pos_voucher_redemptions")
      .withIndex("by_outlet_transaction", (q) =>
        q.eq("outlet_id", args.outletId).eq("transaction_id", args.transaction_id),
      )
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
    // v2.0 Stream 5: stamp outlet_id when provided.
    await ctx.db.insert("pos_voucher_redemptions", {
      voucher_id: args.voucher_id,
      transaction_id: args.transaction_id,
      code_snapshot: args.code_snapshot,
      discount_amount: args.discount_amount,
      redeemed_at: Date.now(),
      ...(args.outletId !== undefined ? { outlet_id: args.outletId } : {}),
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

/**
 * Insert a new pos_vouchers row + log voucher.created audit.
 *
 * Caller (createVoucher action, Task V4) MUST have already:
 *   - verified manager PIN via verifyManagerPinOrThrow,
 *   - validated code format/uniqueness/value bounds.
 * This mutation is a pure write + audit — no validation, no PIN handling.
 *
 * NEVER call directly from a public surface; always through the PIN-gated action.
 *
 * ADR-007: voucher.created audit row is mandatory.
 * ADR-031: created_at set inside the handler (server-time wins).
 */
export const _createVoucher_internal = internalMutation({
  args: {
    code: v.string(),
    type: v.union(v.literal("percentage"), v.literal("amount")),
    value: v.number(),
    min_cart_value: v.optional(v.number()),
    max_redemptions: v.optional(v.number()),
    expires_at: v.optional(v.number()),
    createdBy: v.id("staff"),
    deviceId: v.string(),
    outletId: v.optional(v.id("outlets")),
  },
  handler: async (ctx, args): Promise<Id<"pos_vouchers">> => {
    const id = await ctx.db.insert("pos_vouchers", {
      code: args.code,
      type: args.type,
      value: args.value,
      used_count: 0,
      active: true,
      created_at: Date.now(),
      created_by_staff_id: args.createdBy,
      // Conditional spread keeps optional fields absent (not stored as undefined).
      ...(args.min_cart_value !== undefined ? { min_cart_value: args.min_cart_value } : {}),
      ...(args.max_redemptions !== undefined ? { max_redemptions: args.max_redemptions } : {}),
      ...(args.expires_at !== undefined ? { expires_at: args.expires_at } : {}),
      // v2.0 Stream 5: stamp outlet_id when provided.
      ...(args.outletId !== undefined ? { outlet_id: args.outletId } : {}),
    });
    await logAudit(ctx, {
      actor_id: args.createdBy,
      action: "voucher.created",
      entity_type: "pos_vouchers",
      entity_id: id,
      source: "booth_inline",
      device_id: args.deviceId,
      metadata: { code: args.code, type: args.type, value: args.value },
    });
    return id;
  },
});
