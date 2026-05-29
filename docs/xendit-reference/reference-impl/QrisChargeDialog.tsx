// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE COPY — from Frollie Recipe Master (product_master), Phase 84.
// Path in source repo: src/components/orders/QrisChargeDialog.tsx
// Documentation only; NOT compiled in FrolliePOS. Shows the reactive
// "waiting → paid" UX: the dialog state is DERIVED from a live Convex
// subscription (no polling, no manual refresh). The paid flip happens when the
// webhook writes status:"paid" and the subscription re-renders.
// FrolliePOS's Charge screen is its own component — adapt the pattern, not the file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 84 Plan 05 — QrisChargeDialog.
 *
 * A SINGLE component whose visible state is DERIVED from the
 * `getActiveQrisPayment(orderId)` subscription (D-03 — not local toggles).
 * States: loading | active | paid | expired | error. The paid flip is the
 * headline UX guarantee: it happens reactively (webhook → row.status === "paid"
 * → re-render) with no manual refresh. Visual + copy contract: 84-UI-SPEC.md.
 *
 * QR is rendered with `qrcode.react` v4's NAMED export `QRCodeSVG` (NOT default),
 * black-on-white inside a fixed white card (mandatory even in dark mode).
 *
 * Note on Dialog composition: the shared `DialogContent` primitive renders its
 * children inside a Radix Portal (→ document.body). We render the dialog body
 * inline under `Dialog.Root` (via `DialogPrimitive.Content` WITHOUT the portal)
 * so the QR + state panels are part of the component's own subtree — keeping the
 * R5/R7 RTL assertions (`container.querySelector("svg")`) honest while preserving
 * the Radix focus-trap / dismiss semantics and every visual/copy lock.
 */
import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, QrCode, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCurrency } from "@/lib/utils";
import { useActiveQrisPayment, useQrisConfig } from "@/hooks/convex/useQris";
import { useCreateQrisInvoice } from "@/hooks/convex/useQrisCreate";
import type { Id } from "../../../convex/_generated/dataModel";

interface QrisChargeDialogProps {
  open: boolean;
  orderId: Id<"orders">;
  onOpenChange: (open: boolean) => void;
}

/** Format ms-remaining as mm:ss. */
function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

const CONTENT_CLASS =
  "fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg";

