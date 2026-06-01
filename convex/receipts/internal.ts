import { internalMutation, internalQuery, QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { renderReceipt, type ReceiptViewModel } from "./template";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // ADR-022

// Hardcoded business identity until v0.5.3 receipt-config UI. The pos_settings
// table is owned by the settings module but does not yet expose these fields;
// PR-future revisits when settings/internal exposes a getter.
const RECEIPT_SETTINGS = {
  business_name: "FROLLIE",
  address: "Pakuwon Mall, Surabaya",
  contact: "+62 821-xxxx-xxxx · frollie.id",
  instagram_handle: "@frollie.id",
} as const;

/**
 * Map a pos_xendit_invoices row to a human-readable payment_method label.
 * Defined here so receipts owns the surface-facing wording; payments owns the
 * row shape ("QRIS" | "BCA_VA").
 */
function humanMethodFromInvoice(inv: { method: "QRIS" | "BCA_VA" }): string {
  return inv.method === "QRIS" ? "QRIS" : "BCA VA";
}

/**
 * Build a ReceiptViewModel from a txn + lines + the active payment invoice.
 * Shared between _buildViewModel_internal (id-keyed) and the by-token render
 * path so we never re-fetch lines after a token resolves to a txn.
 *
 * Throws PAID_TXN_MISSING_PAID_AT on the data-corruption case where a paid
 * row has no paid_at (status guard upstream ensures status === "paid").
 */
async function buildVmFromTxnWithLines(
  ctx: QueryCtx,
  txnWithLines: {
    txn: {
      _id: import("../_generated/dataModel").Id<"pos_transactions">;
      receipt_number?: string;
      paid_at?: number;
      subtotal: number;
      voucher_code_snapshot?: string;
      voucher_discount: number;
      total: number;
    };
    lines: Array<{
      product_name_snapshot: string;
      qty: number;
      unit_price_snapshot: number;
      line_subtotal: number;
      refunded_qty?: number;
    }>;
  },
): Promise<ReceiptViewModel | null> {
  const { txn, lines } = txnWithLines;
  if (!txn.receipt_number) return null;        // shouldn't happen for paid txns
  // Status guard upstream ensures status === "paid"; ADR-031 (server time wins)
  // + _confirmPaid_internal always set paid_at on the paid transition. A paid
  // row without paid_at = data corruption; throw rather than mask with
  // created_at and silently misdate the receipt.
  if (!txn.paid_at) throw new Error("PAID_TXN_MISSING_PAID_AT");

  // Payment method — read latest active pos_xendit_invoices via payments/internal
  // (ADR-034 — receipts must not query pos_xendit_invoices directly).
  const invoice = await ctx.runQuery(
    internal.payments.internal._getPaidInvoiceForTxn_internal,
    { transactionId: txn._id },
  );
  const payment_method = invoice ? humanMethodFromInvoice(invoice) : "—";
  const rrn = invoice?.receipt_id ?? undefined;

  // Cross-module per ADR-034 — refunds module owns pos_refunds.
  const refundRows = await ctx.runQuery(
    internal.refunds.internal._listForTransaction_internal,
    { transactionId: txn._id },
  );

  return {
    receipt_number: txn.receipt_number,
    paid_at: txn.paid_at,
    subtotal: txn.subtotal,
    voucher_code: txn.voucher_code_snapshot,
    voucher_discount: txn.voucher_discount,
    total: txn.total,
    payment_method,
    rrn,
    lines: lines.map((l) => ({
      product_name: l.product_name_snapshot,
      qty: l.qty,
      unit_price: l.unit_price_snapshot,
      line_subtotal: l.line_subtotal,
      refunded_qty: l.refunded_qty ?? 0,
    })),
    refunds: refundRows.map((r) => ({
      refund_amount: r.total_refund,
      refunded_at: r.created_at,
    })),
    settings: RECEIPT_SETTINGS,
  };
}

/**
 * Build a ReceiptViewModel from primary records. Cross-module reads route
 * through owning-module internal surfaces (ADR-034): pos_transactions +
 * pos_transaction_lines via transactions/internal, pos_xendit_invoices via
 * payments/internal. In PR A, refunds[] is always empty —
 * `_listForTransaction_internal` does not exist yet; we return [] here.
 * PR B replaces this stub with the real cross-module call.
 */
export const _buildViewModel_internal = internalQuery({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<ReceiptViewModel | null> => {
    const txnWithLines = await ctx.runQuery(
      internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
      { transactionId: args.transactionId },
    );
    if (!txnWithLines) return null;
    return await buildVmFromTxnWithLines(ctx, txnWithLines);
  },
});

export const _renderReceiptByToken_internal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ html: string } | null> => {
    const txnWithLines = await ctx.runQuery(
      internal.transactions.internal._getPaidTxnWithLinesByToken_internal,
      { token: args.token },
    );
    if (!txnWithLines) return null;
    // Inline VM build avoids a second by-id read of txn+lines (the by-token
    // helper already returned them). Keeps the by-token render path to one
    // cross-module read for txn+lines + one for invoice.
    const vm = await buildVmFromTxnWithLines(ctx, txnWithLines);
    if (!vm) return null;
    return { html: renderReceipt(vm) };
  },
});

