import { mutation, query, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { computeVoucherDiscount } from "../lib/voucher";
import { NEG_STOCK, withFlag } from "./flags";
import { wibDayWindow, WIB_OFFSET_MS } from "../lib/time";
import { computeDaySummary, type DayTxn, type DaySummary } from "./lib";
import { refundStatus, type RefundStatus } from "../refunds/lib";

/**
 * Parse a "YYYY-MM-DD" WIB label into that day's [start,end) ms window.
 * Throws INVALID_DAY for any malformed or overflow date — silent NaN math
 * would produce an empty window with no UI feedback (manager sees "no sales"
 * for a typo'd date instead of a clear error).
 */
function windowForLabel(label: string): { dayStartMs: number; dayEndMs: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) throw new Error("INVALID_DAY");
  const [y, m, d] = label.split("-").map(Number);
  // Round-trip via Date.UTC to reject overflows (e.g. "2026-02-30" → Mar 2).
  const reconstructed = new Date(Date.UTC(y, m - 1, d));
  if (
    reconstructed.getUTCFullYear() !== y ||
    reconstructed.getUTCMonth() !== m - 1 ||
    reconstructed.getUTCDate() !== d
  ) {
    throw new Error("INVALID_DAY");
  }
  const dayStartMs = Date.UTC(y, m - 1, d) - WIB_OFFSET_MS;
  return { dayStartMs, dayEndMs: dayStartMs + 86_400_000 };
}

/**
 * Resolve a sessionId to its staff + device via the auth module's internal
 * surface (ADR-034 — transactions must not read auth-owned staff_sessions
 * directly). Throws SESSION_INVALID if the session is missing or ended.
 */
async function resolveSessionStaff(
  ctx: MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string }> {
  const resolved = await ctx.runQuery(
    internal.auth.internal._resolveSession_internal,
    { sessionId },
  );
  if (!resolved) throw new Error("SESSION_INVALID");
  return resolved;
}

export const getById = query({
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

export const listDrafts = query({
  args: { sessionId: v.id("staff_sessions") },
  // Explicit return type breaks the cross-module circular inference (this handler
  // calls ctx.runQuery on the auth internal surface, which transitively references
  // the generated `internal` object). Without it tsc -b collapses to `any`.
  handler: async (ctx, args): Promise<Doc<"pos_transactions">[]> => {
    // Cross-module: resolve session via auth internal surface (ADR-034).
    const resolved = await ctx.runQuery(
      internal.auth.internal._resolveSession_internal,
      { sessionId: args.sessionId },
    );
    if (!resolved) return [];
    return await ctx.db
      .query("pos_transactions")
      .withIndex("by_staff_created", (q) => q.eq("staff_id", resolved.staffId))
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "draft"))
      .collect();
  },
});

/**
 * v0.5.3a history list. Resolves session+role:
 *  - role "manager" — may pass `day` (YYYY-MM-DD WIB); defaults to today.
 *  - role "staff"   — `day` is ignored; ALWAYS server-today (today-collapse, no error).
 * Returns [] for any invalid session so the UI degrades gracefully.
 */
export const listDayTransactions = query({
  args: { sessionId: v.id("staff_sessions"), day: v.optional(v.string()) },
  handler: async (ctx, args): Promise<DayTxn[]> => {
    const who = await ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, {
      sessionId: args.sessionId,
    });
    if (!who) return [];
    const today = wibDayWindow(Date.now());
    const win = who.role === "manager" && args.day ? windowForLabel(args.day) : today;
    return await ctx.runQuery(internal.transactions.internal._fetchDayWindow_internal, {
      dayStartMs: win.dayStartMs,
      dayEndMs: win.dayEndMs,
    });
  },
});

/**
 * v0.5.3a manager dashboard summary — aggregates the day's paid txns into the
 * dashboard view-model. Throws MANAGER_ONLY for a staff session and NO_SESSION
 * for an invalid session (per _requireManagerSession_internal semantics).
 *
 * Day picker: `day` is "YYYY-MM-DD" in WIB; defaults to server-today (WIB).
 */
export const dashboardSummary = query({
  args: { sessionId: v.id("staff_sessions"), day: v.optional(v.string()) },
  handler: async (ctx, args): Promise<DaySummary> => {
    await ctx.runQuery(internal.auth.internal._requireManagerSession_internal, {
      sessionId: args.sessionId,
    });
    const today = wibDayWindow(Date.now());
    const win = args.day ? windowForLabel(args.day) : today;
    const txns = await ctx.runQuery(internal.transactions.internal._fetchDayWindow_internal, {
      dayStartMs: win.dayStartMs,
      dayEndMs: win.dayEndMs,
    });
    return computeDaySummary(txns);
  },
});

