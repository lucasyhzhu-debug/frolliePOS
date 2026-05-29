// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE COPY — from Frollie Recipe Master (product_master), Phase 84.
// Path in source repo: convex/integrations/qris/provider.ts
// Documentation only; NOT compiled in FrolliePOS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 84 — Provider-agnostic QRIS payment interface (D-04).
 *
 * Plain TS module (NO Convex registrations) so both the create-QR action and
 * the unit tests can import it. The Xendit implementation lives in `./xendit`.
 * Static imports only (pitfall #8).
 */

export interface CreateInvoiceResult {
  xenditQrId: string;
  qrString: string;
  expiresAt: number;
}

export interface QrisProvider {
  createInvoice(args: {
    orderNumber: string;
    finalTotal: number;
  }): Promise<CreateInvoiceResult>;
  // No status-poll method: payment detection is exclusively webhook-driven.
}
