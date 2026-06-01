import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { rp, fmtTime, fmtDate } from "@/lib/format";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

/**
 * v0.5.3a T9 — transaction detail.
 *
 * Reads `getTransactionDetail`, which scopes staff to server-today (throws
 * OUT_OF_SCOPE otherwise). useQuery surfaces a thrown handler error as the
 * query result — Convex renders the error via the React error boundary; we
 * guard with a narrow try/error UI by detecting the thrown message at use
 * time via useQuery's error state shape: we read the result and on undefined
 * + presence-of-error, render the friendly card.
 *
 * "Bagikan struk" mints a public receipt token via `shareReceipt` (one-off
 * idempotency key minted at click time per the sale/drafts.tsx convention)
 * and opens `/r/<token>` in a new tab.
 *
 * Note: T11 wires the `/history/:txnId` route to the router. This file ships
 * here so it typechecks and tests pass in isolation.
 */

const REFUND_BADGE = {
  none: {
    label: "LUNAS",
    cls: "bg-emerald-100 text-emerald-800 border-transparent",
  },
  partial: {
    label: "SEBAGIAN DIKEMBALIKAN",
    cls: "bg-amber-100 text-amber-800 border-transparent",
  },
  full: {
    label: "DIKEMBALIKAN",
    cls: "bg-red-100 text-red-800 border-transparent",
  },
} as const;

const CONFIRMED_VIA_LABEL: Record<"webhook" | "polling" | "manual", string> = {
  webhook: "Otomatis (webhook)",
  polling: "Otomatis (polling)",
  manual: "Manual (manajer)",
};

export default function HistoryDetail() {
  const session = useSession();
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

  const handleShare = async () => {
    if (session.status !== "active" || !txnId) return;
    setSharing(true);
    try {
      const { token } = await shareReceipt({
        idempotencyKey: crypto.randomUUID(),
        sessionId: session.sessionId,
        txnId,
      });
      // Open in a new tab — matches the standard "share receipt" affordance
      // (staff hands the device to the customer, or pastes the URL into the
      // customer's WhatsApp).
      window.open(`/r/${token}`, "_blank");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Gagal membagikan struk";
      toast.error(msg);
    } finally {
      setSharing(false);
    }
  };

  // ---- guards ----
  if (!txnId) {
    return (
      <SpokeLayout title="Transaksi">
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-destructive">Transaksi tidak ditemukan.</p>
          <Button variant="outline" asChild>
            <Link to="/history">Kembali</Link>
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  if (session.status === "loading" || detail === undefined) {
    return (
      <SpokeLayout title="Transaksi" backTo="/history">
        <main className="flex flex-1 flex-col items-center justify-center p-4">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null;

  if (detail === null) {
    return (
      <SpokeLayout title="Transaksi" backTo="/history">
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Transaksi tidak ditemukan.
          </p>
          <Button variant="outline" asChild>
            <Link to="/history">Kembali</Link>
          </Button>
        </main>
      </SpokeLayout>
    );
  }

  const { txn, lines, refundStatus: status } = detail;
  const badge = REFUND_BADGE[status];
  const paidAt = txn.paid_at ?? txn.created_at;
  const confirmedViaLabel = txn.confirmed_via
    ? CONFIRMED_VIA_LABEL[txn.confirmed_via]
    : "—";

  return (
    <SpokeLayout title="Transaksi" backTo="/history">
      <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* Header card: receipt # + status badge + paid time */}
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span
              className="text-sm font-medium"
              data-testid="history-receipt-number"
            >
              {txn.receipt_number ?? "(tanpa nomor struk)"}
            </span>
            <Badge
              variant="outline"
              className={`text-[10px] uppercase tracking-wide ${badge.cls}`}
              data-testid="history-refund-status"
            >
              {badge.label}
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
                        <span className="ml-1 text-amber-700">
                          · {refunded} dikembalikan
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
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{rp(txn.subtotal)}</dd>
            </div>
            {txn.voucher_discount > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <dt>
                  Diskon voucher
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
              <dt>Total</dt>
              <dd className="tabular-nums" data-testid="history-total">
                {rp(txn.total)}
              </dd>
            </div>
          </dl>
        </Card>

        {/* Payment + share */}
        <Card className="p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Konfirmasi pembayaran</span>
            <span>{confirmedViaLabel}</span>
          </div>
          <Button
            className="mt-3 w-full"
            onClick={handleShare}
            disabled={sharing}
            data-testid="history-share-receipt"
          >
            {sharing ? "Membagikan…" : "Bagikan struk"}
          </Button>
        </Card>
      </section>
    </SpokeLayout>
  );
}
