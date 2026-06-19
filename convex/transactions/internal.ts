import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id, Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";
import { wibYear } from "../lib/time";
import { mintUrlSafeToken } from "../lib/tokens";
import { NEG_STOCK, VOUCHER_OVER_REDEEMED, PAYMENT_AMOUNT_MISMATCH, withFlag } from "./flags";
import type { DayTxn } from "./lib";
import { instrumentFromInvoice } from "../payments/internal";
import { refundStatus } from "../refunds/lib";
import { encodeCursor } from "../lib/apiCursor";

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

    // v1.0.1: live sales ticker → Managers. Scheduled (not inline) so a
    // Telegram failure runs in its own transaction and can never roll back the
    // paid sale. The status === "paid" guard above guarantees this branch runs
    // once per txn → exactly one ticker fires. Toggle/role checks live in
    // sendTxnTicker itself.
    await ctx.scheduler.runAfter(0, internal.telegram.txnTicker.sendTxnTicker, {
      txnId: args.txnId,
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
 * Capability check + write + audit for the receipts module's lazy-mint flow.
 * Owns the entire mint decision so any caller (receipts wrapper today, future
 * "resend receipt" surfaces) gets identical behaviour without re-implementing
 * the existing-token check, the CSPRNG hop, or the audit emit.
 *
 * Returns:
 *   { status: "exists", token } — txn already had a token (no audit row, no
 *                                  wasted CSPRNG bytes; idempotent re-call safe)
 *   { status: "minted", token } — fresh mint + patch + audit
 *
 * Throws TXN_NOT_FOUND / TXN_NOT_PAID. The receipts wrapper translates these
 * into the same errors it has always thrown so external surfaces are stable.
 * Boundary (ADR-034): pos_transactions is transactions-owned, so receipts
 * routes the patch through here rather than calling ctx.db.patch directly.
 *
 * `actor` carries provenance for the audit row. `isLazy` controls the audit
 * metadata flag (lazy=true via _lazyMintReceiptToken_internal; lazy=false
 * reserved for an inline mint path if one is ever added — _confirmPaid mints
 * directly and audits via "payment.confirmed", so this stays unused for now).
 */
export const _ensureReceiptTokenForPaidTxn_internal = internalMutation({
  args: {
    transactionId: v.id("pos_transactions"),
    actor: v.id("staff"),
    isLazy: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: "exists" | "minted"; token: string }> => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "paid") throw new Error("TXN_NOT_PAID");
    if (txn.receipt_token) {
      // Idempotent: no audit, no CSPRNG bytes wasted.
      return { status: "exists" as const, token: txn.receipt_token };
    }
    // Fresh mint: generate token AFTER the existing-token check so a same-row
    // retry doesn't burn entropy. CSPRNG (Web Crypto) is V8-safe.
    const token = mintUrlSafeToken();
    await ctx.db.patch(args.transactionId, { receipt_token: token });
    await logAudit(ctx, {
      actor_id: args.actor,
      action: "receipt.token_minted",
      entity_type: "pos_transactions",
      entity_id: args.transactionId,
      source: "booth_inline",
      metadata: { lazy: args.isLazy ?? true },
    });
    return { status: "minted" as const, token };
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

/**
 * List paid transactions since a UTC epoch ms threshold. Used by refunds/public
 * `listTodaysRefundable` (Q1=B contract: paid txns from 00:00 WIB today; older
 * txns unreachable in v0.5.1). Returns newest-first via the by_status_paid_at
 * index so the refund picker shows recently paid rows at the top.
 *
 * Cross-module read surface (ADR-034): pos_transactions is transactions-owned;
 * refunds/public routes here rather than querying directly.
 */
export const _listPaidTxnsSince_internal = internalQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, args): Promise<Doc<"pos_transactions">[]> => {
    return await ctx.db
      .query("pos_transactions")
      .withIndex("by_status_paid_at", (q) =>
        q.eq("status", "paid").gte("paid_at", args.sinceMs),
      )
      .order("desc")
      .collect();
  },
});

