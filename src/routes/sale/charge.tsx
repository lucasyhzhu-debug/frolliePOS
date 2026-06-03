import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { usePathChangeBlocker } from "@/hooks/usePathChangeBlocker";
import { useXenditPayment, PAYMENT_CEILING_MS } from "@/hooks/useXenditPayment";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useCountdown, DEFAULT_LIFETIME_MS } from "@/hooks/useCountdown";
import { rp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { AbandonCartDialog } from "@/components/pos/AbandonCartDialog";
import { PinSheet } from "@/components/pos/PinSheet";
import { ApprovalPending } from "@/components/pos/ApprovalPending";
import { ManagerPickerOverlay } from "@/components/pos/ManagerPickerOverlay";
import { VoucherRejectBanner } from "./voucher-reject-banner";
import { toast } from "sonner";

type VoucherRejected = {
  code: string;
  reason: "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "MIN_CART_VALUE";
};
type NavState = { voucher_rejected?: VoucherRejected };

type Method = "QRIS" | "BCA_VA";

/**
 * Charge screen — the payment confirmation surface (ADR strategic foundations
 * §8, amended by ADR-036). Reads :txnId, drives a Xendit invoice per method, and
 * subscribes to payment status reactively via useXenditPayment (webhook-driven;
 * polling retired per ADR-036). At the 60s ceiling it reveals the three CTAs:
 * Retry (fresh invoice), Manager override (manual confirm), Cancel sale.
 *
 * State-machine shape:
 *   - selectedMethod: which tab is active (QRIS default, BCA_VA secondary).
 *   - The initial invoice for (txnId, method) is created exactly once via a
 *     stable IDB idempotency key + a per-method ref guard, so React re-renders
 *     and StrictMode double-invokes never double-create invoices.
 *   - Switching tabs to a method whose invoice doesn't exist yet creates one.
 *   - Switching tabs to a method that already has an active invoice issues a
 *     fresh invoice for that method (retryWithFreshInvoice) so the displayed
 *     QR/VA always matches the selected tab (ADR-014 single-active-invoice).
 *   - elapsedMs is a wall-clock timer the route owns; useXenditPayment only
 *     reports kind === "showing" and the route decides when the ceiling hits.
 */
export default function SaleCharge() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const { txnId: txnIdParam } = useParams<{ txnId: string }>();
  const txnId = txnIdParam as Id<"pos_transactions"> | undefined;

  // Banner data from V8's commitCart voucher_rejected signal (ADR-009 reject
  // path). Comes via React Router nav state — auto-cleared on hard reload, which
  // is desired (a stale banner mid-payment would confuse since the txn is
  // already committed). Copied into local state so dismissal is independent of
  // nav-state immutability.
  const navState = (location.state as NavState | null) ?? {};
  const [voucherRejected, setVoucherRejected] = useState<VoucherRejected | undefined>(
    navState.voucher_rejected,
  );

  const [selectedMethod, setSelectedMethod] = useState<Method>("QRIS");

  // Payment polling + reactive phase. useXenditPayment requires a concrete id;
  // when the param is missing we fall back to a placeholder and render an error
  // below (txnId === undefined never produces a real subscription).
  const { phase, invoice, txn } = useXenditPayment(
    (txnId ?? "") as Id<"pos_transactions">,
  );

  // Idempotency key for the INITIAL invoice of the selected method. Stable per
  // (txnId, method) so a re-render replays the same key and the server / Xendit
  // dedupe rather than minting a second invoice.
  const initKey = useIdempotency(`pay:${txnId ?? "none"}:${selectedMethod}`);

  // ---- actions ----
  const requestPayment = useAction(api.payments.actions.requestPayment);
  const retryWithFreshInvoice = useAction(
    api.payments.actions.retryWithFreshInvoice,
  );
  const manuallyConfirmPayment = useAction(
    api.payments.actions.manuallyConfirmPayment,
  );
  const cancelTransaction = useAction(api.transactions.actions.cancelTransaction);
  const requestManualPaymentApproval = useAction(
    api.approvals.actions.requestManualPaymentApproval,
  );
  const cancelAwaitingPayment = useMutation(
    api.transactions.public.cancelAwaitingPayment,
  );

  // ---- navigation guard ----
  // Block route transitions while the transaction is awaiting payment so staff
  // can explicitly cancel (invalidating the active QR/VA) before leaving.
  const blocker = usePathChangeBlocker(txn?.status === "awaiting_payment");

  // Cancel-payment handler used by the AbandonCartDialog payment variant.
  // Swallows TXN_NOT_AWAITING races — if the webhook confirmed while the dialog
  // was open, the txn is already paid; treat as success (let blocker proceed).
  const onCancelPaymentForBlocker = async () => {
    if (session.status !== "active" || !txnId) return;
    try {
      await cancelAwaitingPayment({
        sessionId: session.sessionId,
        txnId,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (e) {
      if ((e as Error).message.includes("TXN_NOT_AWAITING")) {
        // Race with successful webhook — txn already paid; proceed silently.
        return;
      }
      throw e;
    }
  };

  // ---- ceiling timer ----
  // Wall-clock elapsed since the current invoice started showing. Resets on a
  // fresh invoice (new xendit_invoice_id) and on retry.
  const [elapsedMs, setElapsedMs] = useState(0);
  const showingId =
    phase.kind === "showing" ? (invoice?.xendit_invoice_id ?? null) : null;

  useEffect(() => {
    if (showingId === null) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const handle = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1_000);
    return () => clearInterval(handle);
  }, [showingId]);

  const ceilingReached = elapsedMs >= PAYMENT_CEILING_MS;

  // ---- countdown timer ----
  // Target epoch = invoice creation time + default Xendit QR lifetime (15min).
  // We derive this from the invoice rather than storing expires_at in the schema —
  // Xendit's expiry is deterministic from creation time and adding the field would
  // require a schema migration with no operational benefit over this derivation.
  const countdownTarget =
    invoice?.created_at != null
      ? invoice.created_at + DEFAULT_LIFETIME_MS
      : undefined;
  const { mmss, pctRemaining, expired: qrExpired } = useCountdown(countdownTarget);

  // ---- initial-invoice creation guard ----
  // Tracks which methods we've already kicked off a create for, so an effect
  // re-run (or StrictMode double-mount) doesn't fire requestPayment twice. The
  // idempotency key makes a duplicate server call safe; this avoids the wasted
  // round-trip entirely.
  const requestedMethods = useRef<Set<Method>>(new Set());

  useEffect(() => {
    if (session.status !== "active") return;
    if (!txnId) return;
    if (!initKey) return;
    // The selected method already has its active invoice — clear its in-flight
    // marker so a later tab-swap back to this method can re-create it. The marker
    // only exists to dedupe the create round-trip, not to permanently block a
    // legitimate re-create (without this, QRIS→BCA→QRIS leaves the QRIS tab stuck
    // on "Generating…" forever since `has(method)` stays true). Then nothing to do.
    if (invoice && invoice.method === selectedMethod) {
      requestedMethods.current.delete(selectedMethod);
      return;
    }
    // Wait until the reactive invoice query has resolved (undefined === loading).
    // `invoice` is null when loaded-but-absent; we only create in that case, or
    // when the existing invoice is for a different method.
    if (invoice === undefined) return;
    if (requestedMethods.current.has(selectedMethod)) return;

    requestedMethods.current.add(selectedMethod);
    const method = selectedMethod;
    const idempotencyKey = initKey;
    void (async () => {
      try {
        if (invoice === null) {
          // No invoice at all → first create for this txn.
          await requestPayment({
            sessionId: session.sessionId,
            txnId,
            method,
            idempotencyKey,
          });
        } else {
          // An invoice exists but for the OTHER method → swap to a fresh one for
          // the selected method (single-active-invoice, ADR-014). A fresh key is
          // required so the server doesn't replay the prior method's cached blob.
          await retryWithFreshInvoice({
            sessionId: session.sessionId,
            txnId,
            method,
            idempotencyKey: crypto.randomUUID(),
          });
        }
      } catch (err) {
        // Allow a later attempt to retry this method.
        requestedMethods.current.delete(method);
        const msg =
          err instanceof Error ? err.message : "Could not start payment";
        toast.error(msg);
      }
    })();
  }, [
    session,
    txnId,
    initKey,
    invoice,
    selectedMethod,
    requestPayment,
    retryWithFreshInvoice,
  ]);

  // ---- paid → success ----
  useEffect(() => {
    if (phase.kind === "paid" && txnId) {
      navigate(`/sale/charge/${txnId}/success`, { replace: true });
    }
  }, [phase.kind, txnId, navigate]);

  // ---- manager override ----
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overridePending, setOverridePending] = useState(false);
  const [overrideError, setOverrideError] = useState<string | undefined>(
    undefined,
  );
  // Picker state: null = show picker, non-null = manager selected → show PIN form.
  const [pickedManager, setPickedManager] = useState<{
    name: string;
    code: string;
  } | null>(null);

  // Fetch active managers for the booth picker. Session must be active — the query
  // is deferred until the sheet opens (but Convex will subscribe as soon as args resolve).
  const managers = useQuery(
    api.staff.public.listActiveManagers,
    session.status === "active"
      ? { sessionId: session.sessionId }
      : "skip",
  );

  const handleOverrideSubmit = async (pin: string) => {
    if (session.status !== "active" || !txnId) return;
    const reason = overrideReason.trim();
    if (!reason) {
      setOverrideError("Reason is required");
      return;
    }
    if (!pickedManager) {
      setOverrideError("Select a manager first");
      return;
    }
    setOverridePending(true);
    setOverrideError(undefined);
    try {
      await manuallyConfirmPayment({
        sessionId: session.sessionId,
        txnId,
        managerStaffCode: pickedManager.code,
        managerPin: pin,
        reason,
        idempotencyKey: crypto.randomUUID(),
      });
      setOverrideOpen(false);
      navigate(`/sale/charge/${txnId}/success`, { replace: true });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Override failed";
      // Surface on the sheet so it shows + clears the pin buffer.
      setOverrideError(
        msg.includes("INVALID_PIN")
          ? "Wrong PIN"
          : msg.includes("MANAGER_NOT_FOUND")
            ? "Manager not found or not active"
            : msg,
      );
    } finally {
      setOverridePending(false);
    }
  };

  // ---- off-booth approval ----
  // When set, the screen shows <ApprovalPending> for the pending request.
  const [approvalRequestId, setApprovalRequestId] = useState<
    Id<"pos_approval_requests"> | null
  >(null);
  const [approvalReasonOpen, setApprovalReasonOpen] = useState(false);
  const [approvalReason, setApprovalReason] = useState("");
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalReasonError, setApprovalReasonError] = useState<
    string | undefined
  >(undefined);

  const handleRequestApproval = async () => {
    if (session.status !== "active" || !txnId) return;
    const reason = approvalReason.trim();
    if (!reason) {
      setApprovalReasonError("Reason is required");
      return;
    }
    setApprovalSubmitting(true);
    setApprovalReasonError(undefined);
    try {
      const { requestId } = await requestManualPaymentApproval({
        sessionId: session.sessionId,
        txnId,
        reason,
        idempotencyKey: crypto.randomUUID(),
      });
      setApprovalReasonOpen(false);
      setApprovalRequestId(requestId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Request failed";
      const msg = raw.includes("TXN_NOT_AWAITING")
        ? "This sale is no longer awaiting payment"
        : raw.includes("NO_SESSION")
          ? "Session expired — please sign in again"
          : raw.includes("POS_BASE_URL not set")
            ? "Server config missing: POS_BASE_URL not set (contact dev)"
            : raw;
      setApprovalReasonError(msg);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  // ---- retry ----
  const [retrying, setRetrying] = useState(false);
  const handleRetry = async () => {
    if (session.status !== "active" || !txnId) return;
    setRetrying(true);
    try {
      await retryWithFreshInvoice({
        sessionId: session.sessionId,
        txnId,
        method: selectedMethod,
        idempotencyKey: crypto.randomUUID(),
      });
      // The reactive getCurrentInvoice picks up the new xendit_invoice_id, which
      // resets the ceiling timer via the [showingId] effect.
      setElapsedMs(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed";
      toast.error(msg);
    } finally {
      setRetrying(false);
    }
  };

  // ---- cancel ----
  const [cancelling, setCancelling] = useState(false);
  const handleCancel = async () => {
    if (session.status !== "active" || !txnId) return;
    setCancelling(true);
    try {
      await cancelTransaction({
        sessionId: session.sessionId,
        txnId,
        reason: "staff cancelled at charge",
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success("Sale cancelled");
      navigate("/sale");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Cancel failed";
      toast.error(msg);
    } finally {
      setCancelling(false);
    }
  };

  const handleMethodChange = (value: string) => {
    if (value === "QRIS" || value === "BCA_VA") {
      setSelectedMethod(value);
      setElapsedMs(0);
    }
  };

  // ---- render guards ----
  if (!txnId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center p-4">
        <p className="text-sm text-destructive">No transaction specified.</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate("/sale")}
        >
          Back to sale
        </Button>
      </main>
    );
  }

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    );
  }
  if (session.status !== "active") return null;

  // Whether the visible invoice matches the selected tab. While the new invoice
  // for a just-switched method is being created, the reactive invoice still
  // points at the previous method → show a spinner instead of stale QR/VA.
  const invoiceMatches = invoice != null && invoice.method === selectedMethod;

  // ---- voucher-reject banner handler ----
  // "Pick a different voucher" cancels the awaiting-payment txn and routes back
  // to /sale/voucher so the user can apply a fresh voucher to a new cart. If
  // cancel fails (network etc.), keep the banner visible and surface the error.
  const handlePickAnotherVoucher = async () => {
    if (session.status !== "active" || !txnId) return;
    try {
      await cancelAwaitingPayment({
        sessionId: session.sessionId,
        txnId,
        idempotencyKey: crypto.randomUUID(),
      });
      setVoucherRejected(undefined);
      navigate("/sale/voucher");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not cancel; try again";
      toast.error(msg);
    }
  };

  return (
    <SpokeLayout title="Payment">
      <section className="flex flex-1 flex-col items-center gap-4 overflow-y-auto p-4">
        {voucherRejected && (
          <div className="w-full max-w-sm">
            <VoucherRejectBanner
              rejected={voucherRejected}
              onPickAnother={handlePickAnotherVoucher}
            />
          </div>
        )}
        {phase.kind === "loading" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Preparing payment…</p>
          </div>
        ) : phase.kind === "cancelled" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">
              This sale was cancelled.
            </p>
            <Button variant="outline" onClick={() => navigate("/sale")}>
              New sale
            </Button>
          </div>
        ) : phase.kind === "paid" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Payment received…</p>
          </div>
        ) : (
          // phase.kind === "showing"
          <div className="flex w-full max-w-sm flex-1 flex-col items-center gap-4">
            {/* Amount due */}
            {txn != null && (
              <div className="flex flex-col items-center">
                <span className="text-xs tracking-widest text-muted-foreground">
                  AMOUNT DUE
                </span>
                <span className="text-2xl font-semibold tabular-nums">
                  {rp(txn.total)}
                </span>
              </div>
            )}

            {/* Method tabs */}
            <Tabs
              value={selectedMethod}
              onValueChange={handleMethodChange}
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="QRIS">QRIS</TabsTrigger>
                <TabsTrigger value="BCA_VA">BCA VA</TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Payment instrument */}
            <Card className="flex w-full flex-col items-center gap-3 p-5">
              {!invoiceMatches ? (
                <div className="flex flex-col items-center gap-2 py-6">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Generating {selectedMethod === "QRIS" ? "QR code" : "VA number"}…
                  </p>
                </div>
              ) : selectedMethod === "QRIS" ? (
                <>
                  <p className="text-xs font-medium tracking-widest text-muted-foreground">
                    SCAN TO PAY
                  </p>
                  {invoice?.qr_string ? (
                    // data-qr-id exposes the Xendit QR Codes API `id` (stored as
                    // xendit_invoice_id per convex/payments/schema.ts:7) so Playwright
                    // E2E specs can pass it to the simulate-paid endpoint
                    // (/qr_codes/{qrId}/payments/simulate). Conditional spread keeps
                    // a transient undefined off the DOM.
                    <div
                      className="rounded-lg bg-white p-3"
                      role="img"
                      aria-label="QRIS payment QR code"
                      {...(invoice.xendit_invoice_id
                        ? { "data-qr-id": invoice.xendit_invoice_id }
                        : {})}
                    >
                      <QRCodeSVG value={invoice.qr_string} size={220} marginSize={0} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No QR payload.</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Scan with any QRIS-enabled wallet
                  </p>
                </>
              ) : (
                // data-external-id exposes the Xendit FVA `external_id` so Playwright
                // E2E specs can hit /callback_virtual_accounts/external_id={id}/simulate_payment.
                // Derived as `pos-${txnId}` to match the initial-invoice ref minted in
                // convex/payments/actions.ts:47 — external_id is NOT persisted on
                // pos_xendit_invoices (schema stores only the FVA `id` as
                // xendit_invoice_id). Caveat: retryWithFreshInvoice uses a different
                // ref (`pos-${txnId}-r-${uuid}`, actions.ts:110), so this attribute
                // is only correct for the first invoice — sufficient for the E2E
                // specs (P4/P5/P6/P8), which don't exercise retry-then-simulate.
                <>
                  <p className="text-xs font-medium tracking-widest text-muted-foreground">
                    BCA VIRTUAL ACCOUNT
                  </p>
                  <p
                    className="select-all text-2xl font-semibold tabular-nums tracking-wider"
                    {...(txn?._id
                      ? { "data-external-id": `pos-${txn._id}` }
                      : {})}
                  >
                    {invoice?.va_number ?? "—"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Transfer the exact amount to this account
                  </p>
                </>
              )}
            </Card>

            {/* Countdown timer — shown only when an invoice is active */}
            {invoiceMatches && (
              <div className="w-full" data-testid="countdown-panel">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{selectedMethod === "QRIS" ? "QR" : "VA"} expires in {mmss}</span>
                </div>
                <Progress value={Math.min(pctRemaining * 100, 100)} className="mt-1 h-1" />
                {qrExpired && (
                  <p className="mt-2 text-sm text-amber-600" data-testid="countdown-expired-msg">
                    {selectedMethod === "QRIS" ? "QR" : "VA"} expired — tap Retry for a fresh one.
                  </p>
                )}
              </div>
            )}

            {/* Waiting / ceiling state */}
            {approvalRequestId ? (
              // Off-booth approval in progress — show the pending widget.
              // The reactive payment subscription (phase.kind === "paid") handles
              // navigation to charge-success when the manager approves, so
              // onResolved is wired as a no-op safety net in case the reactive
              // signal fires before the effect. onDenied / onExpired clears the
              // request so staff can try again.
              <div className="flex w-full flex-col gap-3">
                <Separator />
                <ApprovalPending
                  requestId={approvalRequestId}
                  onResolved={() => {
                    // The paid effect handles navigation; clear id to avoid stale state.
                    setApprovalRequestId(null);
                  }}
                  onDenied={() => {
                    setApprovalRequestId(null);
                    toast.error(
                      "Approval denied by manager — try again or contact them directly.",
                    );
                  }}
                  onExpired={() => {
                    setApprovalRequestId(null);
                    toast.error("Approval request expired — please try again.");
                  }}
                />
              </div>
            ) : !ceilingReached ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Waiting for payment…</span>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-3">
                <Separator />
                <p className="text-center text-sm text-muted-foreground">
                  Still waiting. Choose how to proceed:
                </p>
                <Button onClick={handleRetry} disabled={retrying}>
                  {retrying ? "Generating…" : "Retry (fresh QR)"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={session.staff.role !== "manager"}
                  title={
                    session.staff.role !== "manager"
                      ? "Sign in as a manager to use this, or use 'Request manager approval' below"
                      : undefined
                  }
                  onClick={() => {
                    setOverrideReason("");
                    setOverrideError(undefined);
                    setPickedManager(null);
                    setOverrideOpen(true);
                  }}
                >
                  Manager override
                </Button>
                {/* Off-booth path: request sent to managers' Telegram group. */}
                {!approvalReasonOpen ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setApprovalReason("");
                      setApprovalReasonError(undefined);
                      setApprovalReasonOpen(true);
                    }}
                  >
                    Request manager approval
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <textarea
                      data-testid="approval-reason-input"
                      value={approvalReason}
                      onChange={(e) => {
                        setApprovalReason(e.target.value);
                        if (approvalReasonError) setApprovalReasonError(undefined);
                      }}
                      placeholder="Why are you requesting manager approval?"
                      rows={2}
                      disabled={approvalSubmitting}
                      className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    {approvalReasonError && (
                      <p className="text-xs text-destructive">{approvalReasonError}</p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={handleRequestApproval}
                        disabled={approvalSubmitting || !approvalReason.trim()}
                      >
                        {approvalSubmitting ? "Sending…" : "Send request"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setApprovalReasonOpen(false);
                          setApprovalReasonError(undefined);
                        }}
                        disabled={approvalSubmitting}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? "Cancelling…" : "Cancel sale"}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Navigation guard: fires while txn is awaiting_payment */}
      <AbandonCartDialog
        variant="payment"
        open={blocker.state === "blocked"}
        onCancel={() => blocker.reset?.()}
        onProceed={() => blocker.proceed?.()}
        onCancelPayment={onCancelPaymentForBlocker}
      />

      {/* Manager picker — shown before the PIN sheet when override is triggered.
          Two-step: (1) pick which manager is at the booth, (2) enter their PIN.
          Shared with /refund flow via ManagerPickerOverlay. */}
      <ManagerPickerOverlay
        open={overrideOpen && !pickedManager}
        managers={managers}
        onPick={(m) => {
          setPickedManager(m);
          setOverrideError(undefined);
        }}
        onCancel={() => {
          setOverrideOpen(false);
          setPickedManager(null);
        }}
      />

      {/* Manager override PIN sheet — shown after a manager is picked.
          Reason is REQUIRED before the PIN confirm fires. */}
      <PinSheet
        open={overrideOpen && pickedManager !== null}
        title="Manager override"
        label={`Enter ${pickedManager?.name ?? "manager"}'s PIN to confirm payment`}
        pending={overridePending}
        error={overrideError}
        onSubmit={handleOverrideSubmit}
        onCancel={() => {
          if (!overridePending) {
            // Go back to picker step rather than closing entirely.
            setPickedManager(null);
            setOverrideError(undefined);
          }
        }}
        extraField={
          <div className="space-y-3">
            {/* Selected manager badge */}
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
              <span className="text-sm font-medium">{pickedManager?.name}</span>
              <span className="text-xs text-muted-foreground">{pickedManager?.code}</span>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="override-reason"
                className="text-xs font-medium text-muted-foreground"
              >
                Reason (required)
              </label>
              <textarea
                id="override-reason"
                data-testid="override-reason-input"
                value={overrideReason}
                onChange={(e) => {
                  setOverrideReason(e.target.value);
                  if (overrideError === "Reason is required") {
                    setOverrideError(undefined);
                  }
                }}
                placeholder="Why is a manual override needed?"
                rows={2}
                disabled={overridePending}
                className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
        }
      />
    </SpokeLayout>
  );
}
