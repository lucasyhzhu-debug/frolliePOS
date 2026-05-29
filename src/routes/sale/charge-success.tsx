import { useNavigate, useParams } from "react-router";
import { useQuery } from "convex/react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { rp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

/**
 * Charge-success screen — shown after a transaction reaches "paid" status.
 *
 * Receipt number is the hero element (allocated at _confirmPaid, format
 * "R-YYYY-NNNN"). Displays total, payment confirmation method, and a
 * "New sale" CTA that returns to /sale (cart was already cleared by the
 * charge flow before navigating here).
 *
 * Offline-queue note: the offline queue is for draft commits only; a paid
 * charge is strictly online. No queue interaction needed here.
 */
export default function SaleChargeSuccess() {
  const navigate = useNavigate();
  const { txnId: txnIdParam } = useParams<{ txnId: string }>();
  const txnId = txnIdParam as Id<"pos_transactions"> | undefined;

  const result = useQuery(
    api.transactions.public.getById,
    txnId ? { txnId } : "skip",
  );

  // No txnId param in the URL. Checked BEFORE the loading guard: with no txnId the
  // query is "skip" and result stays undefined forever, so the loading branch would
  // otherwise spin indefinitely instead of showing this error.
  if (!txnId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
        <p className="text-sm text-destructive">No transaction specified.</p>
        <Button variant="outline" onClick={() => navigate("/sale")}>
          New sale
        </Button>
      </main>
    );
  }

  // Loading: query not yet resolved (undefined means in-flight).
  if (result === undefined) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading receipt…</p>
      </main>
    );
  }

  // Not found (result === null) or not paid yet.
  if (result === null || result.status !== "paid") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {result === null ? "Transaction not found." : "Payment not yet confirmed."}
        </p>
        <Button variant="outline" onClick={() => navigate("/sale")}>
          New sale
        </Button>
      </main>
    );
  }

  // Paid — render receipt.
  const confirmLabel: Record<NonNullable<typeof result.confirmed_via>, string> = {
    webhook: "QRIS / BCA VA",
    polling: "QRIS / BCA VA",
    manual: "Manager override",
  };
  const methodLabel = result.confirmed_via
    ? confirmLabel[result.confirmed_via]
    : "Paid";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      {/* Success mark */}
      <div className="flex flex-col items-center gap-2">
        <CheckCircle2 className="h-14 w-14 text-teal-500" />
        <p className="text-lg font-semibold text-teal-600">Payment confirmed</p>
      </div>

      {/* Receipt card */}
      <div className="w-full max-w-xs rounded-xl border bg-card p-5 shadow-sm">
        {/* Receipt number — hero element */}
        <div className="mb-4 flex flex-col items-center gap-1">
          <span className="text-[11px] font-medium tracking-widest text-muted-foreground">
            RECEIPT
          </span>
          <span className="text-3xl font-bold tabular-nums tracking-wide">
            {result.receipt_number ?? "—"}
          </span>
        </div>

        <Separator className="mb-4" />

        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="font-semibold tabular-nums">{rp(result.total)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Method</dt>
            <dd className="font-medium">{methodLabel}</dd>
          </div>
          {result.voucher_discount > 0 && (
            <div className="flex items-center justify-between text-teal-600">
              <dt>Voucher</dt>
              <dd className="tabular-nums">−{rp(result.voucher_discount)}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* CTA */}
      <Button
        className="w-full max-w-xs"
        size="lg"
        onClick={() => navigate("/sale")}
      >
        New sale
      </Button>
    </main>
  );
}