/**
 * Single day read used by v0.5.3a's three public queries
 * (listDayTransactions, dashboardSummary). Resolves:
 *   - paid txns in the [dayStartMs, dayEndMs) window via by_status_created
 *   - their lines + refunds total (single sum per txn)
 *   - the active Xendit payment instrument (qris / bca_va / unknown)
 *   - the staff name (one upfront staff lookup avoids N+1)
 *
 * Cross-module reads route through owning-module internals per ADR-034:
 *   pos_xendit_invoices → payments._getPaidInvoiceForTxn_internal
 *                         (normalised to instrument via instrumentFromInvoice)
 *   staff (name lookup) → auth._listStaffNames_internal
 *   pos_refunds          → refunds._listForTransaction_internal (verified
 *                          signature: { transactionId } → Doc<"pos_refunds">[];
 *                          field for refund total per row is `total_refund`)
 *
 * Does NOT gate role — callers (T5/T6) resolve session+role and decide which
 * day window to pass.
 */
export const _fetchDayWindow_internal = internalQuery({
  args: { dayStartMs: v.number(), dayEndMs: v.number() },
  handler: async (ctx, args): Promise<DayTxn[]> => {
    // Window by paid_at (not created_at) so cross-midnight late confirmations
    // land in the day they paid, matching _dailySalesSummary_internal (founders
    // shift-summary). created_at would silently drop carts opened on day N and
    // paid past midnight on day N+1.
    const txns = await ctx.db
      .query("pos_transactions")
      .withIndex("by_status_paid_at", (q) =>
        q.eq("status", "paid").gte("paid_at", args.dayStartMs).lt("paid_at", args.dayEndMs),
      )
      .order("desc")
      .collect();

    // Staff names up front (small set) → Map to avoid N+1.
    const staffNames = await ctx.runQuery(internal.auth.internal._listStaffNames_internal, {});
    const nameById = new Map(staffNames.map((s) => [String(s._id), s.name]));

    const out: DayTxn[] = [];
    for (const t of txns) {
      // Three independent reads given t._id — fire in parallel to shave per-txn
      // latency. Refunds total via refunds._listForTransaction_internal (same
      // helper the receipts template uses; per-row amount on `total_refund`).
      // Invoice via payments._getPaidInvoiceForTxn_internal + the pure
      // instrumentFromInvoice normaliser (v0.5.3a consolidation — the previous
      // _instrumentForTxn_internal was identical SQL).
      const [lines, refundRows, invoice] = await Promise.all([
        ctx.db
          .query("pos_transaction_lines")
          .withIndex("by_transaction", (q) => q.eq("transaction_id", t._id))
          .collect(),
        ctx.runQuery(
          internal.refunds.internal._listForTransaction_internal,
          { transactionId: t._id },
        ),
        ctx.runQuery(
          internal.payments.internal._getPaidInvoiceForTxn_internal,
          { transactionId: t._id },
        ),
      ]);
      const refundsTotal = refundRows.reduce((s, r) => s + r.total_refund, 0);
      const instrument = instrumentFromInvoice(invoice);

      // M2: ?? on invariant-guaranteed fields = silent corruption (MEMORY).
      // Staff are soft-deleted (active:false), never hard-deleted, so a
      // missing staff name means the staff row was hard-deleted out from
      // under a transaction — failing loud surfaces the corruption.
      const staffName = nameById.get(String(t.staff_id));
      if (!staffName) {
        throw new Error(
          `STAFF_MISSING_FOR_TXN — txn ${t._id} references staff ${t.staff_id} which is not in pos_staff`,
        );
      }

      // Pre-compute the refund badge here (BE) so the FE history list doesn't
      // re-import `refundStatus` from `refunds/lib`. `refundStatus` only reads
      // `qty` + `refunded_qty` from each line, both of which are already in the
      // DayLine projection — zero extra cost.
      const lineProjection = lines.map((l) => ({
        product_code_snapshot: l.product_code_snapshot,
        product_name_snapshot: l.product_name_snapshot,
        qty: l.qty,
        refunded_qty: l.refunded_qty,
      }));
      const hasRefunds = refundRows.length > 0;

      out.push({
        _id: t._id,
        created_at: t.created_at,
        // status === "paid" guarantees paid_at is set (_confirmPaid stamps it
        // server-side, ADR-031). The bang is invariant-backed.
        paid_at: t.paid_at!,
        total: t.total,
        subtotal: t.subtotal,
        voucher_discount: t.voucher_discount,
        voucher_code_snapshot: t.voucher_code_snapshot,
        staff_id: t.staff_id,
        staff_name: staffName,
        instrument,
        flags: t.flags,
        lines: lineProjection,
        refundsTotal,
        hasRefunds,
        refundStatus: refundStatus(lineProjection, hasRefunds),
      });
    }
    return out;
  },
});

