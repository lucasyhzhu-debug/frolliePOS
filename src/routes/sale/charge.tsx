import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIsOnline } from "@/hooks/useIsOnline";
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
import { FieldMessage } from "@/components/ui/field-message";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { AbandonCartDialog } from "@/components/pos/AbandonCartDialog";
import { PinSheet } from "@/components/pos/PinSheet";
import { ApprovalPending } from "@/components/pos/ApprovalPending";
import { ManagerPickerOverlay } from "@/components/pos/ManagerPickerOverlay";
import { VoucherRejectBanner } from "./voucher-reject-banner";
import { toast } from "sonner";
import { reportOps } from "@/lib/reportOps";
import { useT } from "@/lib/i18n";

type VoucherRejected = {
  code: string;
  reason: "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "MIN_CART_VALUE";
};
type NavState = { voucher_rejected?: VoucherRejected };

type Method = "QRIS" | "MANUAL_BCA";

/**
 * Charge screen — the payment confirmation surface (ADR strategic foundations
 * §8, amended by ADR-036). Reads :txnId, drives a Xendit invoice per method, and
 * subscribes to payment status reactively via useXenditPayment (webhook-driven;
 * polling retired per ADR-036). At the 60s ceiling it reveals the three CTAs:
 * Retry (fresh invoice), Manager override (manual confirm), Cancel sale.
 *
 * State-machine shape:
 *   - selectedMethod: which tab is active (QRIS default; MANUAL_BCA = staff-
 *     confirmed bank transfer, which never mints a Xendit invoice — v1.2 #10).
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
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const isOnline = useIsOnline();
  const offlineLocked = !isOnline;
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

  // Inline error for the QRIS auto-create path (replaces a toast per ADR-048).
  const [chargeError, setChargeError] = useState<string | undefined>(undefined);

  // ---- manual bank-transfer tender state (v1.2 #10) ----
  const [attested, setAttested] = useState(false);
  const [manualPending, setManualPending] = useState(false);
  const [manualError, setManualError] = useState<string | undefined>(undefined);

  // Payment polling + reactive phase. useXenditPayment requires a concrete id;
  // when the param is missing we fall back to a placeholder and render an error
  // below (txnId === undefined never produces a real subscription).
  const { phase, invoice, txn } = useXenditPayment(
    (txnId ?? "") as Id<"pos_transactions">,
    // SEC-05/06: session-gated reads. Placeholder when the session isn't active
    // yet — the gated queries return null and the route renders its guard below.
    (session.status === "active" ? session.sessionId : "") as Id<"staff_sessions">,
  );

  // Idempotency key for the INITIAL invoice of the selected method. Stable per
  // (txnId, method) so a re-render replays the same key and the server / Xendit
  // dedupe rather than minting a second invoice.
  const initKey = useIdempotency(`pay:${txnId ?? "none"}:${selectedMethod}`);

  // ---- manual bank-transfer tender (v1.2 #10) ----
  // Staff-readable account config. The "Bank transfer" tab + manual tender only
  // render when manualBca.enabled. Skip while the session isn't active (the
  // query is session-gated).
  const manualBca = useQuery(
    api.settings.public.getManualBcaAccount,
    session.status === "active" ? { sessionId: session.sessionId } : "skip",
  );
  // Stable per-txn key for the manual confirm mutation (ADR-013).
  const manualConfirmKey = useIdempotency(`confirm-manual:${txnId ?? "none"}`);
  const confirmManualBcaPayment = useMutation(
    api.payments.public.confirmManualBcaPayment,
  );

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
  // `allowWithin` whitelists this txn's own charge subtree (notably the paid
  // `/success` receipt) as in-flow, so a post-confirm navigate is never tripped
  // by the abandon guard. Without it, the manual-BCA confirm navigates the same
  // synchronous tick it commits — before the reactive `txn` query flips to
  // "paid" — so `when` is still armed and the guard blocks the in-flow hop to
  // /success. Destination-prefix matching sidesteps that stale-state race
  // (same pattern the /sale → /sale/charge hop uses). Leaving the charge to any
  // path OUTSIDE this subtree (/sale, /, a shift gate) still raises the guard.
  // Set true right before a deliberate-exit navigate (Cancel sale / pick another
  // voucher). After an explicit cancel commits, the reactive `txn` is still stale
  // `awaiting_payment` at navigate time, so `when` stays armed and the blocker
  // would pop the "Cancel payment?" dialog AFTER the user already cancelled —
  // firing a redundant second cancel (TXN_NOT_AWAITING / INVALID_STATE_FOR_CANCEL).
  // The ref is read live inside the predicate, sidestepping that same-tick race.
  const leavingRef = useRef(false);
  const blocker = usePathChangeBlocker(
    txn?.status === "awaiting_payment",
    txnId ? `/sale/charge/${txnId}` : undefined,
    leavingRef,
  );

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
    // The manual bank-transfer tab never mints a Xendit invoice — bail before
    // any requestPayment/retry call.
    if (selectedMethod === "MANUAL_BCA") return;
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
    // The effect early-returns for MANUAL_BCA above, so the only method that
    // reaches the Xendit create/retry calls is QRIS (v1.2 #10).
    const method = "QRIS" as const;
    const idempotencyKey = initKey;
    setChargeError(undefined);
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
        reportOps({ kind: "payment", error: err, route: "useXenditPayment" });
        const msg =
          err instanceof Error ? err.message : t("charge.errorCouldNotStart");
        // Inline on the QRIS card (ADR-048) instead of a toast.
        setChargeError(msg);
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
      setOverrideError(t("charge.errorReasonRequired"));
      return;
    }
    if (!pickedManager) {
      setOverrideError(t("charge.errorSelectManager"));
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
          ? t("charge.errorWrongPin")
          : msg.includes("MANAGER_NOT_FOUND")
            ? t("charge.errorManagerNotFound")
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
      setApprovalReasonError(t("charge.errorReasonRequired"));
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
        ? t("charge.errorTxnNotAwaiting")
        : raw.includes("NO_SESSION")
          ? t("charge.errorSessionExpiredSignIn")
          : raw.includes("POS_BASE_URL not set")
            ? t("charge.errorServerConfig")
            : raw;
      setApprovalReasonError(msg);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  // ---- manual bank-transfer confirm (v1.2 #10) ----
  // Staff attests the customer's transfer + proof, then commits the sale via
  // confirmManualBcaPayment. Navigates on the AWAITED result — there is no
  // invoice, so the reactive phase.kind==="paid" effect can never fire (C1).
  const handleManualConfirm = async () => {
    if (session.status !== "active" || !txnId || !manualConfirmKey) return;
    setManualPending(true);
    setManualError(undefined);
    try {
      await confirmManualBcaPayment({
        idempotencyKey: manualConfirmKey,
        sessionId: session.sessionId,
        txnId,
      });
      navigate(`/sale/charge/${txnId}/success`, { replace: true });
    } catch (err) {
      // Map raw server codes to friendly copy (mirrors handleOverrideSubmit).
      // RECEIPT_UNCONFIRMED = txn no longer awaiting (cancelled/expired race) or
      // no receipt minted; NO_SESSION = session lapsed. Fallback keeps the raw
      // message so an unexpected code is still surfaced (not swallowed).
      const raw = err instanceof Error ? err.message : "Could not confirm payment";
      const msg = raw.includes("RECEIPT_UNCONFIRMED")
        ? t("charge.errorTxnNotWaiting")
        : raw.includes("NO_SESSION")
          ? t("charge.errorSessionExpiredLogIn")
          : raw;
      setManualError(msg);
    } finally {
      setManualPending(false);
    }
  };

  // ---- retry ----
  const [retrying, setRetrying] = useState(false);
  const handleRetry = async () => {
    if (session.status !== "active" || !txnId) return;
    setRetrying(true);
    try {
      // Retry is only reachable from the QRIS ceiling state — the manual tab
      // never mints an invoice (v1.2 #10), so the method is always QRIS here.
      await retryWithFreshInvoice({
        sessionId: session.sessionId,
        txnId,
        method: "QRIS",
        idempotencyKey: crypto.randomUUID(),
      });
      // The reactive getCurrentInvoice picks up the new xendit_invoice_id, which
      // resets the ceiling timer via the [showingId] effect.
      setElapsedMs(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("charge.errorRetryFailed");
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
      toast.success(t("charge.toastSaleCancelled"));
      // Deliberate exit — disarm the awaiting_payment blocker so the stale
      // reactive txn doesn't pop a redundant "Cancel payment?" dialog.
      leavingRef.current = true;
      navigate("/sale");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("charge.errorCancelFailed");
      toast.error(msg);
    } finally {
      setCancelling(false);
    }
  };

  const handleMethodChange = (value: string) => {
    if (value === "QRIS" || value === "MANUAL_BCA") {
      setSelectedMethod(value);
      setElapsedMs(0);
      // Re-attestation is required each time the manual tab is entered — clear
      // any stale checkbox/error so the confirm button can't carry over enabled.
      setAttested(false);
      setManualError(undefined);
    }
  };

  // ---- render guards ----
  if (!txnId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center p-4">
        <p className="text-sm text-destructive">{t("charge.noTxn")}</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate("/sale")}
        >
          {t("charge.backToSale")}
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
      // Deliberate exit — disarm the blocker (see leavingRef note above).
      leavingRef.current = true;
      navigate("/sale/voucher");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not cancel; try again";
      toast.error(msg);
    }
  };

  return (
    <SpokeLayout title={t("charge.title")}>
      <section className="flex flex-1 flex-col items-center gap-4 overflow-y-auto p-4">
        {voucherRejected && (
          <div className="w-full max-w-sm">
            <VoucherRejectBanner
              rejected={voucherRejected}
              onPickAnother={handlePickAnotherVoucher}
            />
          </div>
        )}
        {/* Shared method switcher — rendered ABOVE the phase machine so staff
            can reach the manual tab even while QRIS is still "loading" (its
            invoice hasn't minted yet). Only shown when the manual option exists;
            with QRIS-only there's nothing to switch between. */}
        {manualBca?.enabled && (
          <Tabs
            value={selectedMethod}
            onValueChange={handleMethodChange}
            className="w-full max-w-sm"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="QRIS" disabled={offlineLocked}>{"QRIS"}</TabsTrigger>
              <TabsTrigger value="MANUAL_BCA" disabled={offlineLocked}>
                {t("charge.tabBankTransfer")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {/* C1: the manual bank-transfer tab is rendered BEFORE/OUTSIDE the
            phase machine. It never mints an invoice, so phase.kind is stuck on
            "loading" — gating it behind the phase switch would pin it on the
            spinner forever. Navigation happens on the AWAITED confirm result,
            not via a reactive phase.kind==="paid" effect (which can't fire). */}
        {selectedMethod === "MANUAL_BCA" ? (
          <div className="flex w-full max-w-sm flex-1 flex-col items-center gap-4">
            {/* Offline banner — confirming a sale requires connectivity (ADR-025) */}
            {offlineLocked && (
              <div
                role="alert"
                className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {t("charge.offlineManual")}
              </div>
            )}

            {/* Amount due */}
            {txn != null && (
              <div className="flex flex-col items-center">
                <span className="text-xs tracking-widest text-muted-foreground">
                  {t("charge.amountDue")}
                </span>
                <span className="text-2xl font-semibold tabular-nums">
                  {rp(txn.total)}
                </span>
              </div>
            )}

            {/* Transfer-to account details */}
            <Card className="flex w-full flex-col gap-2 p-5">
              <p className="text-xs font-medium tracking-widest text-muted-foreground">
                {t("charge.transferTo")}
              </p>
              <p className="text-sm">
                {manualBca?.bank_name} · {manualBca?.account_name}
              </p>
              <p className="select-all text-2xl font-semibold tabular-nums tracking-wider">
                {manualBca?.account_number ?? "—"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t("charge.transferInstruction")}
              </p>
            </Card>

            {/* Attestation gate */}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
                disabled={manualPending}
                className="mt-1"
              />
              <span>
                {t("charge.attestationLabel")}
              </span>
            </label>

            {manualError && <FieldMessage tone="error">{manualError}</FieldMessage>}

            <Button
              className="w-full"
              disabled={!attested || manualPending || offlineLocked}
              onClick={handleManualConfirm}
            >
              {manualPending ? t("charge.confirming") : t("charge.confirmPayment")}
            </Button>

            {/* Cancel affordance — without this the manual tab has no way to
                abandon a sale except switching tabs (and both tabs disable
                offline). Offline-disabled like the QRIS footer (cancel
                invalidates the QR/VA, which needs connectivity, ADR-025). */}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={handleCancel}
              disabled={cancelling || offlineLocked}
            >
              {cancelling ? t("charge.cancelling") : t("charge.cancelSale")}
            </Button>
          </div>
        ) : phase.kind === "loading" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("charge.preparingPayment")}</p>
          </div>
        ) : phase.kind === "cancelled" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">
              {t("charge.saleCancelled")}
            </p>
            <Button variant="outline" onClick={() => navigate("/sale")}>
              {t("charge.newSale")}
            </Button>
          </div>
        ) : phase.kind === "paid" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("charge.paymentReceived")}</p>
          </div>
        ) : (
          // phase.kind === "showing"
          <div className="flex w-full max-w-sm flex-1 flex-col items-center gap-4">
            {/* Offline banner — payments require connectivity (ADR-025) */}
            {offlineLocked && (
              <div
                role="alert"
                className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {t("charge.offlineQris")}
              </div>
            )}

            {/* Amount due */}
            {txn != null && (
              <div className="flex flex-col items-center">
                <span className="text-xs tracking-widest text-muted-foreground">
                  {t("charge.amountDue")}
                </span>
                <span className="text-2xl font-semibold tabular-nums">
                  {rp(txn.total)}
                </span>
              </div>
            )}

            {/* Method tabs are rendered above the phase switch (shared switcher). */}

            {/* Payment instrument — QRIS only (BCA VA retired, v1.2 #10). The
                manual bank-transfer tender is rendered as a separate top-level
                branch above, never via this invoice-driven path. */}
            <Card className="flex w-full flex-col items-center gap-3 p-5">
              {!invoiceMatches ? (
                <div className="flex flex-col items-center gap-2 py-6">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {t("charge.generatingQr")}
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-xs font-medium tracking-widest text-muted-foreground">
                    {t("charge.scanToPay")}
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
                      aria-label={t("charge.qrAriaLabel")}
                      {...(invoice.xendit_invoice_id
                        ? { "data-qr-id": invoice.xendit_invoice_id }
                        : {})}
                    >
                      <QRCodeSVG value={invoice.qr_string} size={220} marginSize={0} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("charge.noQrPayload")}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {t("charge.scanHint")}
                  </p>
                </>
              )}
            </Card>

            {/* Inline auto-create error (ADR-048) — replaces the prior toast. */}
            {chargeError && (
              <div className="w-full">
                <FieldMessage tone="error">{chargeError}</FieldMessage>
              </div>
            )}

            {/* Countdown timer — shown only when an invoice is active */}
            {invoiceMatches && (
              <div className="w-full" data-testid="countdown-panel">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t("charge.qrExpiresIn", { mmss })}</span>
                </div>
                <Progress value={Math.min(pctRemaining * 100, 100)} className="mt-1 h-1" />
                {qrExpired && (
                  <p className="mt-2 text-sm text-warning" data-testid="countdown-expired-msg">
                    {t("charge.qrExpired")}
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
                <span>{t("charge.waitingForPayment")}</span>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-3">
                <Separator />
                <p className="text-center text-sm text-muted-foreground">
                  {t("charge.stillWaiting")}
                </p>
                <Button onClick={handleRetry} disabled={retrying || offlineLocked}>
                  {retrying ? t("charge.generating") : t("charge.retryFreshQr")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={session.staff.role !== "manager" || offlineLocked}
                  title={
                    session.staff.role !== "manager"
                      ? t("charge.managerOverrideTip")
                      : undefined
                  }
                  onClick={() => {
                    setOverrideReason("");
                    setOverrideError(undefined);
                    setPickedManager(null);
                    setOverrideOpen(true);
                  }}
                >
                  {t("charge.managerOverride")}
                </Button>
                {/* Off-booth path: request sent to managers' Telegram group. */}
                {!approvalReasonOpen ? (
                  <Button
                    variant="outline"
                    disabled={offlineLocked}
                    onClick={() => {
                      setApprovalReason("");
                      setApprovalReasonError(undefined);
                      setApprovalReasonOpen(true);
                    }}
                  >
                    {t("charge.requestManagerApproval")}
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
                      placeholder={t("charge.approvalReasonPlaceholder")}
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
                        disabled={approvalSubmitting || !approvalReason.trim() || offlineLocked}
                      >
                        {approvalSubmitting ? t("charge.sending") : t("charge.sendRequest")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setApprovalReasonOpen(false);
                          setApprovalReasonError(undefined);
                        }}
                        disabled={approvalSubmitting}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
                {/* Offline-disabled like the other server actions (ADR-025). A txn stuck
                    awaiting_payment offline is recovered by the awaiting-payment banner
                    (useAwaitingPaymentRecovery) once connectivity returns. */}
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={handleCancel}
                  disabled={cancelling || offlineLocked}
                >
                  {cancelling ? t("charge.cancelling") : t("charge.cancelSale")}
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
        title={t("charge.managerOverride")}
        label={t("charge.pinSheetLabel", { name: pickedManager?.name ?? t("charge.managerFallback") })}
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
                {t("charge.reasonRequired")}
              </label>
              <textarea
                id="override-reason"
                data-testid="override-reason-input"
                value={overrideReason}
                onChange={(e) => {
                  setOverrideReason(e.target.value);
                  if (overrideError === t("charge.errorReasonRequired")) {
                    setOverrideError(undefined);
                  }
                }}
                placeholder={t("charge.overrideReasonPlaceholder")}
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
