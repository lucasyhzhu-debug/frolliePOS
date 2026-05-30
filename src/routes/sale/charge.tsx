import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useNavigate, useParams } from "react-router";
import { useAction } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useXenditPayment, PAYMENT_CEILING_MS } from "@/hooks/useXenditPayment";
import { useIdempotency } from "@/hooks/useIdempotency";
import { rp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnDot } from "@/components/layout/ConnDot";
import { PinSheet } from "@/components/pos/PinSheet";
import { ApprovalPending } from "@/components/pos/ApprovalPending";
import { toast } from "sonner";

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
  const session = useSession();
  const { txnId: txnIdParam } = useParams<{ txnId: string }>();
  const txnId = txnIdParam as Id<"pos_transactions"> | undefined;

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
  // Wave 4 Task 18 will replace this with a manager-picker dropdown.
  // For now the caller must supply a code via the PinSheet title/UI; this
  // placeholder satisfies the type until the picker is wired up.
  const [overrideManagerCode, setOverrideManagerCode] = useState("");

  const handleOverrideSubmit = async (pin: string) => {
    if (session.status !== "active" || !txnId) return;
    const reason = overrideReason.trim();
    if (!reason) {
      setOverrideError("Reason is required");
      return;
    }
    if (!overrideManagerCode.trim()) {
      setOverrideError("Manager code is required");
      return;
    }
    setOverridePending(true);
    setOverrideError(undefined);
    try {
      await manuallyConfirmPayment({
        sessionId: session.sessionId,
        txnId,
        managerStaffCode: overrideManagerCode.trim(),
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

  return (
    <main className="flex flex-1 flex-col gap-0 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-base font-semibold">Charge</h1>
        <ConnDot />
      </header>

      <section className="flex flex-1 flex-col items-center gap-4 overflow-y-auto p-4">
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
                    <div className="rounded-lg bg-white p-3" role="img" aria-label="QRIS payment QR code">
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
                <>
                  <p className="text-xs font-medium tracking-widest text-muted-foreground">
                    BCA VIRTUAL ACCOUNT
                  </p>
                  <p className="select-all text-2xl font-semibold tabular-nums tracking-wider">
                    {invoice?.va_number ?? "—"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Transfer the exact amount to this account
                  </p>
                </>
              )}
            </Card>

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
                  onDenied={() => setApprovalRequestId(null)}
                  onExpired={() => setApprovalRequestId(null)}
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

      {/* Manager override PIN sheet — reason is REQUIRED before confirm fires. */}
      <PinSheet
        open={overrideOpen}
        title="Manager override"
        label={`Enter your PIN, ${session.staff.name} — confirms payment`}
        pending={overridePending}
        error={overrideError}
        onSubmit={handleOverrideSubmit}
        onCancel={() => {
          if (!overridePending) setOverrideOpen(false);
        }}
        extraField={
          <div className="space-y-3">
            {/* Wave 4 Task 18 replaces this text input with a manager-picker
                dropdown populated from _listActiveManagers_internal. */}
            <div className="space-y-1.5">
              <label
                htmlFor="override-mgr-code"
                className="text-xs font-medium text-muted-foreground"
              >
                Manager code (required)
              </label>
              <input
                id="override-mgr-code"
                type="text"
                value={overrideManagerCode}
                onChange={(e) => {
                  setOverrideManagerCode(e.target.value);
                  if (overrideError === "Manager code is required") {
                    setOverrideError(undefined);
                  }
                }}
                placeholder="e.g. M-0001"
                disabled={overridePending}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
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
    </main>
  );
}