/**
 * Patch a transaction line's refunded_qty (additive). Owned by the transactions
 * module because pos_transaction_lines is transactions-owned per ADR-034; the
 * refunds module routes here via ctx.runMutation when committing a refund.
 *
 * Mirrors the _setCurrentInvoice_internal pattern (payments → transactions).
 * Same Convex transaction as the caller, so the refund-row insert + this patch
 * commit atomically.
 *
 * Throws LINE_NOT_FOUND if the line was deleted between read and patch (should
 * be impossible — lines are append-only post-confirm — but failing loud is
 * preferable to a silent no-op that drifts refunded_qty from the refunds rows).
 */
export const _patchLineRefundedQty_internal = internalMutation({
  args: {
    lineId: v.id("pos_transaction_lines"),
    addQty: v.number(),
  },
  handler: async (ctx, args) => {
    const line = await ctx.db.get(args.lineId);
    if (!line) throw new Error("LINE_NOT_FOUND");
    await ctx.db.patch(args.lineId, {
      refunded_qty: (line.refunded_qty ?? 0) + args.addQty,
    });
  },
});

/**
 * Batch-fetch receipt_number for an array of transaction ids.
 * Used by vouchers.getVoucherRedemptions to annotate redemption rows.
 * Returns null for ids that don't exist or aren't paid (no receipt_number).
 * ADR-034: vouchers reads transactions through this internal query, never
 * directly.
 */
export const _fetchReceiptByTxnIds_internal = internalQuery({
  args: { txnIds: v.array(v.id("pos_transactions")) },
  handler: async (ctx, args): Promise<Record<string, string | null>> => {
    const out: Record<string, string | null> = {};
    for (const id of args.txnIds) {
      const t = await ctx.db.get(id);
      out[id] = t?.receipt_number ?? null;
    }
    return out;
  },
});

/**
 * SEC-05: full-row read for SYSTEM callers (payment/transaction actions) — the
 * public `getById` is now session-gated + projected (strips receipt_token), so
 * server-side callers that need the raw Doc must use this internal variant.
 * Returns the full txn + lines, no projection, no auth (internal-only).
 */
export const _getTxnById_internal = internalQuery({
  args: { txnId: v.id("pos_transactions") },
  handler: async (
    ctx,
    args,
  ): Promise<(Doc<"pos_transactions"> & { lines: Doc<"pos_transaction_lines">[] }) | null> => {
    const txn = await ctx.db.get(args.txnId);
    if (!txn) return null;
    const lines = await ctx.db
      .query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
      .collect();
    return { ...txn, lines };
  },
});

/**
 * v1.0.1: Minimal txn read for the sales ticker. Returns only the fields
 * sendTxnTicker needs — avoids pulling the entire txn+lines object through
 * the action boundary. Returns null if txn is absent or not yet paid (the
 * ticker fires on a 0-ms delay; the status guard is a safety net).
 */
export const _getTxnForTicker_internal = internalQuery({
  args: { txnId: v.id("pos_transactions") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    receipt_number: string;
    total: number;
    paid_at: number;
    staff_id: Id<"staff">;
    confirmed_via: "webhook" | "polling" | "manual" | null;
    lines: Array<{ name: string; qty: number }>;
  } | null> => {
    const txn = await ctx.db.get(args.txnId);
    if (!txn || txn.status !== "paid") return null;
    const lineRows = await ctx.db
      .query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
      .collect();
    return {
      receipt_number: txn.receipt_number ?? "—",
      total: txn.total,
      // paid_at is set alongside status="paid" in _confirmPaid (ADR-031), so the
      // status guard above makes it present — assert rather than invent a time.
      paid_at: txn.paid_at!,
      staff_id: txn.staff_id,
      confirmed_via: txn.confirmed_via ?? null,
      lines: lineRows.map((l) => ({ name: l.product_name_snapshot, qty: l.qty })),
    };
  },
});

