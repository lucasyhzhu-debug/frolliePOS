import { useEffect } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Phase =
  | { kind: "loading" }
  | { kind: "showing" }
  | { kind: "paid" }
  | { kind: "expired" }
  | { kind: "cancelled" };

// ---------------------------------------------------------------------------
// Constants (exported so tests can assert their values)
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 2_000;
export const POLL_CEILING_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pure function — exported so tests can unit-test phase derivation in isolation
 * without mounting the hook.
 */
export function computePhase(
  txn: { status: string } | null | undefined,
  invoice: { xendit_invoice_id: string } | null | undefined,
): Phase {
  if (!txn || !invoice) return { kind: "loading" };
  if (txn.status === "paid") return { kind: "paid" };
  if (txn.status === "cancelled") return { kind: "cancelled" };
  // awaiting_payment (or any unrecognised status): show the payment screen. The
  // ceiling-reached CTA is driven by wall-clock elapsed time in the route layer,
  // not by this hook — so "showing" carries no sub-state. Keeps the hook focused
  // on starting/stopping polling only.
  return { kind: "showing" };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Drives the charge screen's payment polling + reactive status.
 *
 * - Subscribes reactively to the current transaction and its active Xendit invoice.
 * - Derives a Phase value from those subscriptions (see computePhase).
 * - Starts a 2-second polling loop when txn.status === "awaiting_payment":
 *     • First poll fires after POLL_INTERVAL_MS (2s).
 *     • Subsequent polls every POLL_INTERVAL_MS until POLL_CEILING_MS (60s) elapses.
 *     • Past the ceiling the interval is cleared; polling stops entirely.
 *     • Errors from checkInvoiceStatus are swallowed — polling resumes next tick.
 * - Polling stops immediately (cleanup) when txn leaves "awaiting_payment"
 *   (i.e., paid / cancelled) because the dep [txn?.status] causes the effect
 *   to re-run, and the guard `if (txn.status !== "awaiting_payment") return`
 *   prevents new timers being set.
 *
 * The route component (Task 34) separately tracks wall-clock elapsed time to
 * surface the "Manager override" CTA at the ceiling; this hook does not manage
 * that UI concern.
 *
 * @param txnId - The ID of the pos_transactions row to watch.
 * @returns { phase, invoice, txn }
 */
export function useXenditPayment(txnId: Id<"pos_transactions">) {
  const txn = useQuery(api.transactions.public.getById, { txnId });
  const invoice = useQuery(api.payments.public.getCurrentInvoice, { txnId });
  const checkStatus = useAction(api.payments.actions.checkInvoiceStatus);

  const phase: Phase = computePhase(txn ?? undefined, invoice ?? undefined);

  useEffect(() => {
    // Guard: both must be loaded and txn must be awaiting payment.
    if (!txn || !invoice) return;
    if (txn.status !== "awaiting_payment") return;

    const xenditInvoiceId = invoice.xendit_invoice_id;

    const startedAt = Date.now();

    // Interval polls every 2s; stops itself past the 60s ceiling.
    const handle = setInterval(async () => {
      if (Date.now() - startedAt > POLL_CEILING_MS) {
        clearInterval(handle);
        return;
      }
      try {
        await checkStatus({ invoiceId: xenditInvoiceId });
      } catch {
        // Network error — swallow and continue on next tick.
      }
    }, POLL_INTERVAL_MS);

    // First poll fires after the initial 2s wait (matches spec: polling begins
    // after 2s, not immediately, so the user has time to scan the QR code first).
    const initial = setTimeout(() => {
      checkStatus({ invoiceId: xenditInvoiceId }).catch(() => {});
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(handle);
      clearTimeout(initial);
    };
  }, [txn?.status, invoice?.xendit_invoice_id, checkStatus]);

  return { phase, invoice, txn };
}