/**
 * Commit a built cart to the server. Single mutation — no per-line server
 * calls (Zustand cart on client). intent="draft" → status=draft; intent="charge"
 * → status=awaiting_payment (frontend then calls payments.actions.requestPayment).
 *
 * Snapshots prices + names at commit time (ADR-001 immutable snapshots).
 * Computes voucher_discount via validateVoucher logic (re-validated server-side).
 * Sets NEG_STOCK flag if projected on_hand would go negative (ADR-018).
 *
 * Cross-module reads route through owning-module internal queries (ADR-034):
 *   staff_sessions → auth._resolveSession_internal
 *   pos_products   → catalog._getProductsByIds_internal
 *   pos_vouchers   → vouchers._getVoucherByCode_internal
 *   pos_stock_levels (projection) → transactions._projectedNegStockFlag_internal
 */
export const commitCart = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    intent: v.union(v.literal("draft"), v.literal("charge")),
    lines: v.array(v.object({
      productId: v.id("pos_products"),
      qty: v.number(),
    })),
    voucherCode: v.optional(v.string()),
  },
  handler: withIdempotency<
    {
      sessionId: Id<"staff_sessions">;
      idempotencyKey: string;
      intent: "draft" | "charge";
      lines: Array<{ productId: Id<"pos_products">; qty: number }>;
      voucherCode?: string;
    },
    { transactionId: Id<"pos_transactions">; totals: { subtotal: number; discount: number; total: number }; flags: number }
  >(
    "transactions.commitCart",
    async (
      ctx,
      args,
    ): Promise<{
      transactionId: Id<"pos_transactions">;
      totals: { subtotal: number; discount: number; total: number };
      flags: number;
    }> => {
      // Boundary guard (public mutation): reject empty carts before any work,
      // so a malformed/replayed request can't create a junk zero-total txn.
      if (args.lines.length === 0) throw new Error("EMPTY_CART");

      const { staffId, deviceId } = await resolveSessionStaff(ctx, args.sessionId);

      // Snapshot prices + names — fetch product details via catalog internal
      // surface (ADR-034). Returned rows may be in any order / skip missing ids,
      // so index by id and walk the cart in its original order.
      const productIds = args.lines.map((l) => l.productId);
      const products = await ctx.runQuery(
        internal.catalog.internal._getProductsByIds_internal,
        { productIds },
      );
      const productById = new Map(products.map((p) => [p._id, p]));

      const linesWithSnapshot: Array<{
        productId: Id<"pos_products">;
        qty: number;
        unit_price: number;
        product_name: string;
        product_code: string;
        tax_rate: number;
      }> = [];
      let subtotal = 0;
      for (const { productId, qty } of args.lines) {
        const p = productById.get(productId);
        if (!p || !p.active) throw new Error("PRODUCT_NOT_FOUND_OR_INACTIVE");
        const lineSub = p.price_idr * qty;
        subtotal += lineSub;
        linesWithSnapshot.push({
          productId, qty,
          unit_price: p.price_idr,
          product_name: p.name,
          // code is optional until F6; fall back to sku_family for the frozen ADR-001 snapshot
          product_code: p.code ?? p.sku_family,
          tax_rate: p.tax_rate,
        });
      }

      // Voucher re-validation (ADR-009) — look up via vouchers internal surface
      // (ADR-034); discount math + active/expiry/min-cart checks run here.
      let voucherDiscount = 0;
      let voucherCodeSnapshot: string | undefined;
      if (args.voucherCode) {
        const voucher = await ctx.runQuery(
          internal.vouchers.internal._getVoucherByCode_internal,
          { code: args.voucherCode },
        );
        if (
          voucher && voucher.active &&
          (voucher.expires_at == null || voucher.expires_at > Date.now()) &&
          (voucher.min_cart_value == null || subtotal >= voucher.min_cart_value)
        ) {
          voucherDiscount = computeVoucherDiscount(voucher.type, voucher.value, subtotal);
          voucherCodeSnapshot = voucher.code;
        }
        // If voucher fails server-side, silently drop — frontend already
        // showed the user the discount via validateVoucher; failure here is
        // exceptional and recovery is "no discount", not "abort sale".
      }

      const total = subtotal - voucherDiscount;

      // NEG_STOCK projection (ADR-018, multi-product-same-SKU correct per staffreview T4)
      const flagged = await ctx.runQuery(
        internal.transactions.internal._projectedNegStockFlag_internal,
        { lines: args.lines },
      );
      let flags = 0;
      if (flagged) flags = withFlag(flags, NEG_STOCK);

      // Insert txn + lines (transactions-owned tables — direct writes OK)
      const txnId = await ctx.db.insert("pos_transactions", {
        status: args.intent === "draft" ? "draft" : "awaiting_payment",
        subtotal,
        voucher_code_snapshot: voucherCodeSnapshot,
        voucher_discount: voucherDiscount,
        total,
        flags,
        staff_id: staffId,
        created_at: Date.now(),
      });
      for (const l of linesWithSnapshot) {
        await ctx.db.insert("pos_transaction_lines", {
          transaction_id: txnId,
          product_id: l.productId,
          product_code_snapshot: l.product_code,
          product_name_snapshot: l.product_name,
          unit_price_snapshot: l.unit_price,
          tax_rate_snapshot: l.tax_rate,
          qty: l.qty,
          line_subtotal: l.unit_price * l.qty,
        });
      }

      await logAudit(ctx, {
        actor_id: staffId,
        action: "transaction.committed",
        entity_type: "pos_transactions", entity_id: txnId,
        source: "booth_inline",
        device_id: deviceId,
        metadata: { intent: args.intent, total, voucher_code: voucherCodeSnapshot },
      });

      return {
        transactionId: txnId,
        totals: { subtotal, discount: voucherDiscount, total },
        flags,
      };
    },
    {
      authCheck: async (ctx, args) => { await resolveSessionStaff(ctx, args.sessionId); },
    },
  ),
});

