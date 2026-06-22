import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { validateVoucherAgainst } from "../lib/voucherValidate";
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
 *
 * v2.0 Stream 5: when sessionId is provided, resolves outlet_id and uses the
 * by_outlet_active_expires index. Falls back to the legacy unscoped index
 * (migration-window tolerance — Task 12 enforces the hard gate).
 */
export const getActiveVouchers = query({
  args: { sessionId: v.optional(v.id("staff_sessions")) },
  handler: async (ctx, args): Promise<Doc<"pos_vouchers">[]> => {
    const now = Date.now();
    // Resolve outlet from session when provided (migration-tolerant window).
    let outletId: import("../_generated/dataModel").Id<"outlets"> | undefined;
    if (args.sessionId) {
      const s = await ctx.db.get(args.sessionId);
      if (s && s.ended_at == null) {
        let oid = s.outlet_id as import("../_generated/dataModel").Id<"outlets"> | undefined;
        if (!oid) {
          // Route through outlets.internal (ADR-034: outlets table owned by outlets module).
          const def = await ctx.runQuery(
            internal.outlets.internal._getDefaultOutlet_internal,
            {},
          );
          oid = def?._id;
        }
        outletId = oid;
      }
    }
    const rows = outletId
      ? await ctx.db
          .query("pos_vouchers")
          .withIndex("by_outlet_active_expires", (q) => q.eq("outlet_id", outletId).eq("active", true))
          .collect()
      : // eslint-disable-next-line frollie-internal/index-leads-with-outlet_id -- scoped via sessionId in Task 10; undefined outletId means no session provided (catalog offline-cache call without session)
        await ctx.db
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
    // v2.0 Stream 5: by_code is a legacy index; we keep it here because
    // validateVoucher is a session-less query (no sessionId arg) — outlet
    // scoping for this query migrates in a follow-up once a sessionId arg
    // is added to the FE caller. by_code survives Task 12 as a fallback.
    // eslint-disable-next-line frollie-internal/index-leads-with-outlet_id -- scoped via sessionId in Task 10 (session-less query; no outletId available at live-UX validation call site)
    const voucher = await ctx.db
      .query("pos_vouchers")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .first();
    // Delegate to the shared V8-safe helper so this BE query, commitCart's
    // re-validation, and the FE offline fallback cannot drift on reason codes
    // or boundary semantics (ADR-009). Server time wins (rule #15).
    return validateVoucherAgainst(voucher, args.cartSubtotal, Date.now());
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

/**
 * List ALL vouchers (active + archived) for the /mgr/vouchers admin UI.
 * Manager-session-gated. Unlike `getActiveVouchers` (booth cart-build cache),
 * this surfaces archived rows so managers can audit historical voucher
 * configuration. The UI groups by `active` status; backend returns the raw
 * set.
 */
export const listAllVouchers = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<Doc<"pos_vouchers">[]> => {
    await requireManagerSession(ctx, args.sessionId);
    return await ctx.db.query("pos_vouchers").collect();
  },
});

/**
 * Per-voucher redemption history for the manager UI. Manager-session-gated.
 * Bounded at 500 (default 50) — `pos_voucher_redemptions` is unbounded over
 * time so we cap the page size on the backend. Returns rows newest-first.
 *
 * Cross-module read via internal query (ADR-034): annotates each row with
 * `receipt_number` from `pos_transactions` through
 * `internal.transactions.internal._fetchReceiptByTxnIds_internal` rather
 * than reading the transactions table directly. The receipt may be `null`
 * for cancelled/draft transactions (no `receipt_number` allocated until
 * `_confirmPaid`).
 */
export const getVoucherRedemptions = query({
  args: {
    sessionId: v.id("staff_sessions"),
    voucherId: v.id("pos_vouchers"),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{
    _id: Id<"pos_voucher_redemptions">;
    transaction_id: Id<"pos_transactions">;
    code_snapshot: string;
    discount_amount: number;
    redeemed_at: number;
    receipt_number: string | null;
  }>> => {
    const { outlet_id } = await requireManagerSession(ctx, args.sessionId);
    const limit = args.limit ?? 50;
    if (limit < 1 || limit > 500) throw new Error("LIMIT_OUT_OF_RANGE");
    const redemptions = await ctx.db
      .query("pos_voucher_redemptions")
      .withIndex("by_outlet_voucher", (q) =>
        q.eq("outlet_id", outlet_id).eq("voucher_id", args.voucherId),
      )
      .order("desc")
      .take(limit);
    const receipts = await ctx.runQuery(
      internal.transactions.internal._fetchReceiptByTxnIds_internal,
      { txnIds: redemptions.map((r) => r.transaction_id) },
    );
    return redemptions.map((r) => ({
      _id: r._id,
      transaction_id: r.transaction_id,
      code_snapshot: r.code_snapshot,
      discount_amount: r.discount_amount,
      redeemed_at: r.redeemed_at,
      receipt_number: receipts[r.transaction_id] ?? null,
    }));
  },
});
