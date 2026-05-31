import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { renderReceipt, type ReceiptViewModel } from "./template";
import { mintUrlSafeToken } from "../lib/tokens";
import { logAudit } from "../audit/internal";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // ADR-022

/**
 * Build a ReceiptViewModel from primary records. Cross-module reads use the
 * owning module's internal surface (ADR-034). In PR A, refunds[] is always
 * empty — `_listForTransaction_internal` does not exist yet; we return [] here.
 * PR B replaces this stub with the real cross-module call.
 */
export const _buildViewModel_internal = internalQuery({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<ReceiptViewModel | null> => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) return null;
    if (txn.status !== "paid") return null;        // status guard: only paid txns get receipts
    if (!txn.receipt_number) return null;          // shouldn't happen for paid txns

    const lines = await ctx.db
      .query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.transactionId))
      .collect();

    // Cross-module: settings (TODO: pos_settings is owned by settings module — use settings/internal once exposed).
    // For PR A, hardcode the values; PR B revisits if settings/internal helper exists.
    const settings = {
      business_name: "FROLLIE",
      address: "Pakuwon Mall, Surabaya",
      contact: "+62 821-xxxx-xxxx · frollie.id",
      instagram_handle: "@frollie.id",
    };

    // Payment method — read latest pos_xendit_invoices for this txn.
    // Cross-module via payments/internal would be cleaner; for PR A scope,
    // direct query is acceptable since payments/internal does not yet expose
    // a "latest invoice for txn" helper. Flag for PR B follow-up if it grows.
    // For now: hardcode "QRIS" — PR B (or a follow-up) wires the real source.
    const payment_method = "QRIS";

    return {
      receipt_number: txn.receipt_number,
      paid_at: txn.paid_at ?? txn.created_at,
      subtotal: txn.subtotal,
      voucher_code: txn.voucher_code_snapshot,
      voucher_discount: txn.voucher_discount,
      total: txn.total,
      payment_method,
      lines: lines.map((l) => ({
        product_name: l.product_name_snapshot,
        qty: l.qty,
        unit_price: l.unit_price_snapshot,
        line_subtotal: l.line_subtotal,
        refunded_qty: (l as { refunded_qty?: number }).refunded_qty ?? 0,        // optional per spec C1 — PR B adds the field; PR A reads via shape cast
      })),
      refunds: [],                                 // PR A: always empty (no refunds module yet)
      settings,
    };
  },
});

export const _renderReceiptByToken_internal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ html: string } | null> => {
    const txn = await ctx.db
      .query("pos_transactions")
      .withIndex("by_receipt_token", (q) => q.eq("receipt_token", args.token))
      .unique();
    if (!txn) return null;
    if (txn.status !== "paid") return null;        // status guard: only paid txns get receipts

    const vm = await ctx.runQuery(internal.receipts.internal._buildViewModel_internal, {
      transactionId: txn._id,
    });
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
 * PR A: NO-OP — no callers in PR A (refunds module doesn't exist yet). PR B
 * replaces this body with assertion-throw behaviour: if !txn.receipt_token,
 * throw PURGE_NO_TOKEN; else delete cache entry for that token. Stubbed here
 * so the type surface is stable when refunds/internal calls it in PR B.
 */
export const _purgeReceiptCache_internal = internalMutation({
  args: { transactionId: v.id("pos_transactions") },
  handler: async () => {
    // PR A stub. PR B replaces with real cache-purge by txn lookup. Throwing
    // ensures any premature wire-up from refunds/internal fails CI loud rather
    // than leaving a stale "LUNAS" receipt cached for 24h post-refund.
    throw new Error("_purgeReceiptCache_internal: PR A stub — PR B replaces");
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
 * V8-safe: `mintUrlSafeToken` is implemented with Web Crypto so this mutation
 * can mint + patch + audit in a single transaction (no internalAction hop).
 */
export const _lazyMintReceiptToken_internal = internalMutation({
  args: { transactionId: v.id("pos_transactions"), actor: v.id("staff") },
  handler: async (ctx, args): Promise<{ token: string }> => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "paid") throw new Error("TXN_NOT_PAID");
    if (txn.receipt_token) {
      // Already minted — return existing (idempotent).
      return { token: txn.receipt_token };
    }
    const token = mintUrlSafeToken();
    await ctx.db.patch(args.transactionId, { receipt_token: token });
    await logAudit(ctx, {
      actor_id: args.actor,
      action: "receipt.token_minted",
      entity_type: "pos_transactions",
      entity_id: args.transactionId,
      source: "booth_inline",
      metadata: { lazy: true },
    });
    return { token };
  },
});