/**
 * Resume a draft: returns its lines + voucherCode, then DELETES the row.
 *
 * Race protection (staffreview T6): two concurrent resumeDraft calls on the
 * same draftId — Convex's serializable transactions ensure one wins; the
 * loser re-reads the now-deleted draft and throws DRAFT_ALREADY_RESUMED.
 */
export const resumeDraft = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    draftId: v.id("pos_transactions"),
  },
  handler: withIdempotency<
    { sessionId: Id<"staff_sessions">; draftId: Id<"pos_transactions">; idempotencyKey: string },
    {
      lines: Array<{ productId: Id<"pos_products">; qty: number }>;
      voucherCode?: string;
    }
  >(
    "transactions.resumeDraft",
    async (
      ctx,
      args,
    ): Promise<{
      lines: Array<{ productId: Id<"pos_products">; qty: number }>;
      voucherCode?: string;
    }> => {
      const { staffId, deviceId } = await resolveSessionStaff(ctx, args.sessionId);
      const draft = await ctx.db.get(args.draftId);
      if (!draft) throw new Error("DRAFT_ALREADY_RESUMED");
      // Ownership: a draft is private to the staff who saved it. Shared device,
      // overlapping shifts — block resuming another staff member's draft by id.
      if (draft.staff_id !== staffId) throw new Error("NOT_OWNER");
      if (draft.status !== "draft") throw new Error("INVALID_DRAFT_STATE");

      const lines = await ctx.db
        .query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", args.draftId))
        .collect();
      const result = {
        lines: lines.map((l) => ({ productId: l.product_id, qty: l.qty })),
        voucherCode: draft.voucher_code_snapshot,
      };

      // Delete lines then draft
      for (const l of lines) await ctx.db.delete(l._id);
      await ctx.db.delete(args.draftId);

      await logAudit(ctx, {
        actor_id: staffId,
        // Distinct from transaction.cancelled: the draft was pulled back into an
        // active cart, not abandoned. An observer shouldn't read this as a void (m-4).
        action: "transaction.resumed",
        entity_type: "pos_transactions", entity_id: args.draftId,
        source: "booth_inline",
        device_id: deviceId,
        reason: "resumed_to_cart",
      });

      return result;
    },
    {
      authCheck: async (ctx, args) => { await resolveSessionStaff(ctx, args.sessionId); },
    },
  ),
});

/**
 * ADR-026 startup reconciliation query.
 *
 * Returns pos_transactions rows in `awaiting_payment` status that were created
 * within the last 5 minutes. Used by `useStartupReconciliation` (frontend hook)
 * to re-check Xendit invoice status on app load — covers the race window where
 * a webhook arrived while the app was closed.
 *
 * Session boundary: resolves session via _resolveSession_internal (auth-owned
 * staff_sessions must not be read directly from transactions — ADR-034). Returns
 * [] if the session is invalid so the hook degrades gracefully.
 *
 * Index used: by_status_created ["status","created_at"] — supports
 * .eq("status","awaiting_payment").gte("created_at", fiveMinAgo) efficiently.
 */
