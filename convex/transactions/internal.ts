import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";
import { wibYear } from "../lib/time";
import { mintUrlSafeToken } from "../lib/tokens";
import { NEG_STOCK, VOUCHER_OVER_REDEEMED, PAYMENT_AMOUNT_MISMATCH, withFlag } from "./flags";

/**
 * Pure helper (no writes): for a cart of {productId, qty}, expand to
 * inventory_sku_id requirements via the catalog internal API, then check
 * projected on_hand via the inventory internal API. Returns true if ANY SKU
 * would go negative.
 *
 * Multi-product-same-SKU correctness (staffreview T4): a cart with Dubai 1pc +
 * Dubai 8pc shares the "dubai" SKU. We sum qtys per SKU before the projected
 * check.
 *
 * Cross-module reads go through owning-module internal queries (ADR-034):
 *   pos_product_components → catalog._getComponentsForProducts_internal
 *   pos_stock_levels       → inventory._projectedOnHand_internal
 */
export const _projectedNegStockFlag_internal = internalQuery({
  args: {
    lines: v.array(v.object({
      productId: v.id("pos_products"),
      qty: v.number(),
    })),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (args.lines.length === 0) return false;

    const productIds = args.lines.map((l) => l.productId);
    const components = await ctx.runQuery(
      internal.catalog.internal._getComponentsForProducts_internal,
      { productIds },
    );

    // Build per-SKU demand totals (multi-product-same-SKU safe)
    const perSku: Record<string, number> = {};
    for (const c of components) {
      const lineEntry = args.lines.find((l) => l.productId === c.productId);
      if (!lineEntry) continue;
      const k = c.skuId as unknown as string;
      perSku[k] = (perSku[k] ?? 0) + c.qty * lineEntry.qty;
    }

    if (Object.keys(perSku).length === 0) return false;

    const skuQtys = Object.entries(perSku).map(([skuIdStr, qty]) => ({
      skuId: skuIdStr as Id<"pos_inventory_skus">,
      qty,
    }));
    const projected = await ctx.runQuery(
      internal.inventory.internal._projectedOnHand_internal,
      { skuQtys },
    );

    for (const val of Object.values(projected)) {
      if (val < 0) return true;
    }
    return false;
  },
});

/**
 * Atomic receipt-number allocator. Returns "R-{wibYear}-{NNNN}" where the
 * year is the WIB calendar year (UTC+7, no DST) — see staffreview Critical #2
 * + convex/lib/time.ts.
 *
 * Convex optimistic concurrency handles concurrent _confirmPaid calls in the
 * same year: one retries with the updated next_number.
 */
export const _allocateReceiptNumber_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const year = wibYear(Date.now());
    const counter = await ctx.db
      .query("pos_receipt_counters")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();
    let n: number;
    if (counter) {
      n = counter.next_number;
      await ctx.db.patch(counter._id, { next_number: n + 1 });
    } else {
      n = 1;
      await ctx.db.insert("pos_receipt_counters", { year, next_number: 2 });
    }
    return `R-${year}-${String(n).padStart(4, "0")}`;
  },
});

/**
 * Set the denormalized active-invoice pointer on a transaction. Owned by the
 * transactions module because it writes pos_transactions; the payments module
 * routes here via ctx.runMutation when committing/replacing a Xendit invoice
 * (ADR-034 — payments must not write transactions' table directly). Because
 * runMutation-within-a-mutation shares the same Convex transaction, the invoice
 * insert + this pointer patch + the idempotency cache row commit atomically.
 */
export const _setCurrentInvoice_internal = internalMutation({
  args: {
    txnId: v.id("pos_transactions"),
    xenditInvoiceId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.txnId, { xendit_invoice_id_current: args.xenditInvoiceId });
  },
});

/**
 * THE FUNNEL. All confirmation paths converge here. Post-ADR-036 the live paths
 * are webhook (primary, automatic) + manual override; the "polling" source label
 * is retained for the idempotent re-fire test + any future reconciliation, but no
 * runtime polling path emits it. Idempotent via status guard: if txn is not in
 * awaiting_payment, this is a no-op. Spec §"Canonical sale data flow → THE FUNNEL".
 *
 * Steps (in order):
 *   0. Status guard (idempotent re-fire)
 *   1. Allocate receipt_number (atomic counter increment)
 *   2. Load transaction lines
 *   3. Expand lines → SKU movements via catalog internal API (ADR-034)
 *   4. Record sale movements (paid-only stock decrement, ADR-026 dedup)
 *   5. Re-check NEG_STOCK at confirm time via inventory internal API (ADR-034)
 *      Stock may have drained between commit and confirm — set flag if so.
 *   6. Redeem voucher if present (race-tolerant — loser sets VOUCHER_OVER_REDEEMED)
 *   7. Patch txn: status=paid, paid_at, confirmed_via, mgr_approver_id?, manual_reason?
 *   8. Audit log payment.confirmed with source metadata
 *
 * Cross-module reads go through owning-module internal queries (ADR-034):
 *   pos_product_components → catalog._getComponentsForProducts_internal
 *   pos_stock_levels       → inventory._getOnHandBySkus_internal (post-decrement check)
 *   pos_vouchers           → vouchers._getVoucherByCode_internal
 */
