import { useState, useEffect } from "react";
import { useParams } from "react-router";
import { useQuery, useAction } from "convex/react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { rp, fmtTime, fmtDate, fmtShiftDuration } from "@/lib/format";
import { useT } from "@/lib/i18n";

/*
 * SERVICE-WORKER NOTE (staffreview Improvement #13):
 * This route MUST use a NETWORK-FIRST service-worker policy so the Convex
 * token-validity check is always performed against the live server, never
 * served from the SW cache. A stale cached response could let an expired or
 * already-resolved link appear as pending. Configure the SW (vite-plugin-pwa
 * runtimeCaching) to apply NetworkFirst for /approve/* and the Convex WS/HTTP
 * origin in v0.4 when the SW strategy is hardened.
 */

/** Map thrown action error codes to human-readable messages. */
function mapError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("TOKEN_INVALID")) return "TOKEN_INVALID";
  if (msg.includes("TOKEN_EXPIRED")) return "TOKEN_EXPIRED";
  // REQUEST_RESOLVED is emitted by BOTH the action-layer pre-check (actions.ts)
  // AND the internal-layer race guard (_markResolved/_markDenied_internal).
  // Single code, single mapping — see Simplify finding ALTITUDE-2.
  if (msg.includes("REQUEST_RESOLVED")) return "REQUEST_RESOLVED";
  if (msg.includes("REQUEST_REVOKED")) return "REQUEST_REVOKED";
  if (msg.includes("NOT_MANAGER")) return "NOT_MANAGER";
  if (msg.includes("INVALID_PIN")) return "INVALID_PIN";
  if (msg.includes("NEW_PIN_INVALID")) return "NEW_PIN_INVALID";
  if (msg.includes("WRONG_KIND")) return "WRONG_KIND";
  if (msg.includes("SHIFT_CHANGED")) return "SHIFT_CHANGED";
  if (msg.includes("TXN_NOT_AWAITING")) return "TXN_NOT_AWAITING";
  if (msg.includes("TXN_NOT_REFUNDABLE")) return "TXN_NOT_REFUNDABLE";
  if (msg.includes("LINE_NOT_FOUND")) return "LINE_NOT_FOUND";
  if (
    msg.includes("REQUEST_MISSING_TXN") ||
    msg.includes("REQUEST_MISSING_LINES") ||
    msg.includes("REQUEST_MISSING_REQUESTER")
  ) {
    return "REQUEST_MISSING";
  }
  return msg;
}

function useErrorMessage() {
  const t = useT();
  return (code: string): string => {
    switch (code) {
      case "TOKEN_INVALID": return t("approve.errTokenInvalid");
      case "TOKEN_EXPIRED": return t("approve.errTokenExpired");
      case "REQUEST_RESOLVED": return t("approve.errAlreadyResolved");
      case "REQUEST_REVOKED": return t("approve.errRequestRevoked");
      case "NOT_MANAGER": return t("approve.errNotManager");
      case "INVALID_PIN": return t("approve.errInvalidPin");
      case "NEW_PIN_INVALID": return t("approve.errNewPinInvalid");
      case "WRONG_KIND": return t("approve.errWrongKind");
      case "SHIFT_CHANGED": return t("approve.shiftOverrideStaleShift");
      case "TXN_NOT_AWAITING": return t("approve.errTxnNotAwaiting");
      case "TXN_NOT_REFUNDABLE": return t("approve.errTxnNotRefundable");
      case "LINE_NOT_FOUND": return t("approve.errLineNotFound");
      case "REQUEST_MISSING": return t("approve.errRequestMissing");
      default: return code;
    }
  };
}