export const listRecentAwaitingPayment = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<Doc<"pos_transactions">[]> => {
    // Cross-module boundary: resolve session via auth internal surface (ADR-034).
    const resolved = await ctx.runQuery(
      internal.auth.internal._resolveSession_internal,
      { sessionId: args.sessionId },
    );
    if (!resolved) return [];

    const fiveMinAgo = Date.now() - 5 * 60_000;
    return await ctx.db
      .query("pos_transactions")
      .withIndex("by_status_created", (q) =>
        q.eq("status", "awaiting_payment").gte("created_at", fiveMinAgo),
      )
      .collect();
  },
});

/**
 * Cancel a transaction that is sitting in `awaiting_payment` (staff at
 * /sale/charge hits "Abandon"). Three atomic side effects:
 *
 *   1. Transition txn → `cancelled`.
 *   2. Mark any active Xendit invoice for the txn as locally cancelled
 *      (QR codes can't be remotely cancelled — we stop processing them per
 *      ADR-036; invoice is "active" if it has no `cancelled_at` yet).
 *   3. Cascade-deny any live `manual_payment_override` approval requests
 *      for the txn via `_cancelPendingManualPaymentForTxn_internal` (Task 9).
 *
 * State guard: only works when txn.status === "awaiting_payment". Throws
 * TXN_NOT_AWAITING if the webhook already confirmed payment (race — caller
 * should redirect to charge-success instead of showing the abandon dialog).
 *
 * Born under the strict ESLint rule (Task 6): idempotencyKey + withIdempotency
 * + authCheck are wired from day one. requireSession (NOT requireManagerSession)
 * — any active staff session at the booth can abandon a pending payment.
 */
export const cancelAwaitingPayment = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
  },
  handler: withIdempotency<
    { sessionId: Id<"staff_sessions">; txnId: Id<"pos_transactions">; idempotencyKey: string },
    { cancelled: true }
  >(
    "transactions.cancelAwaitingPayment",
    async (ctx, args): Promise<{ cancelled: true }> => {
      const { staffId, deviceId } = await resolveSessionStaff(ctx, args.sessionId);

      const txn = await ctx.db.get(args.txnId);
      if (!txn) throw new Error("TXN_NOT_FOUND");
      if (txn.status !== "awaiting_payment") throw new Error("TXN_NOT_AWAITING");

      await ctx.db.patch(args.txnId, {
        status: "cancelled",
        cancelled_at: Date.now(),
        cancelled_reason: "user_cancelled_at_payment",
      });

      // Mark the active invoice as locally cancelled. Route through
      // payments._cancelActiveInvoiceForTxn_internal — payments owns
      // pos_xendit_invoices (ADR-034); transactions must not touch it directly.
      // F6: thread real staff context so forensic queries by actor_id / source
      // surface the invoice-cancel half of the operation.
      await ctx.runMutation(
        internal.payments.internal._cancelActiveInvoiceForTxn_internal,
        { txnId: args.txnId, cancel_reason: "txn_cancelled", actor_id: staffId, source: "booth_inline" },
      );

      // Cascade-deny any live pending manual_payment_override approvals for
      // this txn so managers can't approve a stale request.
      await ctx.runMutation(
        internal.approvals.internal._cancelPendingManualPaymentForTxn_internal,
        { txnId: args.txnId, reason: "txn_cancelled" },
      );

      await logAudit(ctx, {
        actor_id: staffId,
        action: "transaction.cancelled",
        entity_type: "pos_transactions",
        entity_id: args.txnId,
        source: "booth_inline",
        device_id: deviceId,
        reason: "user_cancelled_at_payment",
      });

      return { cancelled: true as const };
    },
    {
      authCheck: async (ctx, args) => { await resolveSessionStaff(ctx, args.sessionId); },
    },
  ),
});

type TxnDetail = {
  txn: Doc<"pos_transactions">;
  lines: Doc<"pos_transaction_lines">[];
  refundStatus: RefundStatus;
};

/**
 * v0.5.3a transaction detail. Pure read — does NOT mint a receipt token; only
 * returns the existing one (or null). Use shareReceipt to mint on demand.
 *
 * Scope:
 *   - manager: any txn
 *   - staff:   only txns whose created_at falls in server-today (WIB) — returns null otherwise (FE renders "not found").
 *   - null on invalid session OR missing txn (graceful UI degrade).
 */