// ---------------------------------------------------------------------------
// Public API v1 — refunds batch join resolver
// ---------------------------------------------------------------------------

/**
 * Resolve transaction receipt_number + line product codes for a batch of
 * refunds in ONE cross-module call. Callers (refunds._listRefundsForApi_internal)
 * pass every refund on the page at once; we loop here rather than exposing an
 * N-call surface.
 *
 * A single unresolvable refund (txn missing/not-paid, or a line missing) returns
 * `ok: false` and is skipped by the caller — it must NEVER 500 the whole page.
 * refundKey is the caller's per-refund key (typically `r._id`) so it can map
 * results back without positional coupling.
 */
export const _resolveRefundLinesForApiBatch_internal = internalQuery({
  args: {
    items: v.array(v.object({
      refundKey: v.string(),
      transactionId: v.id("pos_transactions"),
      lines: v.array(v.object({
        line_id: v.id("pos_transaction_lines"),
        qty: v.number(),
        refund_amount: v.number(),
      })),
    })),
  },
  handler: async (ctx, args): Promise<Array<{
    refundKey: string; ok: boolean;
    receiptNumber?: string; lines?: Array<{ productCode: string; qty: number; refundAmount: number }>;
  }>> => {
    const out = [];
    for (const item of args.items) {
      const txn = await ctx.db.get(item.transactionId);
      if (!txn?.receipt_number) { out.push({ refundKey: item.refundKey, ok: false }); continue; }
      const lines = [];
      let bad = false;
      for (const l of item.lines) {
        const tl = await ctx.db.get(l.line_id);
        if (!tl) { bad = true; break; }
        lines.push({ productCode: tl.product_code_snapshot, qty: l.qty, refundAmount: l.refund_amount });
      }
      if (bad) { out.push({ refundKey: item.refundKey, ok: false }); continue; }
      out.push({ refundKey: item.refundKey, ok: true, receiptNumber: txn.receipt_number, lines });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Public API v1 — transactions feed
// ---------------------------------------------------------------------------

/**
 * Shape of a single row emitted by the Public API transactions feed.
 * All money is integer rupiah (ADR-015). Fields are camelCase to match the
 * JSON contract. Snapshots are served directly — never re-join lines → products.
 */
export type ApiTxnRow = {
  receiptNumber: string;
  paidAt: number;
  subtotal: number;
  voucherCode: string | null;
  voucherDiscount: number;
  total: number;
  staffCode: string;
  lines: Array<{
    productCode: string;
    productName: string;
    qty: number;
    unitPrice: number;
    lineSubtotal: number;
    taxRate: number;
  }>;
};

/**
 * Paginated feed of paid transactions for the Public API (GET /api/v1/transactions).
 *
 * Cursor semantics: (afterPaidAtMs, afterCreationTime) represent the last row
 * of the previous page. Rows with (paid_at, _creationTime) strictly greater
 * than the cursor are returned, ascending by paid_at.
 *
 * Tiebreak correctness: paid_at is a server timestamp — multiple transactions
 * can share the exact same ms. We over-fetch (limit*2+1) from gte(paid_at)
 * then filter `strictlyAfter` by (paid_at, _creationTime) > cursor so we never
 * re-emit a row from the previous page, even when several transactions share
 * the same paid_at ms.
 *
 * N+1 avoidance: staffCodes resolved once via _listStaffCodes_internal → Map.
 * Lines are fetched per-txn (small page — max 500) via the by_transaction index.
 *
 * Cross-module reads (ADR-034):
 *   staff codes → auth._listStaffCodes_internal (never direct ctx.db on staff)
 */
export const _listPaidTxnsForApi_internal = internalQuery({
  args: {
    afterPaidAtMs: v.optional(v.number()),
    afterCreationTime: v.optional(v.number()),
    // CONTRACT §6a date filtering: inclusive-lower / exclusive-upper paid_at
    // bounds. Composes with the cursor — the effective lower bound is
    // max(cursor watermark, fromMs) so a window can be paged.
    fromMs: v.optional(v.number()),
    toMs: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<{ rows: ApiTxnRow[]; nextCursor: string | null }> => {
    const limit = Math.min(Math.max(args.limit, 1), 500);
    const after = args.afterPaidAtMs;

    // Effective lower bound = max(cursor watermark, fromMs). The cursor advances
    // the window forward across pages; fromMs clamps it to the caller's window.
    const lo = Math.max(after ?? -Infinity, args.fromMs ?? -Infinity);
    const hasLo = after !== undefined || args.fromMs !== undefined;
    const hi = args.toMs;

    // Ascending scan of paid rows from the watermark. Over-fetch by limit*2+1
    // to provide headroom for same-ms tiebreak filtering without losing rows.
    // _creationTime is the implicit tiebreak; rows at the exact watermark ms
    // are filtered by (paidAt, _creationTime) > cursor in strictlyAfter below.
    // toMs (exclusive) is bounded at the index so over-fetch stays in-window.
    const candidates = await ctx.db
      .query("pos_transactions")
      .withIndex("by_status_paid_at", (q) => {
        const base = q.eq("status", "paid");
        if (hasLo && hi !== undefined) return base.gte("paid_at", lo).lt("paid_at", hi);
        if (hasLo) return base.gte("paid_at", lo);
        if (hi !== undefined) return base.lt("paid_at", hi);
        return base;
      })
      .order("asc")
      // 2x+1 over-fetch: worst case up to `limit` same-ms stragglers at the cursor watermark get filtered out by strictlyAfter, so fetch headroom to still fill a full page + detect a next one.
      .take(limit * 2 + 1);

    // Filter to rows strictly after the cursor. When no cursor is given (first
    // page), all candidates pass. When a cursor is given, rows at the exact
    // watermark ms are disambiguated by _creationTime.
    const strictlyAfter = candidates.filter((t) => {
      if (after === undefined) return true;
      if (t.paid_at! > after) return true;
      // equal ms → compare _creationTime
      return t._creationTime > (args.afterCreationTime ?? -Infinity);
    });

    const page = strictlyAfter.slice(0, limit);

    // I2: skip the staff table scan when this page is empty — there are no
    // staff codes to resolve and no rows to emit, so nextCursor is trivially null.
    if (page.length === 0) return { rows: [], nextCursor: null };

    // Resolve staffCode once (small set) → Map to avoid N+1 per txn.
    // ADR-034: transactions reads staff via an auth internal, never direct ctx.db.
    const staffCodes = await ctx.runQuery(
      internal.auth.internal._listStaffCodes_internal,
      {},
    );
    const codeByStaffId = new Map(staffCodes.map((s) => [String(s._id), s.code]));

    const rows: ApiTxnRow[] = [];
    for (const t of page) {
      const lines = await ctx.db
        .query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", t._id))
        .collect();

      const staffCode = codeByStaffId.get(String(t.staff_id));
      // status === "paid" + staff are soft-deleted (never hard-deleted), so a
      // missing code means corruption — fail loud rather than silently omit.
      if (!staffCode) throw new Error(`STAFF_CODE_MISSING_FOR_TXN ${t._id}`);

      rows.push({
        // receipt_number is set by _confirmPaid (invariant for status="paid")
        receiptNumber: t.receipt_number!,
        paidAt: t.paid_at!,
        subtotal: t.subtotal,
        voucherCode: t.voucher_code_snapshot ?? null,
        voucherDiscount: t.voucher_discount,
        total: t.total,
        staffCode,
        lines: lines.map((l) => ({
          productCode: l.product_code_snapshot,
          productName: l.product_name_snapshot,
          qty: l.qty,
          unitPrice: l.unit_price_snapshot,
          lineSubtotal: l.line_subtotal,
          taxRate: l.tax_rate_snapshot,
        })),
      });
    }

    const last = page[page.length - 1];
    const more = strictlyAfter.length > limit;
    const nextCursor =
      more && last ? encodeCursor(last.paid_at!, last._creationTime) : null;

    return { rows, nextCursor };
  },
});
