import { useEffect, useRef } from "react";
import { useQuery, useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * ADR-026 startup reconciliation hook.
 *
 * On first mount (once per component lifetime, ref-guarded), re-checks every
 * `awaiting_payment` transaction created in the last 5 minutes via Xendit's
 * GET /v2/invoices/:id endpoint. This closes the race window where a Xendit
 * payment webhook arrived while the app was closed or the device was offline.
 *
 * Design notes:
 * - ran guard (useRef) ensures the check fires exactly once per mount, even if
 *   `recent` data arrives asynchronously after the initial render.
 * - Skips rows that have no xendit_invoice_id_current (draft that became
 *   awaiting_payment but payment was never initiated — no invoice to check).
 * - Errors from individual checkInvoiceStatus calls are swallowed; a single
 *   failed check does not abort the loop. Network errors during reconciliation
 *   are transient — the webhook / next manual poll will still catch them.
 * - The movement dedup index (by_line_and_sku, on source_transaction_line_id +
 *   inventory_sku_id) protects against double-decrement if the webhook also
 *   arrives concurrently with the reconciliation re-check (ADR-026 §"double-
 *   movement prevention").
 * - Mounted in RootLayout so it fires once per login session, immediately after
 *   the session is resolved and the Convex subscription becomes active.
 *
 * @param sessionId - The active staff_sessions ID from useSession(), or
 *   undefined while the session is still resolving. Hook is a no-op when
 *   undefined (useQuery receives "skip").
 */
export function useStartupReconciliation(
  sessionId: Id<"staff_sessions"> | undefined,
) {
  const ran = useRef(false);

  const recent = useQuery(
    api.transactions.public.listRecentAwaitingPayment,
    sessionId ? { sessionId } : "skip",
  );

  const checkStatus = useAction(api.payments.actions.checkInvoiceStatus);

  useEffect(() => {
    // Once guard — runs exactly once per mount regardless of how many times
    // `recent` re-renders.
    if (ran.current) return;
    // Wait until the query has resolved (undefined = still loading).
    if (recent === undefined) return;
    // Nothing to do.
    if (recent.length === 0) {
      ran.current = true;
      return;
    }

    ran.current = true;

    void (async () => {
      let confirmed = 0;
      for (const txn of recent) {
        if (!txn.xendit_invoice_id_current) continue;
        try {
          const result = await checkStatus({ invoiceId: txn.xendit_invoice_id_current });
          if (result.status === "PAID") confirmed++;
        } catch {
          // Swallow — transient errors don't abort the reconciliation loop.
        }
      }
      if (confirmed > 0) {
        toast.success(`Reconciled ${confirmed} pending payment${confirmed === 1 ? "" : "s"}.`);
      }
    })();
  }, [recent, checkStatus]);
}