export const _confirmPaid_internal = internalMutation({
  args: {
    txnId: v.id("pos_transactions"),
    source: v.union(v.literal("webhook"), v.literal("polling"), v.literal("manual")),
    mgr_approver_id: v.optional(v.id("staff")),
    manual_reason: v.optional(v.string()),
    paid_amount: v.optional(v.number()),
    // v0.4 (Task 21): for source="manual", the caller threads the real audit
    // origin (booth_inline at the booth, telegram_approval off-booth). Omitted
    // by booth callers (payments.manuallyConfirmPayment) → defaults to
    // booth_inline. Ignored for source="webhook" / "polling".
    approvalSource: v.optional(
      v.union(v.literal("booth_inline"), v.literal("telegram_approval")),
    ),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.txnId);
    if (!txn) throw new Error("TXN_NOT_FOUND");
    // 0. Status guard.
    //   paid → idempotent re-fire (a second confirmation path arriving after the
    //   first wins); silent no-op.
    if (txn.status === "paid") return;
    if (txn.status !== "awaiting_payment") {
      // A payment confirmation arrived for a terminal, non-paid txn (e.g. the sale
      // was cancelled, but the QR/VA stayed live on Xendit's side — there is no
      // expire API for QR Codes (Decision E) — and the customer paid anyway).
      // Money may have moved with no sale record. Do NOT auto-flip (a manager
      // reconciles), but emit an alert so it isn't silently swallowed.
      await logAudit(ctx, {
        actor_id: args.mgr_approver_id ?? "system",
        action: "payment.confirmed_on_terminal",
        entity_type: "pos_transactions",
        entity_id: args.txnId,
        source:
          args.source === "manual"
            ? args.approvalSource ?? "booth_inline"
            : "system",
        reason: args.manual_reason,
        metadata: { source: args.source, txn_status: txn.status },
      });
      return;
    }

    // 1. Receipt number
    const receiptNumber = await ctx.runMutation(
      internal.transactions.internal._allocateReceiptNumber_internal,
      {},
    );

    // 2. Lines
    const lines = await ctx.db
      .query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
      .collect();

    // 3. Expand lines → SKU components via catalog internal API (ADR-034)
    const productIds = lines.map((l) => l.product_id);
    const components = await ctx.runQuery(
      internal.catalog.internal._getComponentsForProducts_internal,
      { productIds },
    );

    // Build movement entries (one per line × component) and per-SKU totals
    const movementLines: Array<{
      lineId: Id<"pos_transaction_lines">;
      skuId: Id<"pos_inventory_skus">;
      qty: number;
    }> = [];
    const perSku: Record<string, number> = {};

    for (const line of lines) {
      const lineComponents = components.filter((c) => c.productId === line.product_id);
      for (const c of lineComponents) {
        movementLines.push({
          lineId: line._id,
          skuId: c.skuId,
          qty: c.qty * line.qty,
        });
        const k = c.skuId as unknown as string;
        perSku[k] = (perSku[k] ?? 0) + c.qty * line.qty;
      }
    }

    // 4. Record movements (paid-only decrement, ADR-026 dedup)
    await ctx.runMutation(internal.inventory.internal._recordSaleMovement_internal, {
      transactionId: args.txnId, lines: movementLines,
    });

    // 5. Re-check NEG_STOCK after decrement — read current on_hand via inventory internal API
    let flags = txn.flags;
    if (Object.keys(perSku).length > 0) {
      const skuIds = Object.keys(perSku).map((k) => k as Id<"pos_inventory_skus">);
      const onHandMap = await ctx.runQuery(
        internal.inventory.internal._getOnHandBySkus_internal,
        { skuIds },
      );
      for (const onHand of Object.values(onHandMap)) {
        if (onHand < 0) {
          flags = withFlag(flags, NEG_STOCK);
          break;
        }
      }
    }

    // 5b. Amount-mismatch defense (honor + flag): the money already moved, so we
    // always confirm — but flag a mismatch for manager reconciliation. DYNAMIC
    // QR + is_closed FVA make this unlikely, but this is a money path.
    if (args.paid_amount !== undefined && args.paid_amount !== txn.total) {
      flags = withFlag(flags, PAYMENT_AMOUNT_MISMATCH);
    }

    // 6. Voucher redemption (if applicable)
    if (txn.voucher_code_snapshot && txn.voucher_discount > 0) {
      const voucher = await ctx.runQuery(
        internal.vouchers.internal._getVoucherByCode_internal,
        { code: txn.voucher_code_snapshot },
      );
      if (voucher) {
        const r = await ctx.runMutation(internal.vouchers.internal._redeemVoucher_internal, {
          voucher_id: voucher._id,
          transaction_id: args.txnId,
          code_snapshot: txn.voucher_code_snapshot,
          discount_amount: txn.voucher_discount,
        });
        if (r.overRedeemed) flags = withFlag(flags, VOUCHER_OVER_REDEEMED);
      }
    }

    // 7. Patch txn → paid (mint receipt_token here per ADR-021; V8-safe via tokens.ts Web Crypto)
    await ctx.db.patch(args.txnId, {
      status: "paid",
      receipt_number: receiptNumber,
      receipt_token: mintUrlSafeToken(),
      paid_at: Date.now(),
      confirmed_via: args.source,
      confirmed_mgr_approver_id: args.mgr_approver_id,
      confirmed_manual_reason: args.manual_reason,
      flags,
    });

    // 8. Audit (logAudit accepts mgr_approver_id, reason, device_id as top-level fields)
    await logAudit(ctx, {
      actor_id: args.mgr_approver_id ?? "system",
      action: "payment.confirmed",
      entity_type: "pos_transactions",
      entity_id: args.txnId,
      mgr_approver_id: args.mgr_approver_id,
      // v0.4 (Task 21): manual override may now originate off-booth. The caller
      // (payments._onPaidManual_internal) threads approvalSource so the audit
      // row reflects where the action actually happened: booth_inline at the
      // booth (default), telegram_approval via the off-booth approve link.
      // Non-manual paths (webhook/polling) keep source="system".
      source:
        args.source === "manual"
          ? args.approvalSource ?? "booth_inline"
          : "system",
      reason: args.manual_reason,
      metadata: { source: args.source, receipt_number: receiptNumber },
    });
  },
});

