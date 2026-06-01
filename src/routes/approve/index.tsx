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
import { rp } from "@/lib/format";

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
  if (msg.includes("TOKEN_INVALID")) return "Invalid link";
  if (msg.includes("TOKEN_EXPIRED")) return "Link expired";
  // REQUEST_RESOLVED is emitted by BOTH the action-layer pre-check (actions.ts)
  // AND the internal-layer race guard (_markResolved/_markDenied_internal).
  // Single code, single mapping — see Simplify finding ALTITUDE-2.
  if (msg.includes("REQUEST_RESOLVED")) return "Already resolved";
  if (msg.includes("REQUEST_REVOKED")) return "Approval revoked — too many wrong PIN attempts. Ask the staffer to retry.";
  if (msg.includes("NOT_MANAGER")) return "That staff code is not a manager";
  if (msg.includes("INVALID_PIN")) return "Wrong manager PIN";
  if (msg.includes("NEW_PIN_INVALID")) return "New PIN must be 4 digits";
  if (msg.includes("WRONG_KIND")) return "Approval type mismatch";
  if (msg.includes("TXN_NOT_AWAITING")) return "Transaction is no longer awaiting payment";
  if (msg.includes("TXN_NOT_REFUNDABLE")) return "Transaction is not refundable";
  if (msg.includes("LINE_NOT_FOUND")) return "Refund line no longer exists";
  if (
    msg.includes("REQUEST_MISSING_TXN") ||
    msg.includes("REQUEST_MISSING_LINES") ||
    msg.includes("REQUEST_MISSING_REQUESTER")
  ) {
    return "Refund request is incomplete — please re-request";
  }
  return msg;
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
      setError("Manager PIN must be 4 digits");
      return;
    }
    if (newPin.length !== 4) {
      setError("New PIN must be 4 digits");
      return;
    }
    if (!staffCode.trim()) {
      setError("Enter your manager staff code");
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
      const mapped = mapError(err);
      setError(mapped);
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already resolved"
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
      setError("Select your manager identity");
      return;
    }
    if (managerPin.length !== 4) {
      setError("Manager PIN must be 4 digits");
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
      const mapped = mapError(err);
      setError(mapped);
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already resolved"
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
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <p className="text-sm font-medium">
          ✓ PIN reset — {request.subject_staff_name} can now log in with the new PIN.
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">
          Declined — PIN reset request rejected. {request.subject_staff_name} stays locked.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">Staff PIN Reset</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {request.subject_staff_name}
            {request.subject_staff_code ? ` (${request.subject_staff_code})` : ""}
          </span>{" "}
          is locked out. A manager can reset their PIN.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-5"
        aria-label="PIN reset form"
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="staff-code">Your manager identity</Label>
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
                    ? "Loading…"
                    : managers === null
                      ? "Link expired"
                      : managers.length === 0
                        ? "No managers configured"
                        : "Select a manager"
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
              Your manager PIN
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">Tap to enter</span>
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
              New PIN for {request.subject_staff_name}
            </span>
            {newPin.length > 0 ? (
              <PinDots value={newPin} />
            ) : (
              <span className="text-muted-foreground">Tap to enter</span>
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
              Resetting PIN…
            </>
          ) : (
            "Reset PIN"
          )}
        </Button>

        {/* Decline (deny — kind-agnostic denyRequest). New PIN is NOT required
            to decline; manager identity + manager PIN + reason are enough. */}
        {showDenyReason ? (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <Label htmlFor="deny-reason">Why are you declining?</Label>
            <Input
              id="deny-reason"
              type="text"
              autoComplete="off"
              value={denyReason}
              onChange={(e) => {
                setDenyReason(e.target.value);
                setError(undefined);
              }}
              placeholder="e.g. Suspicious lockout"
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
                    Declining…
                  </>
                ) : (
                  "Confirm decline"
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
                Cancel
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
            Decline reset request
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
      setError("Enter your manager staff code");
      return;
    }
    if (managerPin.length !== 4) {
      setError("Manager PIN must be 4 digits");
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
      const mapped = mapError(err);
      setError(mapped);
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already resolved"
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
      setError("Enter your manager staff code");
      return;
    }
    if (managerPin.length !== 4) {
      setError("Manager PIN must be 4 digits");
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
      const mapped = mapError(err);
      setError(mapped);
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already resolved"
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
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <p className="text-sm font-medium">
          ✓ Approved — payment of {rp(request.display.amount_idr)} confirmed.
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">Declined — payment request rejected.</p>
      </main>
    );
  }

  // ── Pending form ──────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">Manager approval needed</h1>
      </header>

      {/* Summary card */}
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Amount</span>
          <span className="font-semibold tabular-nums">
            {rp(request.display.amount_idr)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground shrink-0">Reason</span>
          <span className="text-right">{request.display.reason}</span>
        </div>
        {request.display.requester_name && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Requested by</span>
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
        aria-label="Manual payment approval form"
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="mgr-staff-code">Your manager identity</Label>
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
                    ? "Loading…"
                    : managers === null
                      ? "Link expired"
                      : managers.length === 0
                        ? "No managers configured"
                        : "Select a manager"
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
              Your manager PIN
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">Enter 4-digit PIN below</span>
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
            <Label htmlFor="deny-reason">Reason for declining</Label>
            <Input
              id="deny-reason"
              type="text"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder="e.g. Customer requested cancellation"
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
                    Approving…
                  </>
                ) : (
                  "Approve"
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
                Deny
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
                    Declining…
                  </>
                ) : (
                  "Confirm Deny"
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
                Cancel
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
      setError("Enter your manager staff code");
      return;
    }
    if (managerPin.length !== 4) {
      setError("Manager PIN must be 4 digits");
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
      const mapped = mapError(err);
      setError(mapped);
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already resolved"
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
      setError("Enter your manager staff code");
      return;
    }
    if (managerPin.length !== 4) {
      setError("Manager PIN must be 4 digits");
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
      const mapped = mapError(err);
      setError(mapped);
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already resolved"
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
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <p className="text-sm font-medium">
          ✓ Approved — refund of {rp(request.display.total_refund)} committed.
        </p>
      </main>
    );
  }

  if (outcome === "denied") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">Declined — refund request rejected.</p>
      </main>
    );
  }

  // ── Pending form ──────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col items-center justify-start gap-6 p-6 bg-background">
      <header className="w-full max-w-sm text-center pt-6">
        <h1 className="text-lg font-semibold">Manager approval needed — Refund</h1>
      </header>

      {/* Summary card */}
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Receipt</span>
          <span className="font-medium tabular-nums">
            {request.display.receipt_number}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total refund</span>
          <span className="font-semibold tabular-nums text-foreground">
            {rp(request.display.total_refund)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground shrink-0">Reason</span>
          <span className="text-right">{request.display.reason}</span>
        </div>
        {request.display.requester_name && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Requested by</span>
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
        aria-label="Refund approval form"
      >
        {/* Manager identity picker (token-gated query — ADR-029) */}
        <div className="space-y-1.5">
          <Label htmlFor="mgr-staff-code">Your manager identity</Label>
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
                    ? "Loading…"
                    : managers === null
                      ? "Link expired"
                      : managers.length === 0
                        ? "No managers configured"
                        : "Select a manager"
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
              Your manager PIN
            </span>
            {managerPin.length > 0 ? (
              <PinDots value={managerPin} />
            ) : (
              <span className="text-muted-foreground">Enter 4-digit PIN below</span>
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
            <Label htmlFor="deny-reason">Reason for declining</Label>
            <Input
              id="deny-reason"
              type="text"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder="e.g. Items still in customer's possession"
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
                    Approving…
                  </>
                ) : (
                  "Approve"
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
                Deny
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
                    Declining…
                  </>
                ) : (
                  "Confirm Deny"
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
                Cancel
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
  resolvedMsg: (req: any) => React.ReactNode;
  deniedMsg: (req: any, denierLabel: string) => React.ReactNode;
  deniedExtra?: (req: any) => React.ReactNode;
};

const TERMINAL_COPY: Record<string, TerminalCopy> = {
  staff_pin_reset: {
    resolvedMsg: (req) => (
      <>✓ {req.subject_staff_name}&apos;s PIN has already been reset.</>
    ),
    deniedMsg: (req, denierLabel) => (
      <>
        PIN reset for {req.subject_staff_name} was declined by {denierLabel}.
      </>
    ),
    deniedExtra: (req) => (
      <p className="text-xs text-muted-foreground">
        {req.subject_staff_name} stays locked until the natural lockout cycle expires.
      </p>
    ),
  },
  manual_payment_override: {
    resolvedMsg: (req) => (
      <>✓ Payment of {rp(req.display.amount_idr)} already approved.</>
    ),
    deniedMsg: (req, denierLabel) => (
      <>
        Payment of {rp(req.display.amount_idr)} was declined by {denierLabel}.
      </>
    ),
  },
  refund: {
    resolvedMsg: (req) => (
      <>✓ Refund of {rp(req.display.total_refund)} already approved.</>
    ),
    deniedMsg: (req, denierLabel) => (
      <>
        Refund of {rp(req.display.total_refund)} was declined by {denierLabel}.
      </>
    ),
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Root route component — dispatches on request.kind
// ────────────────────────────────────────────────────────────────────────────

export default function Approve() {
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
        <p className="text-sm text-muted-foreground">Checking link…</p>
      </main>
    );
  }

  // ── Invalid / expired (null result or status="expired") ──────────────────
  if (request === null || request.status === "expired") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <p className="text-sm text-muted-foreground">
          This reset link has expired or is invalid.
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
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <p className="text-sm font-medium">{copy.resolvedMsg(request)}</p>
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
            Approval revoked — too many wrong PIN attempts. Ask the staffer to retry.
          </p>
        </main>
      );
    }

    const denierName = request.denied_by_manager_name;
    const denierCode = request.denied_by_manager_code;
    const denierLabel =
      denierName && denierCode
        ? `${denierName} (${denierCode})`
        : denierName ?? denierCode ?? "a manager";
    const reason = request.deny_reason;

    const copy = TERMINAL_COPY[request.kind];
    if (!copy) return null;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <XCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{copy.deniedMsg(request, denierLabel)}</p>
        {reason && (
          <p className="text-sm text-muted-foreground italic">
            &ldquo;{reason}&rdquo;
          </p>
        )}
        {copy.deniedExtra?.(request)}
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

  // Unknown kind — neutral fallback for future kinds not yet handled in UI
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
      <p className="text-sm text-muted-foreground">
        This approval type is not yet supported in this view.
      </p>
    </main>
  );
}