export const getTransactionDetail = query({
  args: { sessionId: v.id("staff_sessions"), txnId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<TxnDetail | null> => {
    const who = await ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, {
      sessionId: args.sessionId,
    });
    if (!who) return null;
    const txn = await ctx.db.get(args.txnId);
    if (!txn) return null;
    if (who.role !== "manager") {
      const today = wibDayWindow(Date.now());
      // Out-of-scope: staff may only read txns from server-today (WIB). Returning
      // null (not throwing) keeps the FE on the graceful "not found" path — the
      // staff member tapping an old permalink sees the same friendly card as
      // a hard-deleted txn, without an ErrorBoundary in the spoke tree.
      if (txn.created_at < today.dayStartMs || txn.created_at >= today.dayEndMs) {
        return null;
      }
    }
    // Two independent reads given args.txnId — parallel to shave latency.
    const [lines, refunds] = await Promise.all([
      ctx.db
        .query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
        .collect(),
      ctx.runQuery(
        internal.refunds.internal._listForTransaction_internal,
        { transactionId: args.txnId },
      ),
    ]);
    // Note: receipt_token is intentionally NOT returned. The FE goes through
    // shareReceipt to mint/fetch the token, which narrows the capability
    // surface (a Doc read at any other public seam can't accidentally leak the
    // signed-URL secret — ADR-021).
    return {
      txn,
      lines,
      refundStatus: refundStatus(lines, refunds.length > 0),
    };
  },
});

export const deleteDraft = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    draftId: v.id("pos_transactions"),
  },
  handler: withIdempotency<
    { sessionId: Id<"staff_sessions">; draftId: Id<"pos_transactions">; idempotencyKey: string },
    { deleted: true }
  >(
    "transactions.deleteDraft",
    async (ctx, args): Promise<{ deleted: true }> => {
      const { staffId, deviceId } = await resolveSessionStaff(ctx, args.sessionId);
      const draft = await ctx.db.get(args.draftId);
      if (!draft) return { deleted: true as const };
      // Ownership: only the staff who saved the draft may delete it (see resumeDraft).
      if (draft.staff_id !== staffId) throw new Error("NOT_OWNER");
      if (draft.status !== "draft") throw new Error("INVALID_DRAFT_STATE");
      const lines = await ctx.db
        .query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", args.draftId))
        .collect();
      for (const l of lines) await ctx.db.delete(l._id);
      await ctx.db.delete(args.draftId);
      await logAudit(ctx, {
        actor_id: staffId,
        action: "transaction.cancelled",
        entity_type: "pos_transactions", entity_id: args.draftId,
        source: "booth_inline",
        device_id: deviceId,
        reason: "draft_deleted",
      });
      return { deleted: true as const };
    },
    {
      authCheck: async (ctx, args) => { await resolveSessionStaff(ctx, args.sessionId); },
    },
  ),
});

/**
 * v0.5.3a: mint-on-share. The first real caller of the dormant v0.5.1 lazy-mint
 * seam (receipts/internal._lazyMintReceiptToken_internal). Idempotent — if the
 * transaction already has a receipt_token, the underlying internal returns the
 * existing one without re-minting and without writing an audit row.
 *
 * Public-mutation contract per rule #21: idempotencyKey + withIdempotency +
 * authCheck wired from day one. The handler re-resolves the session inside the
 * cached body to capture staffId for the audit on first mint.
 *
 * Throws (via the lazy-mint internal):
 *   - SESSION_INVALID — handled in authCheck before the cache lookup
 *   - TXN_NOT_FOUND — txn does not exist
 *   - TXN_NOT_PAID  — txn exists but is draft / awaiting_payment / cancelled
 *                     (minting a token for a non-paid txn would leak a
 *                     viewable receipt for an incomplete sale)
 */
export const shareReceipt = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
  },
  handler: withIdempotency<
    { sessionId: Id<"staff_sessions">; txnId: Id<"pos_transactions">; idempotencyKey: string },
    { token: string }
  >(
    "transactions.shareReceipt",
    async (ctx, args): Promise<{ token: string }> => {
      const { staffId } = await resolveSessionStaff(ctx, args.sessionId);
      // v0.5.3a simplification: call the owning-module helper directly. The
      // receipts._lazyMintReceiptToken_internal facade was a pure pass-through
      // (one extra runMutation hop) and was deleted to keep the ADR-034
      // boundary clear — pos_transactions writes stay in transactions/.
      const { token } = await ctx.runMutation(
        internal.transactions.internal._ensureReceiptTokenForPaidTxn_internal,
        { transactionId: args.txnId, actor: staffId, isLazy: true },
      );
      return { token };
    },
    {
      authCheck: async (ctx, args) => { await resolveSessionStaff(ctx, args.sessionId); },
    },
  ),
});