/**
 * Daily sales aggregate for the founders shift-summary cron (Task 24).
 * Accepts raw epoch-ms window bounds — the cron computes WIB day start/end
 * before calling this (ADR-034: time helpers live in lib/time.ts; aggregate
 * logic stays in the transactions module).
 *
 * paid_at is optional on the schema (set only when status → "paid").
 * Falls back to created_at when paid_at is absent (defensive, should not
 * happen for paid rows, but preserves correctness over a silent zero).
 *
 * Flags are an integer bitset (transactions/flags.ts). Any non-zero value
 * means at least one bit (NEG_STOCK, VOUCHER_OVER_REDEEMED, …) is set →
 * counts as flagged for manager review.
 */
export const _dailySalesSummary_internal = internalQuery({
  args: { dayStartMs: v.number(), dayEndMs: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ totalSalesIdr: number; txnCount: number; flaggedCount: number }> => {
    // by_status_paid_at indexes paid rows by the timestamp the summary cares
    // about (paid_at). Earlier versions used by_status_created with a 1h
    // backstop, which silently dropped cross-midnight late-paid sales (cart
    // opened day N, paid >1h into day N+1). paid_at is server-set inside
    // _confirmPaid (ADR-031), so for status="paid" rows it is always present.
    const paid = await ctx.db
      .query("pos_transactions")
      .withIndex("by_status_paid_at", (q) =>
        q
          .eq("status", "paid")
          .gte("paid_at", args.dayStartMs)
          .lt("paid_at", args.dayEndMs),
      )
      .collect();
    const totalSalesIdr = paid.reduce((s, x) => s + (x.total ?? 0), 0);
    const flaggedCount = paid.filter((x) => (x.flags ?? 0) !== 0).length;
    return { totalSalesIdr, txnCount: paid.length, flaggedCount };
  },
});

/**
 * Capability check + write for the receipts module's lazy-mint flow.
 * Returns the existing receipt_token if one is already set on a paid txn
 * (idempotent), or patches a freshly-minted token onto the row and returns it.
 *
 * Returns:
 *   { status: "exists", token } — txn already had a token
 *   { status: "minted", token } — fresh patch applied
 *
 * Throws TXN_NOT_FOUND / TXN_NOT_PAID; the receipts wrapper translates these
 * into the same errors it has always thrown so external surfaces are stable.
 * Boundary (ADR-034): pos_transactions is transactions-owned, so receipts
 * routes the patch through here rather than calling ctx.db.patch directly.
 */
export const _ensureReceiptTokenForPaidTxn_internal = internalMutation({
  args: {
    transactionId: v.id("pos_transactions"),
    newToken: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "exists" | "minted"; token: string }> => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "paid") throw new Error("TXN_NOT_PAID");
    if (txn.receipt_token) {
      return { status: "exists" as const, token: txn.receipt_token };
    }
    await ctx.db.patch(args.transactionId, { receipt_token: args.newToken });
    return { status: "minted" as const, token: args.newToken };
  },
});