export function QrisChargeDialog({ open, orderId, onOpenChange }: QrisChargeDialogProps) {
  const row = useActiveQrisPayment(orderId);
  const config = useQrisConfig();
  const createInvoice = useCreateQrisInvoice();

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick state forces a re-render each second so the countdown + expiry derive live.
  const [now, setNow] = useState(() => Date.now());

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Local countdown: a single setInterval, cleared on unmount / dialog close.
  useEffect(() => {
    if (!open) return;
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [open]);

  // Auto-mint a fresh QR on open when there is no active pending row.
  // `row === undefined` is loading (don't act yet); `null` means none exists.
  const hasPending = row != null && row.status === "pending";
  useEffect(() => {
    if (!open) return;
    if (row !== null) return; // undefined = loading; a row exists otherwise
    if (creating) return;
    void mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  async function mint() {
    if (!createInvoice) return; // defensive: action hook unavailable
    setError(null);
    setCreating(true);
    try {
      await createInvoice(orderId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  }

  // ---- Derive the visible state from the subscription (D-03). ----
  const isPaid = row != null && row.status === "paid";
  const msRemaining = hasPending ? row.expiresAt - now : 0;
  const isExpired = hasPending && msRemaining <= 0;
  const isActive = hasPending && !isExpired;

  const merchantName = config?.merchantName ?? null;
  const qrisNmid = config?.qrisNmid ?? null;

  const closeButton = (
    <Button
      variant="outline"
      className="min-h-[44px] sm:min-h-[36px] text-base sm:text-sm"
      onClick={() => onOpenChange(false)}
    >
      Close
    </Button>
  );

  let body: React.ReactNode;
  if (error) {
    body = (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-medium">
            <AlertTriangle className="h-5 w-5 text-[var(--color-status-error)]" />
            Couldn&apos;t generate QR code
          </DialogTitle>
          <DialogDescription className="text-base">
            Something went wrong reaching the payment provider. Close this and try again, or fall
            back to manual payment.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          {closeButton}
          <Button
            className="min-h-[44px] sm:min-h-[36px] text-base sm:text-sm"
            onClick={() => void mint()}
          >
            Try Again
          </Button>
        </DialogFooter>
      </>
    );
  } else if (isPaid) {
    body = (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-medium">
            <CheckCircle2 className="h-5 w-5 text-[var(--color-status-success)]" />
            Payment Received
          </DialogTitle>
        </DialogHeader>
        <div className="rounded-xl bg-[var(--color-status-success-bg)] p-4 text-center">
          <CheckCircle2 className="mx-auto mb-2 h-12 w-12 text-[var(--color-status-success)]" />
          <p
            className="text-sm font-medium text-[var(--color-status-success)]"
            aria-label="Payment status: paid"
          >
            Paid
          </p>
          <p className="text-base text-[var(--color-status-success)]">
            {formatCurrency(row.amount)} received
            {row.source ? ` via ${row.source}` : ""}. The order has moved to Payment Received.
          </p>
        </div>
        {row.needsReview && (
          <div className="rounded-xl bg-[var(--color-status-warning-bg)] p-4">
            <p className="text-sm text-[var(--color-status-warning)]">
              This payment needs review
              {row.reviewReason ? ` — ${row.reviewReason}` : ""}. The payment was still recorded.
            </p>
          </div>
        )}
        <DialogFooter>{closeButton}</DialogFooter>
      </>
    );
  } else if (isExpired) {
    body = (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-medium">
            <AlertTriangle className="h-5 w-5 text-[var(--color-status-warning)]" />
            QR Code Expired
          </DialogTitle>
          <DialogDescription className="text-base">
            This QR code is no longer valid. Generate a new one to charge the customer again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          {closeButton}
          <Button
            className="min-h-[44px] sm:min-h-[36px] text-base sm:text-sm"
            onClick={() => void mint()}
          >
            Generate New QR
          </Button>
        </DialogFooter>
      </>
    );
  } else if (isActive) {
    body = (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-medium">
            <QrCode className="h-5 w-5" />
            Scan to Pay with QRIS
          </DialogTitle>
          <DialogDescription className="text-base">
            Ask the customer to scan this code with any QRIS-enabled app. This screen updates
            automatically when payment is received.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          <div className="bg-white p-4 rounded-xl">
            <QRCodeSVG value={row.qrString} size={256} level="M" />
          </div>

          {qrisNmid && (
            <div className="text-center">
              {merchantName && <p className="text-sm text-muted-foreground">{merchantName}</p>}
              <p className="text-sm text-muted-foreground">NMID: {qrisNmid}</p>
            </div>
          )}

          <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground">Amount due</p>
            <p className="text-3xl font-medium leading-tight">{formatCurrency(row.amount)}</p>
            <p className="text-sm text-muted-foreground">Order {row.externalId}</p>
          </div>

          {/* Live "listening" indicator — makes it obvious the screen is actively
              waiting for the webhook, not frozen. Flips to the paid panel reactively. */}
          <div
            className="flex items-center justify-center gap-2 rounded-full bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
            Waiting for payment…
          </div>

          <p
            className={cn(
              "text-sm",
              msRemaining <= 5 * 60 * 1000
                ? "text-[var(--color-status-warning)]"
                : "text-muted-foreground",
            )}
          >
            Expires in {formatCountdown(msRemaining)}
          </p>
        </div>

        <DialogFooter>{closeButton}</DialogFooter>
      </>
    );
  } else {
    // loading / generating (creating, subscription resolving, or no row yet)
    body = (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-medium">
            <QrCode className="h-5 w-5" />
            Scan to Pay with QRIS
          </DialogTitle>
          <DialogDescription className="text-base">Generating QR code…</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center py-6">
          <Skeleton className="h-[256px] w-[256px] rounded-xl" />
        </div>
        <DialogFooter>{closeButton}</DialogFooter>
      </>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {open && (
        <>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
          <DialogPrimitive.Content
            className={CONTENT_CLASS}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {body}
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </>
      )}
    </DialogPrimitive.Root>
  );
}

export default QrisChargeDialog;
