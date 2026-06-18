import { useNavigate, useParams } from "react-router";
import { useQuery } from "convex/react";
import { motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { rp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { useSession } from "@/hooks/useSession";
import { usePrinter } from "@/components/pos/PrinterProvider";
import { encodeReceipt } from "@/lib/escpos";
import { toast } from "sonner";

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

  // Must be called above all early returns (React hooks rules).
  const reduce = useReducedMotion() ?? false;

  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : undefined;

  // SEC-05: getById is now session-gated — skip until the session resolves.
  const result = useQuery(
    api.transactions.public.getById,
    sessionId && txnId ? { txnId, sessionId } : "skip",
  );

  const { status: printerStatus, connect, print } = usePrinter();

  const printData = useQuery(
    api.receipts.public.getReceiptForPrint,
    sessionId && txnId ? { sessionId, txnId } : "skip",
  );

  const onPrint = async () => {
    if (!printData) return;
    try {
      // The QR is a static follow-us Instagram link derived from the receipt
      // settings (ADR-043 amended), so no per-print shareReceipt token mint is
      // needed. The /r/<token> digital receipt is still reachable via history share.
      const bytes = encodeReceipt(printData.viewModel, printData.status, printData.statusLabel);
      await print(bytes);
      toast.success("Struk dicetak");
    } catch {
      toast.error("Gagal mencetak struk");
    }
  };

  // No txnId param in the URL. Checked BEFORE the loading guard: with no txnId the
  // query is "skip" and result stays undefined forever, so the loading branch would
  // otherwise spin indefinitely instead of showing this error.
  if (!txnId) {
    return (
      <SpokeLayout title="Sale complete" hideBack>
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-destructive">No transaction specified.</p>
          <Button variant="outline" onClick={() => navigate("/sale")}>
            New sale
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  // Loading: query not yet resolved (undefined means in-flight).
  if (result === undefined) {
    return (
      <SpokeLayout title="Sale complete" hideBack>
        <main className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading receipt…</p>
        </main>
      </SpokeLayout>
    );
  }

  // Not found (result === null) or not paid yet.
  if (result === null || result.status !== "paid") {
    return (
      <SpokeLayout title="Sale complete" hideBack>
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            {result === null ? "Transaction not found." : "Payment not yet confirmed."}
          </p>
          <Button variant="outline" onClick={() => navigate("/sale")}>
            New sale
          </Button>
        </main>
      </SpokeLayout>
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
    <SpokeLayout title="Sale complete" hideBack>
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      {/* Success mark — animated circle scale-in + checkmark draw */}
      <div className="flex flex-col items-center gap-2">
        <motion.div
          className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"
          initial={{ scale: reduce ? 1 : 0.6, opacity: reduce ? 1 : 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: reduce ? 0 : 0.35, ease: "easeOut" }}
        >
          <motion.svg
            viewBox="0 0 52 52"
            className="h-8 w-8"
            aria-hidden="true"
            fill="none"
          >
            <motion.path
              d="M14 27 l8 8 l16 -18"
              initial={{ pathLength: reduce ? 1 : 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: reduce ? 0 : 0.4, ease: "easeOut", delay: reduce ? 0 : 0.2 }}
              fill="none"
              stroke="currentColor"
              className="text-primary"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </motion.svg>
        </motion.div>
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
        variant="outline"
        onClick={printerStatus === "connected" ? onPrint : connect}
        disabled={printerStatus === "printing" || printerStatus === "unsupported" || !printData}
      >
        {printerStatus === "connected" || printerStatus === "printing" ? "Cetak struk" : "Hubungkan & cetak"}
      </Button>
      <Button
        className="w-full max-w-xs"
        size="lg"
        onClick={() => navigate("/sale")}
      >
        New sale
      </Button>
    </main>
    </SpokeLayout>
  );
}