/** 4-dot PIN display — shows filled/empty dots based on current entry length. */
function PinDots({ value }: { value: string }) {
  return (
    <div className="flex gap-3 justify-center" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className={`h-3 w-3 rounded-full border-2 transition-colors ${
            i < value.length
              ? "border-foreground bg-foreground"
              : "border-muted-foreground bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// staff_pin_reset variant
// ────────────────────────────────────────────────────────────────────────────

/** Which PIN field the keypad is currently filling (pin_reset flow). */
type ActiveField = "managerPin" | "newPin";

interface PinResetProps {
  token: string;
  request: {
    kind: "staff_pin_reset";
    subject_staff_name: string;
    subject_staff_code?: string;
    status: string;
    token_expires_at: number;
    // Populated when status is "denied" (getByToken backend fills these)
    deny_reason?: string;
    denied_by_manager_name?: string;
    denied_by_manager_code?: string;
    denied_at?: number;
  };
}

function PinResetVariant({ token, request }: PinResetProps) {
  const t = useT();
  const mapErr = useErrorMessage();
  const [staffCode, setStaffCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [activeField, setActiveField] = useState<ActiveField>("managerPin");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  // Deny-flow state — mirrors the manual_payment variant
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [denyPending, setDenyPending] = useState(false);

  const idempotencyIntent = `approve-pin-reset:${token}`;
  const idempotencyKey = useIdempotency(idempotencyIntent);
  const denyIntent = `deny-pin-reset:${token}`;
  const denyKey = useIdempotency(denyIntent);
  const approveAction = useAction(api.approvals.actions.approveStaffPinReset);
  const denyAction = useAction(api.approvals.actions.denyRequest);

  // Token-gated active-managers list for the picker (replaces the v0.4 text input)
  const managers = useQuery(api.approvals.public.listActiveManagers, { token });

  // Auto-advance: once the manager PIN reaches 4 digits, move focus to new PIN
  useEffect(() => {
    if (activeField === "managerPin" && managerPin.length === 4) {
      setActiveField("newPin");
    }
  }, [managerPin, activeField]);

  function handleKeyPress(key: string) {
    setError(undefined);
    if (activeField === "managerPin") {
      setManagerPin((prev) => {
        if (key === "C") return "";
        if (key === "⌫") return prev.slice(0, -1);
        return prev.length < 4 ? prev + key : prev;
      });
    } else {
      setNewPin((prev) => {
        if (key === "C") return "";
        if (key === "⌫") return prev.slice(0, -1);
        return prev.length < 4 ? prev + key : prev;
      });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!idempotencyKey) return;
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }
    if (newPin.length !== 4) {
      setError(t("approve.validationNewPin"));
      return;
    }
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      await approveAction({
        token,
        managerPin,
        newPin,
        managerStaffCode: staffCode.trim(),
        idempotencyKey,
      });
      setOutcome("approved");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(idempotencyIntent);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDeny() {
    if (!denyKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationManagerIdentity"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }
    if (!denyReason.trim()) return;

    setDenyPending(true);
    setError(undefined);
    try {
      await denyAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        denyReason: denyReason.trim(),
        idempotencyKey: denyKey,
      });
      setOutcome("denied");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(denyIntent);
      }
    } finally {
      setDenyPending(false);
    }
  }

  if (outcome === "approved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-primary" />
        <p className="text-sm font-medium">
          {t("approve.pinResetApproved", { name: request.subject_staff_name })}
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">
          {t("approve.pinResetDenied", { name: request.subject_staff_name })}
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">{t("approve.pinResetTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {request.subject_staff_name}
            {request.subject_staff_code ? ` (${request.subject_staff_code})` : ""}
          </span>{" "}
          {t("approve.pinResetSubtitle")}
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-5"
        aria-label={t("approve.pinResetFormLabel")}
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="staff-code">{t("approve.managerIdentityLabel")}</Label>
          <Select
            value={staffCode}
            onValueChange={(value) => {
              setStaffCode(value);
              setError(undefined);
            }}
            disabled={pending || managers === undefined || managers === null}
          >
            <SelectTrigger id="staff-code">
              <SelectValue
                placeholder={
                  managers === undefined
                    ? t("common.loading")
                    : managers === null
                      ? t("approve.linkExpired")
                      : managers.length === 0
                        ? t("approve.noManagers")
                        : t("approve.selectManager")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {managers?.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.code} — {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Manager PIN entry */}
        <div className="space-y-2">
          <button
            type="button"
            className={`w-full rounded-md border px-3 py-2.5 text-left text-sm transition-colors ${
              activeField === "managerPin"
                ? "border-ring ring-1 ring-ring"
                : "border-input"
            }`}
            onClick={() => setActiveField("managerPin")}
            disabled={pending}
            aria-pressed={activeField === "managerPin"}
          >
            <span className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("approve.managerPinLabel")}
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">{t("approve.tapToEnter")}</span>
            )}
          </button>
        </div>

        {/* New PIN entry */}
        <div className="space-y-2">
          <button
            type="button"
            className={`w-full rounded-md border px-3 py-2.5 text-left text-sm transition-colors ${
              activeField === "newPin"
                ? "border-ring ring-1 ring-ring"
                : "border-input"
            }`}
            onClick={() => setActiveField("newPin")}
            disabled={pending}
            aria-pressed={activeField === "newPin"}
          >
            <span className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("approve.newPinLabel", { name: request.subject_staff_name })}
            </span>
            {newPin.length > 0 ? (
              <PinDots value={newPin} />
            ) : (
              <span className="text-muted-foreground">{t("approve.tapToEnter")}</span>
            )}
          </button>
        </div>

        {/* Shared keypad — drives whichever field is active */}
        <NumericKeypad
          onPress={handleKeyPress}
          onClear={() => handleKeyPress("C")}
          onBackspace={() => handleKeyPress("⌫")}
          size="compact"
        />

        {/* Error message */}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Submit (approve = reset PIN) */}
        <Button
          type="submit"
          disabled={
            pending ||
            denyPending ||
            !idempotencyKey ||
            staffCode.trim().length === 0 ||
            managerPin.length !== 4 ||
            newPin.length !== 4
          }
          className="w-full"
        >
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("approve.resettingPin")}
            </>
          ) : (
            t("approve.resetPin")
          )}
        </Button>

        {/* Decline (deny — kind-agnostic denyRequest). New PIN is NOT required
            to decline; manager identity + manager PIN + reason are enough. */}
        {showDenyReason ? (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <Label htmlFor="deny-reason">{t("approve.denyReasonLabel")}</Label>
            <Input
              id="deny-reason"
              type="text"
              autoComplete="off"
              value={denyReason}
              onChange={(e) => {
                setDenyReason(e.target.value);
                setError(undefined);
              }}
              placeholder={t("approve.denyReasonPlaceholderPinReset")}
              disabled={denyPending}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleConfirmDeny}
                disabled={
                  denyPending ||
                  !denyKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4 ||
                  denyReason.trim().length === 0
                }
              >
                {denyPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.declining")}
                  </>
                ) : (
                  t("approve.confirmDecline")
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDenyReason(false);
                  setDenyReason("");
                  setError(undefined);
                }}
                disabled={denyPending}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setShowDenyReason(true);
              setError(undefined);
            }}
            disabled={
              pending ||
              denyPending ||
              staffCode.trim().length === 0 ||
              managerPin.length !== 4
            }
            className="w-full"
          >
            {t("approve.declineResetRequest")}
          </Button>
        )}
      </form>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// manual_payment_override variant
// ────────────────────────────────────────────────────────────────────────────

interface ManualPaymentProps {
  token: string;
  request: {
    kind: "manual_payment_override";
    display: {
      amount_idr: number;
      reason: string;
      receipt_preview?: string;
      requester_name?: string;
    };
    status: string;
    token_expires_at: number;
    // Populated when status is "denied" (getByToken backend fills these)
    deny_reason?: string;
    denied_by_manager_name?: string;
    denied_by_manager_code?: string;
    denied_at?: number;
  };
}

function ManualPaymentVariant({ token, request }: ManualPaymentProps) {
  const t = useT();
  const mapErr = useErrorMessage();
  const [staffCode, setStaffCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Deny-flow state
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [denyPending, setDenyPending] = useState(false);

  // Terminal outcome state
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  const approveIntent = `approve-payment:${token}`;
  const denyIntent = `deny-payment:${token}`;
  const approveKey = useIdempotency(approveIntent);
  const denyKey = useIdempotency(denyIntent);

  const approveAction = useAction(api.approvals.actions.approveManualPayment);
  const denyAction = useAction(api.approvals.actions.denyRequest);

  // Token-gated active-managers list for the picker (replaces v0.4 text input)
  const managers = useQuery(api.approvals.public.listActiveManagers, { token });

  function handleKeyPress(key: string) {
    setError(undefined);
    setManagerPin((prev) => {
      if (key === "C") return "";
      if (key === "⌫") return prev.slice(0, -1);
      return prev.length < 4 ? prev + key : prev;
    });
  }

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault();
    if (!approveKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      await approveAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        idempotencyKey: approveKey,
      });
      setOutcome("approved");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(approveIntent);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDeny() {
    if (!denyKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }
    if (!denyReason.trim()) return;

    setDenyPending(true);
    setError(undefined);
    try {
      await denyAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        denyReason: denyReason.trim(),
        idempotencyKey: denyKey,
      });
      setOutcome("denied");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(denyIntent);
      }
    } finally {
      setDenyPending(false);
    }
  }

  // ── Outcome screens ────────────────────────────────────────────────────────
  if (outcome === "approved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-primary" />
        <p className="text-sm font-medium">
          {t("approve.paymentApproved", { amount: rp(request.display.amount_idr) })}
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{t("approve.paymentDenied")}</p>
      </main>
    );
  }

  // ── Pending form ──────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">{t("approve.managerApprovalNeeded")}</h1>
      </header>

      {/* Summary card */}
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.amount")}</span>
          <span className="font-semibold tabular-nums">
            {rp(request.display.amount_idr)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground shrink-0">{t("approve.reason")}</span>
          <span className="text-right">{request.display.reason}</span>
        </div>
        {request.display.requester_name && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("approve.requestedBy")}</span>
            <span>{request.display.requester_name}</span>
          </div>
        )}
        {request.display.receipt_preview && (
          <div className="pt-1 border-t border-border">
            <span className="text-muted-foreground text-xs">{request.display.receipt_preview}</span>
          </div>
        )}
      </div>

      <form
        onSubmit={handleApprove}
        className="flex w-full max-w-sm flex-col gap-5"
        aria-label={t("approve.paymentFormLabel")}
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="mgr-staff-code">{t("approve.managerIdentityLabel")}</Label>
          <Select
            value={staffCode}
            onValueChange={(value) => {
              setStaffCode(value);
              setError(undefined);
            }}
            disabled={pending || denyPending || managers === undefined || managers === null}
          >
            <SelectTrigger id="mgr-staff-code">
              <SelectValue
                placeholder={
                  managers === undefined
                    ? t("common.loading")
                    : managers === null
                      ? t("approve.linkExpired")
                      : managers.length === 0
                        ? t("approve.noManagers")
                        : t("approve.selectManager")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {managers?.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.code} — {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Manager PIN entry */}
        <div className="space-y-2">
          <div className="w-full rounded-md border border-input px-3 py-2.5 text-sm">
            <span className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("approve.managerPinLabel")}
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">{t("approve.enter4DigitPin")}</span>
            )}
          </div>
          <NumericKeypad
            onPress={handleKeyPress}
            onClear={() => handleKeyPress("C")}
            onBackspace={() => handleKeyPress("⌫")}
            size="compact"
          />
        </div>

        {/* Error message */}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Deny reason input — revealed after clicking Deny */}
        {showDenyReason && (
          <div className="space-y-1.5">
            <Label htmlFor="deny-reason">{t("approve.reasonForDeclining")}</Label>
            <Input
              id="deny-reason"
              type="text"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder={t("approve.denyReasonPlaceholderPayment")}
              disabled={denyPending}
              autoFocus
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          {!showDenyReason ? (
            <>
              <Button
                type="submit"
                disabled={
                  pending ||
                  denyPending ||
                  !approveKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4
                }
                className="w-full"
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.approving")}
                  </>
                ) : (
                  t("approve.approve")
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => {
                  setError(undefined);
                  setShowDenyReason(true);
                }}
                disabled={pending || denyPending}
              >
                {t("approve.deny")}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                onClick={handleConfirmDeny}
                disabled={
                  denyPending ||
                  pending ||
                  !denyKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4 ||
                  denyReason.trim().length === 0
                }
              >
                {denyPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.declining")}
                  </>
                ) : (
                  t("approve.confirmDeny")
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setShowDenyReason(false);
                  setDenyReason("");
                  setError(undefined);
                }}
                disabled={denyPending}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
        </div>
      </form>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// refund variant (v0.5.1 PR B / B25)
// ────────────────────────────────────────────────────────────────────────────

interface RefundProps {
  token: string;
  request: {
    kind: "refund";
    display: {
      receipt_number: string;
      total_refund: number;
      reason: string;
      lines: Array<{
        product_name: string;
        refund_qty: number;
        refund_amount: number;
      }>;
      requester_name?: string;
    };
    status: string;
    token_expires_at: number;
    deny_reason?: string;
    denied_by_manager_name?: string;
    denied_by_manager_code?: string;
    denied_at?: number;
  };
}

function RefundVariant({ token, request }: RefundProps) {
  const t = useT();
  const mapErr = useErrorMessage();
  const [staffCode, setStaffCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Deny-flow state
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [denyPending, setDenyPending] = useState(false);

  // Terminal outcome state
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  const approveIntent = `approve-refund:${token}`;
  const denyIntent = `deny-refund:${token}`;
  const approveKey = useIdempotency(approveIntent);
  const denyKey = useIdempotency(denyIntent);

  const approveAction = useAction(api.approvals.actions.approveRefund);
  const denyAction = useAction(api.approvals.actions.denyRequest);

  // Token-gated active-managers list for the picker (ADR-029)
  const managers = useQuery(api.approvals.public.listActiveManagers, { token });

  function handleKeyPress(key: string) {
    setError(undefined);
    setManagerPin((prev) => {
      if (key === "C") return "";
      if (key === "⌫") return prev.slice(0, -1);
      return prev.length < 4 ? prev + key : prev;
    });
  }

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault();
    if (!approveKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      await approveAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        idempotencyKey: approveKey,
      });
      setOutcome("approved");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(approveIntent);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDeny() {
    if (!denyKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }
    if (!denyReason.trim()) return;

    setDenyPending(true);
    setError(undefined);
    try {
      await denyAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        denyReason: denyReason.trim(),
        idempotencyKey: denyKey,
      });
      setOutcome("denied");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(denyIntent);
      }
    } finally {
      setDenyPending(false);
    }
  }

  // ── Outcome screens ────────────────────────────────────────────────────────
  if (outcome === "approved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-primary" />
        <p className="text-sm font-medium">
          {t("approve.refundApproved", { amount: rp(request.display.total_refund) })}
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{t("approve.refundDenied")}</p>
      </main>
    );
  }

  // ── Pending form ──────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">{t("approve.managerApprovalNeededRefund")}</h1>
      </header>

      {/* Summary card */}
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.receipt")}</span>
          <span className="font-medium tabular-nums">
            {request.display.receipt_number}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.totalRefund")}</span>
          <span className="font-semibold tabular-nums text-foreground">
            {rp(request.display.total_refund)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground shrink-0">{t("approve.reason")}</span>
          <span className="text-right">{request.display.reason}</span>
        </div>
        {request.display.requester_name && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("approve.requestedBy")}</span>
            <span>{request.display.requester_name}</span>
          </div>
        )}
        {request.display.lines.length > 0 && (
          <div className="pt-2 border-t border-border space-y-1">
            {request.display.lines.map((l, i) => (
              <div
                key={`${l.product_name}-${i}`}
                className="flex justify-between text-xs text-muted-foreground"
              >
                <span>
                  {l.product_name} × {l.refund_qty}
                </span>
                <span className="tabular-nums">{rp(l.refund_amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={handleApprove}
        className="flex w-full max-w-sm flex-col gap-5"
        aria-label={t("approve.refundFormLabel")}
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="mgr-staff-code">{t("approve.managerIdentityLabel")}</Label>
          <Select
            value={staffCode}
            onValueChange={(value) => {
              setStaffCode(value);
              setError(undefined);
            }}
            disabled={pending || denyPending || managers === undefined || managers === null}
          >
            <SelectTrigger id="mgr-staff-code">
              <SelectValue
                placeholder={
                  managers === undefined
                    ? t("common.loading")
                    : managers === null
                      ? t("approve.linkExpired")
                      : managers.length === 0
                        ? t("approve.noManagers")
                        : t("approve.selectManager")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {managers?.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.code} — {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Manager PIN entry */}
        <div className="space-y-2">
          <div className="w-full rounded-md border border-input px-3 py-2.5 text-sm">
            <span className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("approve.managerPinLabel")}
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">{t("approve.enter4DigitPin")}</span>
            )}
          </div>
          <NumericKeypad
            onPress={handleKeyPress}
            onClear={() => handleKeyPress("C")}
            onBackspace={() => handleKeyPress("⌫")}
            size="compact"
          />
        </div>

        {/* Error message */}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Deny reason input — revealed after clicking Deny */}
        {showDenyReason && (
          <div className="space-y-1.5">
            <Label htmlFor="deny-reason">{t("approve.reasonForDeclining")}</Label>
            <Input
              id="deny-reason"
              type="text"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder={t("approve.denyReasonPlaceholderRefund")}
              disabled={denyPending}
              autoFocus
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          {!showDenyReason ? (
            <>
              <Button
                type="submit"
                disabled={
                  pending ||
                  denyPending ||
                  !approveKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4
                }
                className="w-full"
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.approving")}
                  </>
                ) : (
                  t("approve.approve")
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => {
                  setError(undefined);
                  setShowDenyReason(true);
                }}
                disabled={pending || denyPending}
              >
                {t("approve.deny")}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                onClick={handleConfirmDeny}
                disabled={
                  denyPending ||
                  pending ||
                  !denyKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4 ||
                  denyReason.trim().length === 0
                }
              >
                {denyPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.declining")}
                  </>
                ) : (
                  t("approve.confirmDeny")
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setShowDenyReason(false);
                  setDenyReason("");
                  setError(undefined);
                }}
                disabled={denyPending}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
        </div>
      </form>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// spoilage variant (v0.6 S7)
// ────────────────────────────────────────────────────────────────────────────

interface SpoilageProps {
  token: string;
  request: {
    kind: "spoilage";
    display: {
      spoilage_event_id: string;
      total_qty: number;
      reason: string;
      lines: Array<{ sku_code: string; qty: number }>;
      requester_name?: string;
    };
    status: string;
    token_expires_at: number;
    // Populated when status is "denied" (getByToken backend fills these)
    deny_reason?: string;
    denied_by_manager_name?: string;
    denied_by_manager_code?: string;
    denied_at?: number;
  };
}

function SpoilageVariant({ token, request }: SpoilageProps) {
  const t = useT();
  const mapErr = useErrorMessage();
  const [staffCode, setStaffCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Deny-flow state — mirrors RefundVariant
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [denyPending, setDenyPending] = useState(false);

  // Terminal outcome state
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  const approveIntent = `approve-spoilage:${token}`;
  const denyIntent = `deny-spoilage:${token}`;
  const approveKey = useIdempotency(approveIntent);
  const denyKey = useIdempotency(denyIntent);

  const approveAction = useAction(api.approvals.actions.approveSpoilage);
  const denyAction = useAction(api.approvals.actions.denyRequest);

  // Token-gated active-managers list (ADR-029)
  const managers = useQuery(api.approvals.public.listActiveManagers, { token });

  function handleKeyPress(key: string) {
    setError(undefined);
    setManagerPin((prev) => {
      if (key === "C") return "";
      if (key === "⌫") return prev.slice(0, -1);
      return prev.length < 4 ? prev + key : prev;
    });
  }

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault();
    if (!approveKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      await approveAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        idempotencyKey: approveKey,
      });
      setOutcome("approved");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(approveIntent);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDeny() {
    if (!denyKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }
    if (!denyReason.trim()) return;

    setDenyPending(true);
    setError(undefined);
    try {
      await denyAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        denyReason: denyReason.trim(),
        idempotencyKey: denyKey,
      });
      setOutcome("denied");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(denyIntent);
      }
    } finally {
      setDenyPending(false);
    }
  }

  // ── Outcome screens ────────────────────────────────────────────────────────
  if (outcome === "approved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-primary" />
        <p className="text-sm font-medium">
          {t("approve.spoilageApproved", { qty: String(request.display.total_qty) })}
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{t("approve.spoilageDenied")}</p>
      </main>
    );
  }

  // ── Pending form ──────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">{t("approve.managerApprovalNeededSpoilage")}</h1>
      </header>

      {/* Summary card */}
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.totalUnits")}</span>
          <span className="font-semibold tabular-nums text-foreground">
            {request.display.total_qty}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground shrink-0">{t("approve.reason")}</span>
          <span className="text-right">{request.display.reason}</span>
        </div>
        {request.display.requester_name && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("approve.requestedBy")}</span>
            <span>{request.display.requester_name}</span>
          </div>
        )}
        {request.display.lines.length > 0 && (
          <div className="pt-2 border-t border-border space-y-1">
            {request.display.lines.map((l, i) => (
              <div
                key={`${l.sku_code}-${i}`}
                className="flex justify-between text-xs text-muted-foreground"
              >
                <span>{l.sku_code}</span>
                <span className="tabular-nums">× {l.qty}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={handleApprove}
        className="flex w-full max-w-sm flex-col gap-5"
        aria-label={t("approve.spoilageFormLabel")}
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="mgr-staff-code">{t("approve.managerIdentityLabel")}</Label>
          <Select
            value={staffCode}
            onValueChange={(value) => {
              setStaffCode(value);
              setError(undefined);
            }}
            disabled={pending || denyPending || managers === undefined || managers === null}
          >
            <SelectTrigger id="mgr-staff-code">
              <SelectValue
                placeholder={
                  managers === undefined
                    ? t("common.loading")
                    : managers === null
                      ? t("approve.linkExpired")
                      : managers.length === 0
                        ? t("approve.noManagers")
                        : t("approve.selectManager")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {managers?.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.code} — {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Manager PIN entry */}
        <div className="space-y-2">
          <div className="w-full rounded-md border border-input px-3 py-2.5 text-sm">
            <span className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("approve.managerPinLabel")}
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">{t("approve.enter4DigitPin")}</span>
            )}
          </div>
          <NumericKeypad
            onPress={handleKeyPress}
            onClear={() => handleKeyPress("C")}
            onBackspace={() => handleKeyPress("⌫")}
            size="compact"
          />
        </div>

        {/* Error message */}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Deny reason input — revealed after clicking Deny */}
        {showDenyReason && (
          <div className="space-y-1.5">
            <Label htmlFor="deny-reason">{t("approve.reasonForDeclining")}</Label>
            <Input
              id="deny-reason"
              type="text"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder={t("approve.denyReasonPlaceholderSpoilage")}
              disabled={denyPending}
              autoFocus
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          {!showDenyReason ? (
            <>
              <Button
                type="submit"
                disabled={
                  pending ||
                  denyPending ||
                  !approveKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4
                }
                className="w-full"
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.approving")}
                  </>
                ) : (
                  t("approve.approve")
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => {
                  setError(undefined);
                  setShowDenyReason(true);
                }}
                disabled={pending || denyPending}
              >
                {t("approve.deny")}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                onClick={handleConfirmDeny}
                disabled={
                  denyPending ||
                  pending ||
                  !denyKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4 ||
                  denyReason.trim().length === 0
                }
              >
                {denyPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.declining")}
                  </>
                ) : (
                  t("approve.confirmDeny")
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setShowDenyReason(false);
                  setDenyReason("");
                  setError(undefined);
                }}
                disabled={denyPending}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
        </div>
      </form>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// shift_override variant (v1.3.1)
// ────────────────────────────────────────────────────────────────────────────

interface ShiftOverrideProps {
  token: string;
  request: {
    kind: "shift_override";
    outlet_label: string;
    stranded_staff_name: string;
    shift_started_at: number;
    sales_so_far_idr: number;
    txn_count: number;
    status: string;
    token_expires_at: number;
    deny_reason?: string;
    denied_by_manager_name?: string;
    denied_by_manager_code?: string;
    denied_at?: number;
  };
}

function ShiftOverrideVariant({ token, request }: ShiftOverrideProps) {
  const t = useT();
  const mapErr = useErrorMessage();
  const [staffCode, setStaffCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [resultingState, setResultingState] = useState<"close" | "release">("close");

  // Deny-flow state — mirrors SpoilageVariant
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [denyPending, setDenyPending] = useState(false);

  // Terminal outcome state
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  const approveIntent = `approve-shift-override:${token}`;
  const denyIntent = `deny-shift-override:${token}`;
  const approveKey = useIdempotency(approveIntent);
  const denyKey = useIdempotency(denyIntent);

  const approveAction = useAction(api.approvals.actions.approveShiftOverride);
  const denyAction = useAction(api.approvals.actions.denyRequest);

  // Token-gated active-managers list (ADR-029)
  const managers = useQuery(api.approvals.public.listActiveManagers, { token });

  function handleKeyPress(key: string) {
    setError(undefined);
    setManagerPin((prev) => {
      if (key === "C") return "";
      if (key === "⌫") return prev.slice(0, -1);
      return prev.length < 4 ? prev + key : prev;
    });
  }

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault();
    if (!approveKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      await approveAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        resultingState,
        idempotencyKey: approveKey,
      });
      setOutcome("approved");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED" ||
        code === "SHIFT_CHANGED"
      ) {
        void clearIntent(approveIntent);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleConfirmDeny() {
    if (!denyKey) return;
    if (!staffCode.trim()) {
      setError(t("approve.validationStaffCode"));
      return;
    }
    if (managerPin.length !== 4) {
      setError(t("approve.validationManagerPin"));
      return;
    }
    if (!denyReason.trim()) return;

    setDenyPending(true);
    setError(undefined);
    try {
      await denyAction({
        token,
        managerStaffCode: staffCode.trim(),
        managerPin,
        denyReason: denyReason.trim(),
        idempotencyKey: denyKey,
      });
      setOutcome("denied");
    } catch (err) {
      const code = mapError(err);
      const mapped = mapErr(code);
      setError(mapped);
      if (
        code === "TOKEN_INVALID" ||
        code === "TOKEN_EXPIRED" ||
        code === "REQUEST_RESOLVED"
      ) {
        void clearIntent(denyIntent);
      }
    } finally {
      setDenyPending(false);
    }
  }

  // ── Outcome screens ────────────────────────────────────────────────────────
  if (outcome === "approved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-primary" />
        <p className="text-sm font-medium">{t("approve.shiftOverrideApproved")}</p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{t("approve.shiftOverrideDenied")}</p>
      </main>
    );
  }

  // ── Pending form ──────────────────────────────────────────────────────────
  const shiftDurationMs = Date.now() - request.shift_started_at;

  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">{t("approve.shiftOverrideTitle")}</h1>
      </header>

      {/* Context card */}
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.shiftOverrideOutlet")}</span>
          <span className="font-semibold">{request.outlet_label}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.shiftOverrideHeldBy")}</span>
          <span className="font-semibold">{request.stranded_staff_name}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.shiftOverrideShiftStarted")}</span>
          <span className="tabular-nums">
            {fmtTime(request.shift_started_at)}{" "}
            <span className="text-muted-foreground">
              {fmtDate(request.shift_started_at)}
            </span>
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.shiftOverrideDuration")}</span>
          <span className="tabular-nums">{fmtShiftDuration(shiftDurationMs)}</span>
        </div>
        <div className="pt-2 border-t border-border flex justify-between">
          <span className="text-muted-foreground">{t("approve.shiftOverrideSalesSoFar")}</span>
          <span className="font-semibold tabular-nums">{rp(request.sales_so_far_idr)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("approve.shiftOverrideTxnCount")}</span>
          <span className="tabular-nums">{request.txn_count}</span>
        </div>
      </div>

      {/* Close / Release choice */}
      <div className="w-full max-w-sm grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={resultingState === "close" ? "default" : "outline"}
          onClick={() => setResultingState("close")}
          disabled={pending || denyPending}
        >
          {t("approve.outcomeClose")}
        </Button>
        <Button
          type="button"
          variant={resultingState === "release" ? "default" : "outline"}
          onClick={() => setResultingState("release")}
          disabled={pending || denyPending}
        >
          {t("approve.outcomeRelease")}
        </Button>
      </div>

      <form
        onSubmit={handleApprove}
        className="flex w-full max-w-sm flex-col gap-5"
        aria-label={t("approve.shiftOverrideFormLabel")}
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="mgr-staff-code">{t("approve.managerIdentityLabel")}</Label>
          <Select
            value={staffCode}
            onValueChange={(value) => {
              setStaffCode(value);
              setError(undefined);
            }}
            disabled={pending || denyPending || managers === undefined || managers === null}
          >
            <SelectTrigger id="mgr-staff-code">
              <SelectValue
                placeholder={
                  managers === undefined
                    ? t("common.loading")
                    : managers === null
                      ? t("approve.linkExpired")
                      : managers.length === 0
                        ? t("approve.noManagers")
                        : t("approve.selectManager")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {managers?.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.code} — {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Manager PIN entry */}
        <div className="space-y-2">
          <div className="w-full rounded-md border border-input px-3 py-2.5 text-sm">
            <span className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("approve.managerPinLabel")}
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">{t("approve.enter4DigitPin")}</span>
            )}
          </div>
          <NumericKeypad
            onPress={handleKeyPress}
            onClear={() => handleKeyPress("C")}
            onBackspace={() => handleKeyPress("⌫")}
            size="compact"
          />
        </div>

        {/* Error message */}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Deny reason input — revealed after clicking Deny */}
        {showDenyReason && (
          <div className="space-y-1.5">
            <Label htmlFor="deny-reason">{t("approve.reasonForDeclining")}</Label>
            <Input
              id="deny-reason"
              type="text"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder={t("approve.denyReasonPlaceholderShiftOverride")}
              disabled={denyPending}
              autoFocus
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          {!showDenyReason ? (
            <>
              <Button
                type="submit"
                disabled={
                  pending ||
                  denyPending ||
                  !approveKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4
                }
                className="w-full"
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.approving")}
                  </>
                ) : (
                  t("approve.approve")
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => {
                  setError(undefined);
                  setShowDenyReason(true);
                }}
                disabled={pending || denyPending}
              >
                {t("approve.deny")}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="destructive"
                className="w-full"
                onClick={handleConfirmDeny}
                disabled={
                  denyPending ||
                  pending ||
                  !denyKey ||
                  staffCode.trim().length === 0 ||
                  managerPin.length !== 4 ||
                  denyReason.trim().length === 0
                }
              >
                {denyPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("approve.declining")}
                  </>
                ) : (
                  t("approve.confirmDeny")
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setShowDenyReason(false);
                  setDenyReason("");
                  setError(undefined);
                }}
                disabled={denyPending}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
        </div>
      </form>
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Terminal-state per-kind copy registry
// ────────────────────────────────────────────────────────────────────────────
//
// Collapses 6 near-identical resolved/denied JSX blocks (3 kinds × 2 states)
// into one config object + one render helper per terminal status. Adding a new
// approval kind in v0.6 requires one entry here rather than two more blocks.
//
// `req` is typed as `any` at the call site (intentional — the parent narrows
// `request.kind` before the lookup, so the variant fields each renderer reads
// are guaranteed present by the discriminated union at that point). A mapped
// generic would be tighter but adds a typing tax disproportionate to a 3-kind
// table; the call-site narrowing is the safety net.

type TerminalCopy = {
  resolvedMsg: (req: any, t: ReturnType<typeof useT>) => React.ReactNode;
  deniedMsg: (req: any, denierLabel: string, t: ReturnType<typeof useT>) => React.ReactNode;
  deniedExtra?: (req: any, t: ReturnType<typeof useT>) => React.ReactNode;
};

const TERMINAL_COPY: Record<string, TerminalCopy> = {
  staff_pin_reset: {
    resolvedMsg: (req, t) => t("approve.terminalPinResetResolved", { name: req.subject_staff_name }),
    deniedMsg: (req, denierLabel, t) =>
      t("approve.terminalPinResetDenied", { name: req.subject_staff_name, denier: denierLabel }),
    deniedExtra: (req, t) => (
      <p className="text-xs text-muted-foreground">
        {t("approve.terminalPinResetDeniedExtra", { name: req.subject_staff_name })}
      </p>
    ),
  },
  manual_payment_override: {
    resolvedMsg: (req, t) =>
      t("approve.terminalPaymentResolved", { amount: rp(req.display.amount_idr) }),
    deniedMsg: (req, denierLabel, t) =>
      t("approve.terminalPaymentDenied", { amount: rp(req.display.amount_idr), denier: denierLabel }),
  },
  refund: {
    resolvedMsg: (req, t) =>
      t("approve.terminalRefundResolved", { amount: rp(req.display.total_refund) }),
    deniedMsg: (req, denierLabel, t) =>
      t("approve.terminalRefundDenied", { amount: rp(req.display.total_refund), denier: denierLabel }),
  },
  spoilage: {
    resolvedMsg: (req, t) =>
      t("approve.terminalSpoilageResolved", { qty: String(req.display.total_qty) }),
    deniedMsg: (req, denierLabel, t) =>
      t("approve.terminalSpoilageDenied", { qty: String(req.display.total_qty), denier: denierLabel }),
  },
  shift_override: {
    resolvedMsg: (_req, t) => t("approve.terminalShiftOverrideResolved"),
    deniedMsg: (_req, denierLabel, t) =>
      t("approve.terminalShiftOverrideDenied", { denier: denierLabel }),
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Root route component — dispatches on request.kind
// ────────────────────────────────────────────────────────────────────────────

export default function Approve() {
  const t = useT();
  const { token } = useParams<{ token: string }>();

  // useQuery returns undefined while loading, null when not found.
  const request = useQuery(
    api.approvals.public.getByToken,
    token ? { rawToken: token } : "skip",
  );

  // ── Loading ──────────────────────────────────────────────────────────────
  if (request === undefined) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("approve.checkingLink")}</p>
      </main>
    );
  }

  // ── Invalid / expired (null result or status="expired") ──────────────────
  if (request === null || request.status === "expired") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <p className="text-sm text-muted-foreground">
          {t("approve.linkExpiredOrInvalid")}
        </p>
      </main>
    );
  }

  // ── Already RESOLVED (terminal: approved + committed) ───────────────────
  if (request.status === "resolved") {
    const copy = TERMINAL_COPY[request.kind];
    if (!copy) return null;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-primary" />
        <p className="text-sm font-medium">{copy.resolvedMsg(request, t)}</p>
      </main>
    );
  }

  // ── Already DENIED (terminal: declined, includes reason + manager) ──────
  if (request.status === "denied") {
    // System auto-revoke due to too many wrong PIN attempts — show a distinct
    // "ask for a fresh approval" message rather than the manager-deny copy.
    // Preserved AS-IS; must run BEFORE the per-kind dispatch.
    if (request.deny_reason === "too_many_pin_attempts") {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
          <XCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm font-medium">
            {t("approve.errRequestRevoked")}
          </p>
        </main>
      );
    }

    const denierName = request.denied_by_manager_name;
    const denierCode = request.denied_by_manager_code;
    const denierLabel =
      denierName && denierCode
        ? `${denierName} (${denierCode})`
        : denierName ?? denierCode ?? t("approve.aManager");
    const reason = request.deny_reason;

    const copy = TERMINAL_COPY[request.kind];
    if (!copy) return null;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{copy.deniedMsg(request, denierLabel, t)}</p>
        {reason && (
          <p className="text-sm text-muted-foreground italic">
            &ldquo;{reason}&rdquo;
          </p>
        )}
        {copy.deniedExtra?.(request, t)}
      </main>
    );
  }

  // ── Dispatch on kind ──────────────────────────────────────────────────────
  if (!token) return null;

  if (request.kind === "staff_pin_reset") {
    return <PinResetVariant token={token} request={request} />;
  }

  if (request.kind === "manual_payment_override") {
    return <ManualPaymentVariant token={token} request={request} />;
  }

  if (request.kind === "refund") {
    return <RefundVariant token={token} request={request} />;
  }

  if (request.kind === "spoilage") {
    return <SpoilageVariant token={token} request={request} />;
  }

  if (request.kind === "shift_override") {
    return <ShiftOverrideVariant token={token} request={request} />;
  }

  // Unknown kind — neutral fallback for future kinds not yet handled in UI
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
      <p className="text-sm text-muted-foreground">
        {t("approve.unsupportedKind")}
      </p>
    </main>
  );
}
