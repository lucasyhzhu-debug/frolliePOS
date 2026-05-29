import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useAction } from "convex/react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  if (msg.includes("REQUEST_RESOLVED")) return "Already reset";
  if (msg.includes("NOT_MANAGER")) return "That staff code is not a manager";
  if (msg.includes("INVALID_PIN")) return "Wrong manager PIN";
  if (msg.includes("NEW_PIN_INVALID")) return "New PIN must be 4 digits";
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

/** Which PIN field the keypad is currently filling. */
type ActiveField = "managerPin" | "newPin";

export default function Approve() {
  const { token } = useParams<{ token: string }>();

  // useQuery returns undefined while loading, null when not found.
  const request = useQuery(
    api.approvals.public.getByToken,
    token ? { rawToken: token } : "skip",
  );

  // Form state
  const [staffCode, setStaffCode] = useState("");
  const [managerPin, setManagerPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [activeField, setActiveField] = useState<ActiveField>("managerPin");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [succeeded, setSucceeded] = useState(false);

  const idempotencyIntent = `approve-pin-reset:${token ?? "none"}`;
  const idempotencyKey = useIdempotency(idempotencyIntent);
  const approveAction = useAction(api.approvals.actions.approveStaffPinReset);

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
    if (!token) return;
    if (!idempotencyKey) return; // IDB not ready yet — single-paint guard
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
      setSucceeded(true);
    } catch (err) {
      const mapped = mapError(err);
      setError(mapped);
      // On certain terminal errors (token gone) clear the idempotency key so a
      // retry attempt gets a fresh UUID rather than re-hitting the dedup cache.
      if (
        mapped === "Invalid link" ||
        mapped === "Link expired" ||
        mapped === "Already reset"
      ) {
        void clearIntent(idempotencyIntent);
      }
    } finally {
      setPending(false);
    }
  }

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

  // ── Already resolved ─────────────────────────────────────────────────────
  if (request.status === "resolved") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <p className="text-sm font-medium">
          ✓ {request.subject_staff_name}&apos;s PIN has already been reset.
        </p>
      </main>
    );
  }

  // ── Success (just completed in this session) ─────────────────────────────
  if (succeeded) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 bg-background text-center">
        <CheckCircle2 className="h-8 w-8 text-teal-600" />
        <p className="text-sm font-medium">
          ✓ PIN reset — {request.subject_staff_name} can now log in with the new PIN.
        </p>
      </main>
    );
  }

  // ── Pending form ─────────────────────────────────────────────────────────
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
        {/* Manager staff code */}
        <div className="space-y-1.5">
          <Label htmlFor="staff-code">Your manager staff code</Label>
          <Input
            id="staff-code"
            type="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={staffCode}
            onChange={(e) => {
              setStaffCode(e.target.value);
              setError(undefined);
            }}
            placeholder="e.g. MGR01"
            disabled={pending}
          />
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
          <p
            role="alert"
            className="text-center text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {/* Submit */}
        <Button
          type="submit"
          disabled={
            pending ||
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
      </form>
    </main>
  );
}
