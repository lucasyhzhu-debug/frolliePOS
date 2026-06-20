import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { rp, fmtTime, fmtDate, buildReceiptUrl } from "@/lib/format";
import { CONFIRMED_VIA_LABEL, REFUND_BADGE } from "@/lib/pos-labels";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { usePrinter } from "@/components/pos/PrinterProvider";
import { encodeReceipt } from "@/lib/escpos";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

/**
 * v0.5.3a T9 — transaction detail.
 *
 * Reads `getTransactionDetail`, which scopes staff to server-today. The null
 * return (missing or out-of-scope) renders a friendly "not found" card —
 * staff tapping an old permalink see the same graceful card as for a missing
 * txn, without an ErrorBoundary in the spoke tree.
 *
 * "Bagikan struk" mints a public receipt token via `shareReceipt` (one-off
 * idempotency key minted at click time per the sale/drafts.tsx convention)
 * and opens `/r/<token>` in a new tab.
 *
 * Note: T11 wires the `/history/:txnId` route to the router. This file ships
 * here so it typechecks and tests pass in isolation.
 */

export default function HistoryDetail() {
  const t = useT();
  const session = useSession();
  const navigate = useNavigate();
  const { txnId: txnIdParam } = useParams<{ txnId: string }>();
  const txnId = txnIdParam as Id<"pos_transactions"> | undefined;

  // useQuery returns undefined on pending; throws (via React error boundary)
  // on OUT_OF_SCOPE. We mirror the refund/detail.tsx pattern: lean on
  // SpokeLayout for the chrome, render the loader / null / not-found.
  const detail = useQuery(
    api.transactions.public.getTransactionDetail,
    session.status === "active" && txnId
      ? { sessionId: session.sessionId, txnId }
      : "skip",
  );

  const shareReceipt = useMutation(api.transactions.public.shareReceipt);
  const [sharing, setSharing] = useState(false);

  const { status: printerStatus, connect, print } = usePrinter();
  const printData = useQuery(
    api.receipts.public.getReceiptForPrint,
    session.status === "active" && txnId && printerStatus !== "unsupported"
      ? { sessionId: session.sessionId, txnId }
      : "skip",
  );

  const onPrint = async () => {
    if (!printData) return;
    try {
      const bytes = encodeReceipt(printData.viewModel, printData.status, printData.statusLabel);
      await print(bytes);
      toast.success(t("historyDetail.printSuccess"));
    } catch {
      toast.error(t("historyDetail.printError"));
    }
  };
  const isPrinterReady = printerStatus === "connected" || printerStatus === "printing";
  const printDisabled = printerStatus === "printing" || printerStatus === "unsupported" || !printData;

  const handleShare = async () => {
    if (session.status !== "active" || !txnId) return;
    setSharing(true);
    try {
      // One-shot user action — fresh UUID per click (matches src/routes/sale/drafts.tsx
      // convention; useIdempotency is for retried/replayed mutations like login + payment).
      const idempotencyKey = crypto.randomUUID();
      const { token } = await shareReceipt({
        idempotencyKey,
        sessionId: session.sessionId,
        txnId,
      });
      // Open in a new tab — matches the standard "share receipt" affordance
      // (staff hands the device to the customer, or pastes the URL into the
      // customer's WhatsApp). buildReceiptUrl points at the Convex .convex.site
      // httpAction route — the SPA's /r/ path is a stub.
      window.open(buildReceiptUrl(token), "_blank");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("historyDetail.shareError");
      toast.error(msg);
    } finally {
      setSharing(false);
    }
  };

  // ---- guards ----
  if (!txnId) {
    return (
      <SpokeLayout title={t("historyDetail.title")}>
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-destructive">{t("historyDetail.notFound")}</p>
          <Button variant="outline" asChild>
            <Link to="/history">{t("historyDetail.back")}</Link>
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  if (session.status === "loading" || detail === undefined) {
    return (
      <SpokeLayout title={t("historyDetail.title")} backTo="/history">
        <main className="flex flex-1 flex-col items-center justify-center p-4">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null;

  if (detail === null) {
    return (
      <SpokeLayout title={t("historyDetail.title")} backTo="/history">
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            {t("historyDetail.notFound")}
          </p>
          <Button variant="outline" asChild>
            <Link to="/history">{t("historyDetail.back")}</Link>
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  const { txn, lines, refundStatus: status } = detail;
  const badge = REFUND_BADGE[status];
  const canRefund = txn.status === "paid" && status !== "full";
  const paidAt = txn.paid_at ?? txn.created_at;
  const confirmedViaLabel = txn.confirmed_via
    ? t(CONFIRMED_VIA_LABEL[txn.confirmed_via])
    : "—";

  return (
    <SpokeLayout title={t("historyDetail.title")} backTo="/history">
      <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* Header card: receipt # + status badge + paid time */}
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span
              className="text-sm font-medium"
              data-testid="history-receipt-number"
            >
              {txn.receipt_number ?? t("historyDetail.noReceiptNumber")}
            </span>
            <Badge
              variant="outline"
              className={`text-[10px] uppercase tracking-wide ${badge.cls}`}
              data-testid="history-refund-status"
            >
              {t(badge.labelKey)}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {fmtDate(paidAt)} {fmtTime(paidAt)}
          </div>
        </Card>

        {/* Lines */}
        <Card className="p-4">
          <ul className="space-y-2">
            {lines.map((l) => {
              const refunded = l.refunded_qty ?? 0;
              return (
                <li
                  key={l._id}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {l.product_name_snapshot}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {l.qty} × {rp(l.unit_price_snapshot)}
                      {refunded > 0 ? (
                        <span className="ml-1 text-warning">
                          · {t("historyDetail.refundedQty", { qty: String(refunded) })}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <span className="tabular-nums">{rp(l.line_subtotal)}</span>
                </li>
              );
            })}
          </ul>

          <Separator className="my-3" />

          {/* Totals */}
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <dt>{t("historyDetail.subtotal")}</dt>
              <dd className="tabular-nums">{rp(txn.subtotal)}</dd>
            </div>
            {txn.voucher_discount > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <dt>
                  {t("historyDetail.voucherDiscount")}
                  {txn.voucher_code_snapshot
                    ? ` (${txn.voucher_code_snapshot})`
                    : null}
                </dt>
                <dd className="tabular-nums">
                  -{rp(txn.voucher_discount)}
                </dd>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <dt>{t("historyDetail.total")}</dt>
              <dd className="tabular-nums" data-testid="history-total">
                {rp(txn.total)}
              </dd>
            </div>
          </dl>
        </Card>

        {/* Payment + share */}
        <Card className="p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t("historyDetail.paymentConfirmation")}</span>
            <span>{confirmedViaLabel}</span>
          </div>
          <Button
            className="mt-3 w-full"
            onClick={handleShare}
            disabled={sharing}
            data-testid="history-share-receipt"
          >
            {sharing ? t("historyDetail.sharing") : t("historyDetail.shareReceipt")}
          </Button>
          <Button
            variant="outline"
            className="mt-2 w-full"
            onClick={isPrinterReady ? onPrint : connect}
            disabled={printDisabled}
            data-testid="history-print"
          >
            {isPrinterReady ? t("historyDetail.printReceipt") : t("historyDetail.connectAndPrint")}
          </Button>
          {canRefund && (
            <Button
              variant="outline"
              className="mt-2 w-full"
              onClick={() => navigate(`/refund/${txnId}`)}
              data-testid="history-refund"
            >
              {t("historyDetail.refund")}
            </Button>
          )}
        </Card>
      </section>
    </SpokeLayout>
  );
}