export const _getCachedReceipt_internal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ html: string } | null> => {
    const row = await ctx.db
      .query("pos_receipt_html_cache")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!row) return null;
    if (row.expires_at <= Date.now()) return null;  // expired
    return { html: row.html };
  },
});

export const _writeCacheEntry_internal = internalMutation({
  args: { token: v.string(), html: v.string() },
  handler: async (ctx, args) => {
    // Idempotent upsert: delete prior entry (if any) then insert. Convex serialises
    // per-document writes; the delete+insert is atomic within the mutation.
    const existing = await ctx.db
      .query("pos_receipt_html_cache")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("pos_receipt_html_cache", {
      token: args.token,
      html: args.html,
      expires_at: Date.now() + CACHE_TTL_MS,
    });
  },
});

/**
 * Purge a cached receipt by transaction id.
 *
 * PR B: real implementation. Called by `_commitRefund_internal` to invalidate
 * the cached "LUNAS" receipt HTML after a refund commit so the next /r/<token>
 * fetch regenerates with the up-to-date refund block.
 *
 * Cross-module read for the txn routes through transactions/internal per
 * ADR-034. The aggregate helper status-guards to paid txns — a refund commit
 * on a missing or non-paid row is a data-integrity violation; let it bubble.
 * Reading pos_receipt_html_cache directly is intra-module (receipts owns the
 * table) and needs no allowlist exemption.
 */
export const _purgeReceiptCache_internal = internalMutation({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(
      internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
      { transactionId: args.transactionId },
    );
    if (!result) {
      throw new Error(`PURGE_TXN_NOT_PAID — refund commit on missing or non-paid txn ${args.transactionId}; investigate`);
    }
    if (!result.txn.receipt_token) {
      // N3: pre-v0.5.1 paid txns lack receipt_token (the field was added in PR A).
      // Refunds against them have nothing to purge — receipts have no cache entry
      // to invalidate. Return silently rather than aborting the entire refund
      // transaction. Lazy-mint isn't necessary here because no receipt has been
      // rendered for these txns; the customer never had a URL.
      //
      // Loud-throw intent (catch _confirmPaid token-mint drift) is preserved by
      // the v0.5.1+ invariant: every _confirmPaid mints a receipt_token, so any
      // post-deploy paid row without one is a different bug surfaced elsewhere
      // (transactions/__tests__/confirm-paid-token.test.ts asserts the mint).
      return;
    }
    // Delete the cached HTML row if it exists. If not, no-op — the next
    // /r/<token> request will regenerate fresh.
    const cached = await ctx.db
      .query("pos_receipt_html_cache")
      .withIndex("by_token", (q) => q.eq("token", result.txn.receipt_token!))
      .unique();
    if (cached) await ctx.db.delete(cached._id);
  },
});

/**
 * Lazy-mint a receipt token for a transaction that lacks one (pre-v0.5.1 row).
 *
 * Dormant in v0.5.1 — no surface invokes this. v0.5.3 history view's "re-send
 * receipt" surface will be the first caller. AUTH-GATE CONTRACT: the helper
 * does NOT verify the actor's session. Callers MUST verify a staff session
 * before invoking and pass the resolved staffId as `actor` so the audit row
 * captures provenance.
 *
 * STATUS-GATE CONTRACT: minting a receipt token for a non-paid txn would leak
 * a viewable receipt URL for a sale that hasn't actually completed (draft /
 * awaiting_payment / cancelled). The helper throws TXN_NOT_PAID rather than
 * minting; callers (v0.5.3+ "resend receipt" surfaces) must ensure the txn is
 * paid before invoking.
 *
 * Cross-module write boundary (ADR-034): pos_transactions is transactions-owned,
 * so existence check + CSPRNG mint + patch + audit all live in
 * transactions._ensureReceiptTokenForPaidTxn_internal. This wrapper is a thin
 * facade so future direct callers of the owning-module helper get identical
 * behaviour without re-implementing the mint decision.
 */
export const _lazyMintReceiptToken_internal = internalMutation({
  args: { transactionId: v.id("pos_transactions"), actor: v.id("staff") },
  handler: async (ctx, args): Promise<{ token: string }> => {
    // Thin facade — the owning module (transactions) handles existing-token
    // check, CSPRNG mint, patch, AND audit emit in one mutation. Keeps the
    // ADR-034 boundary clean (pos_transactions writes stay in transactions/)
    // and ensures every direct caller of _ensureReceiptTokenForPaidTxn_internal
    // gets a consistent audit row on mint without re-implementing it.
    const result = await ctx.runMutation(
      internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal,
      { transactionId: args.transactionId, actor: args.actor, isLazy: true },
    );
    return { token: result.token };
  },
});
