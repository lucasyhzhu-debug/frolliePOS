import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { computeVoucherDiscount } from "../lib/voucher";
import { requireManagerSession } from "../auth/sessions";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";

/**
 * Active, unexpired vouchers. Bundled into the offline catalog cache snapshot
 * by useCatalogCache so cart-build can apply vouchers offline. Server
 * re-validates at commitCart per ADR-009.
 *
 * Explicit return type: consumed cross-module via ctx.runQuery (catalog query),
 * so the annotation prevents tsc -b from collapsing the inferred element type.
 */
export const getActiveVouchers = query({
  args: {},
  handler: async (ctx): Promise<Doc<"pos_vouchers">[]> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("pos_vouchers")
      .withIndex("by_active_expires", (q) => q.eq("active", true))
      .collect();
    return rows.filter((voucher) => voucher.expires_at == null || voucher.expires_at > now);
  },
});

/**
 * Validate a voucher code against a cart subtotal. Used by routes/sale/voucher.tsx
 * for live UX feedback AND by transactions.public.commitCart for server-side
 * re-validation.
 *
 * Discount math per ADR-024:
 *   percentage: floor(subtotal * value / 100)
 *   amount:     min(value, subtotal)
 * Both integer rupiah per ADR-015.
 *
 * Returns { valid: false, reason } for not found / inactive / expired /
 * below min_cart_value. Does NOT check used_count <= max_redemptions here —
 * that race is resolved at _redeemVoucher_internal (loser gets VOUCHER_OVER_REDEEMED).
 */
export const validateVoucher = query({
  args: { code: v.string(), cartSubtotal: v.number() },
  handler: async (ctx, args): Promise<{
    valid: boolean;
    discountAmount: number;
    voucherId?: string;
    reason?: "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "MIN_CART_VALUE";
  }> => {
    const voucher = await ctx.db
      .query("pos_vouchers")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .first();
    if (!voucher) return { valid: false, discountAmount: 0, reason: "NOT_FOUND" };
    if (!voucher.active) return { valid: false, discountAmount: 0, reason: "INACTIVE" };
    if (voucher.expires_at != null && voucher.expires_at <= Date.now()) {
      return { valid: false, discountAmount: 0, reason: "EXPIRED" };
    }
    if (voucher.min_cart_value != null && args.cartSubtotal < voucher.min_cart_value) {
      return { valid: false, discountAmount: 0, reason: "MIN_CART_VALUE" };
    }
    const discountAmount = computeVoucherDiscount(voucher.type, voucher.value, args.cartSubtotal);
    return { valid: true, discountAmount, voucherId: voucher._id };
  },
});

/**
 * Edit a voucher's mutable metadata (active, expires_at, min_cart_value,
 * max_redemptions). Manager-session-gated, NO PIN — per CLAUDE.md rule #22
 * these are low-stakes config edits. Money-affecting fields (`code`, `type`,
 * `value`) are immutable post-create: archive + recreate to change them
 * (locked in by ADR-010 voucher static-by-design).
 *
 * Emits `voucher.edited` audit ONLY when at least one field actually changes.
 * Same-args replay (and same-key replay via `withIdempotency`) is therefore a
 * true no-op — no phantom audit row. `max_redemptions < used_count` is
 * rejected to preserve the invariant that an active cap can never sit below
 * already-issued redemptions.
 *
 * Mirrors `catalog.updateProductMeta`'s `withIdempotency` + `authCheck` shape:
 * authCheck runs BEFORE the cache lookup so an unauthorised retry can't read
 * a cached success (docs/PATTERNS/idempotency-dual-call-authcheck.md, rule #20).
 */
export const updateVoucherMeta = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    voucherId: v.id("pos_vouchers"),
    active: v.optional(v.boolean()),
    expires_at: v.optional(v.number()),
    min_cart_value: v.optional(v.number()),
    max_redemptions: v.optional(v.number()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      voucherId: Id<"pos_vouchers">;
      active?: boolean;
      expires_at?: number;
      min_cart_value?: number;
      max_redemptions?: number;
    },
    { ok: true }
  >(
    "vouchers.updateVoucherMeta",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const row = await ctx.db.get(args.voucherId);
      if (!row) throw new Error("VOUCHER_NOT_FOUND");
      const patch: Record<string, unknown> = {};
      const changed: string[] = [];
      if (args.active !== undefined && args.active !== row.active) {
        patch.active = args.active;
        changed.push("active");
      }
      if (args.expires_at !== undefined && args.expires_at !== row.expires_at) {
        patch.expires_at = args.expires_at;
        changed.push("expires_at");
      }
      if (args.min_cart_value !== undefined && args.min_cart_value !== row.min_cart_value) {
        if (args.min_cart_value < 0 || !Number.isInteger(args.min_cart_value)) {
          throw new Error("MIN_INVALID");
        }
        patch.min_cart_value = args.min_cart_value;
        changed.push("min_cart_value");
      }
      if (args.max_redemptions !== undefined && args.max_redemptions !== row.max_redemptions) {
        if (!Number.isInteger(args.max_redemptions) || args.max_redemptions < 1) {
          throw new Error("MAX_INVALID");
        }
        if (args.max_redemptions < row.used_count) throw new Error("MAX_BELOW_USED");
        patch.max_redemptions = args.max_redemptions;
        changed.push("max_redemptions");
      }
      if (changed.length > 0) {
        await ctx.db.patch(args.voucherId, patch);
        await logAudit(ctx, {
          actor_id: mgrId,
          action: "voucher.edited",
          entity_type: "pos_vouchers",
          entity_id: args.voucherId,
          source: "booth_inline",
          device_id: deviceId,
          metadata: { fields_changed: changed },
        });
      }
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

/**
 * Soft-delete a voucher. Sets `active:false`; preserves all
 * `pos_voucher_redemptions` rows (refund / audit trails depend on the
 * historical voucher row remaining intact — ADR-008 refunds-as-rows applies
 * transitively to voucher provenance).
 *
 * Manager-session-gated (no PIN) per CLAUDE.md rule #22: archival is a
 * low-stakes config edit. To "change" a voucher's value, archive and recreate
 * — `value` is birth-immutable (ADR-010 voucher static-by-design).
 *
 * Idempotent-by-state: second archive on an already-inactive voucher is a
 * true no-op (no second audit row). Uses the same withIdempotency +
 * authCheck pattern as updateVoucherMeta (rule #20).
 */
export const archiveVoucher = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    voucherId: v.id("pos_vouchers"),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      voucherId: Id<"pos_vouchers">;
    },
    { ok: true }
  >(
    "vouchers.archiveVoucher",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      const row = await ctx.db.get(args.voucherId);
      if (!row) throw new Error("VOUCHER_NOT_FOUND");
      if (row.active === false) return { ok: true as const }; // no-op
      await ctx.db.patch(args.voucherId, { active: false });
      await logAudit(ctx, {
        actor_id: mgrId,
        action: "voucher.deactivated",
        entity_type: "pos_vouchers",
        entity_id: args.voucherId,
        source: "booth_inline",
        device_id: deviceId,
      });
      return { ok: true as const };
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});