/**
 * Aggregate read for the receipts module: fetch the paid transaction + its
 * lines in one cross-module call. Returns null if the txn is missing or not
 * paid (receipts module callers expect to no-op on those cases).
 *
 * This consolidates what would otherwise be a cross-module ALLOWLIST bypass
 * into the canonical "owning module exposes the aggregate" pattern per ADR-034.
 */
export const _getPaidTxnWithLinesForReceipt_internal = internalQuery({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) return null;
    if (txn.status !== "paid") return null;
    const lines = await ctx.db
      .query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.transactionId))
      .collect();
    return { txn, lines };
  },
});

/**
 * Same aggregate but keyed by the receipt_token capability. Single read of
 * pos_transactions via by_receipt_token, then lines. Used by the public
 * /r/:token httpAction so receipts can dispatch end-to-end without ever
 * touching pos_transactions or pos_transaction_lines directly.
 *
 * Uses `.first()` rather than `.unique()`: token collisions are corruption-
 * grade events (32 bytes of entropy makes them astronomically unlikely), and
 * a public route should serve the matching receipt rather than 500 on the
 * theoretical collision. "Serve the receipt that matches the token" stays
 * consistent with the capability semantics.
 */
export const _getPaidTxnWithLinesByToken_internal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const txn = await ctx.db
      .query("pos_transactions")
      .withIndex("by_receipt_token", (q) => q.eq("receipt_token", args.token))
      .first();
    if (!txn) return null;
    if (txn.status !== "paid") return null;
    const lines = await ctx.db
      .query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", txn._id))
      .collect();
    return { txn, lines };
  },
});

/**
 * Return the status + total of a transaction for approval gating.
 * Called by approvals.actions.requestManualPaymentApproval to verify the txn is
 * awaiting_payment before minting an approval request. Cross-module read kept
 * here so approvals does not read pos_transactions directly (ADR-034).
 */
export const _getTxnSummary_internal = internalQuery({
  args: { txnId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<{ status: string; total: number } | null> => {
    const t = await ctx.db.get(args.txnId);
    if (!t) return null;
    return { status: t.status, total: t.total }; // field name confirmed: `total` (schema.ts:21)
  },
});

/**
 * Internal commit for transactions.actions.cancelTransaction. Separate
 * function so the action can call it via runMutation after Xendit cancel.
 * Only valid on awaiting_payment transactions — throws INVALID_STATE_FOR_CANCEL
 * otherwise (guards against double-cancel races at the caller).
 *
 * withIdempotency-wrapped: the status flip + audit + cache row commit in ONE
 * Convex transaction (I6 — no commit-then-cache window where a crash leaves
 * state committed but uncached). A same-key retry short-circuits on the cache row
 * before reaching the status guard, so the guard only ever fires on a genuine
 * concurrent double-cancel.
 */
export const _cancelCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    txnId: v.id("pos_transactions"),
    reason: v.string(),
    actor_staff_id: v.id("staff"),
    device_id: v.optional(v.string()),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      txnId: Id<"pos_transactions">;
      reason: string;
      actor_staff_id: Id<"staff">;
      device_id?: string;
    },
    { cancelled: true }
  >(
    "transactions.cancelTransaction",
    async (ctx, args) => {
      const txn = await ctx.db.get(args.txnId);
      if (!txn) throw new Error("TXN_NOT_FOUND");
      if (txn.status !== "awaiting_payment") {
        throw new Error("INVALID_STATE_FOR_CANCEL");
      }
      await ctx.db.patch(args.txnId, {
        status: "cancelled",
        cancelled_at: Date.now(),
        cancelled_reason: args.reason,
      });
      await logAudit(ctx, {
        actor_id: args.actor_staff_id,
        action: "transaction.cancelled",
        entity_type: "pos_transactions",
        entity_id: args.txnId,
        source: "booth_inline",
        device_id: args.device_id,
        reason: args.reason,
      });
      // C1 atomicity: cancel-invoice + cascade-deny share this mutation's
      // Convex transaction so a transient failure on either step can't
      // strand an uncancelled invoice or live approvals against a cancelled
      // txn. Matches the cancelAwaitingPayment shape.
      await ctx.runMutation(
        internal.payments.internal._cancelActiveInvoiceForTxn_internal,
        {
          txnId: args.txnId,
          cancel_reason: "txn_cancelled",
          actor_id: args.actor_staff_id,
          source: "booth_inline",
        },
      );
      await ctx.runMutation(
        internal.approvals.internal._cancelPendingManualPaymentForTxn_internal,
        { txnId: args.txnId, reason: "txn_cancelled" },
      );
      return { cancelled: true as const };
    },
  ),
});
