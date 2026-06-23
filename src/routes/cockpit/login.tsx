import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useAction } from "convex/react";
import { motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { storeCockpitSession } from "@/hooks/useSession";
import { REMEMBER_DEVICE_TOKEN_KEY } from "@/lib/storage-keys";
import type { Id } from "../../../convex/_generated/dataModel";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { FieldMessage } from "@/components/ui/field-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";

/**
 * Owner cockpit login (v2.0 owner-auth WS6, ADR-052). The third auth plane
 * (OTP authorises MANAGE — extends ADR-029). Route-owned phase machine mirroring
 * the booth login pattern (src/routes/login.tsx): the route owns the phases,
 * a presentational keypad renders the entry.
 *
 * Phases:
 *   quick   — a remembered-device token exists → quick-PIN keypad FIRST (fast
 *             return path), with a "Use a login code instead" escape to `identifier`.
 *   identifier — email/staff-code text entry → requestOwnerOtp (DM to Telegram).
 *   otp     — 6-digit OTP keypad → verifyOwnerOtp → storeSession → remember.
 *   remember — optional quick-PIN enrolment (registerRememberedDevice) → home.
 *
 * The owner amber theme (.theme-owner) is applied by RootLayout on /cockpit/*, so
 * this route uses SEMANTIC tokens only (bg-background, bg-card, text-primary,
 * FieldMessage) and re-themes automatically — no hardcoded owner hexes here.
 *
 * NOTE (Spec-3 boundary): the cockpit dashboard / screens are out of scope. This
 * is the login route + gate + theme only; on success we navigate to "/cockpit".
 */

type Phase =
  | { kind: "quick" }
  | { kind: "identifier" }
  | { kind: "otp" }
  | { kind: "remember"; sessionId: string };

// Inline async result-state for a keypad submit (idle → pending → error | success),
// surfaced via FieldMessage (ADR-048), never a toast.
type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

const COCKPIT_HOME = "/cockpit";

export default function CockpitLoginRoute() {
  const navigate = useNavigate();
  const deviceId = useDeviceId();
  const t = useT();
  const reduceMotion = useReducedMotion();

  const requestOtp = useAction(api.auth.ownerActions.requestOwnerOtp);
  const verifyOtp = useAction(api.auth.ownerActions.verifyOwnerOtp);
  const quickLogin = useAction(api.auth.ownerActions.quickPinLogin);
  const registerRemembered = useAction(api.auth.ownerActions.registerRememberedDevice);

  // A remembered-device token on THIS device picks the quick-PIN fast path first.
  // Read once at mount (lazy init) — the value only gates the initial phase and
  // the submit handlers; it doesn't need a re-read on every render.
  const [rememberToken] = useState(() =>
    typeof localStorage !== "undefined"
      ? localStorage.getItem(REMEMBER_DEVICE_TOKEN_KEY)
      : null,
  );

  const [identifier, setIdentifier] = useState("");
  // `committedIdentifier` is the value the OTP / quick-PIN was issued against —
  // pinned once the request succeeds so a later verify uses the same value even
  // if the field were re-rendered.
  const [committedIdentifier, setCommittedIdentifier] = useState("");
  const [phase, setPhase] = useState<Phase>(rememberToken ? { kind: "quick" } : { kind: "identifier" });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Bump to clear a keypad buffer (mirrors PinEntry's `reset` prop).
  const [keypadReset, setKeypadReset] = useState(0);
  // Cooldown countdown (seconds) after an OTP_COOLDOWN throttle. 0 = no cooldown.
  const [cooldown, setCooldown] = useState(0);
  // Bump per retry so each attempt mints a FRESH idempotencyKey (mirrors login.tsx
  // pinReset — otherwise the server replays the prior cached result).
  const [attempt, setAttempt] = useState(0);

  // Tick the cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1_000);
    return () => clearInterval(id);
  }, [cooldown]);

  // Transition to a new phase: clear the keypad buffer AND reset the inline status
  // synchronously, so the destination keypad never renders in a stale `pending`
  // (disabled) state inherited from the request that triggered the transition.
  const transitionTo = (next: Phase) => {
    setStatus({ kind: "idle" });
    setKeypadReset((n) => n + 1);
    setPhase(next);
  };

  const idemBase = `cockpit:${deviceId ?? "pending"}:${attempt}`;
  const otpRequestKey = useIdempotency(`${idemBase}:otp-request`);
  const otpVerifyKey = useIdempotency(`${idemBase}:otp-verify`);
  const quickKey = useIdempotency(`${idemBase}:quick`);
  const rememberKey = useIdempotency(`${idemBase}:remember`);

  // ── identifier → requestOwnerOtp ──────────────────────────────────────────
  const onRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId || !otpRequestKey) return;
    const id = identifier.trim();
    if (!id) return;
    setStatus({ kind: "pending" });
    try {
      await requestOtp({ idempotencyKey: otpRequestKey, identifier: id, deviceId });
      // Leak-free backend: success here only means "request accepted" — an unknown
      // identifier looks identical. Advance to OTP entry regardless.
      setCommittedIdentifier(id);
      transitionTo({ kind: "otp" });
    } catch (err) {
      const msg = errorMessage(err);
      const cd = msg.match(/OTP_COOLDOWN:(\d+)/);
      if (cd) {
        setCooldown(Number(cd[1]));
        setStatus({ kind: "error", message: t("cockpitLogin.cooldown", { seconds: cd[1] }) });
      } else {
        setStatus({ kind: "error", message: t("cockpitLogin.errorGeneric") });
      }
      setAttempt((n) => n + 1);
    }
  };

  // ── otp keypad submit → verifyOwnerOtp ────────────────────────────────────
  const onOtpSubmit = async (code: string) => {
    if (!deviceId || !otpVerifyKey) return;
    setStatus({ kind: "pending" });
    try {
      const { sessionId } = await verifyOtp({
        idempotencyKey: otpVerifyKey,
        identifier: committedIdentifier,
        code,
        deviceId,
      });
      onLoggedIn(sessionId, /* offerRemember */ true);
    } catch {
      // Backend returns a generic OTP_INVALID — show one generic message.
      setStatus({ kind: "error", message: t("cockpitLogin.errorGeneric") });
      setKeypadReset((n) => n + 1);
      setAttempt((n) => n + 1);
    }
  };

  // ── quick-PIN keypad submit → quickPinLogin ───────────────────────────────
  const onQuickSubmit = async (quickPin: string) => {
    if (!deviceId || !quickKey || !rememberToken) return;
    setStatus({ kind: "pending" });
    try {
      const { sessionId } = await quickLogin({
        idempotencyKey: quickKey,
        deviceId,
        rememberToken,
        quickPin,
      });
      onLoggedIn(sessionId, /* offerRemember */ false);
    } catch (err) {
      const msg = errorMessage(err);
      const locked = msg.match(/LOCKED_OUT:(\d+)/);
      if (locked) {
        setCooldown(Number(locked[1]));
        setStatus({ kind: "error", message: t("cockpitLogin.cooldown", { seconds: locked[1] }) });
      } else {
        // Generic REMEMBER_INVALID — no PIN-vs-device oracle.
        setStatus({ kind: "error", message: t("cockpitLogin.errorGeneric") });
      }
      setKeypadReset((n) => n + 1);
      setAttempt((n) => n + 1);
    }
  };

  // ── shared post-login: store session, then either offer remember or go home ──
  function onLoggedIn(sessionId: string, offerRemember: boolean) {
    // Cockpit is the outlet-less owner plane — storeCockpitSession writes only the
    // session id (no booth LAST_STAFF_KEY).
    storeCockpitSession(sessionId);
    if (offerRemember && !rememberToken) {
      // Offer the remember-device quick-PIN enrolment step. The session is already
      // stored, so even if the owner skips it they remain logged in.
      transitionTo({ kind: "remember", sessionId });
    } else {
      navigateHome();
    }
  }

  // ── remember step: set a quick-PIN → registerRememberedDevice ─────────────
  const onRememberSubmit = async (quickPin: string) => {
    if (phase.kind !== "remember" || !rememberKey || !deviceId) return;
    setStatus({ kind: "pending" });
    try {
      const { rememberToken: raw } = await registerRemembered({
        idempotencyKey: rememberKey,
        sessionId: phase.sessionId as Id<"staff_sessions">,
        deviceId,
        quickPin,
      });
      localStorage.setItem(REMEMBER_DEVICE_TOKEN_KEY, raw);
      navigateHome();
    } catch {
      // Best-effort enrolment — the owner is already logged in. Surface a generic
      // error but let them retry or skip.
      setStatus({ kind: "error", message: t("cockpitLogin.errorGeneric") });
      setKeypadReset((n) => n + 1);
      setAttempt((n) => n + 1);
    }
  };

  // Navigate synchronously after storeSession (hazard: a deferred navigate strands
  // the user when useSession flips to "loading" and RootLayout unmounts the route).
  function navigateHome() {
    setStatus({ kind: "success", message: t("cockpitLogin.welcome") });
    navigate(COCKPIT_HOME, { replace: true });
  }

  // ── render ─────────────────────────────────────────────────────────────────
  if (deviceId === null) {
    return (
      <main className="flex flex-1 flex-col bg-background p-6">
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      </main>
    );
  }

  const inFlight = status.kind === "pending";
  const motionProps = reduceMotion
    ? {}
    : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 } };

  return (
    <main className="flex flex-1 flex-col bg-background p-6">
      {/* Eyebrow + brand */}
      <div className="mb-8 flex flex-col items-center gap-1 pt-6">
        <span className="text-2xl font-bold tracking-tight text-primary">{"frollie"}</span>
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t("cockpitLogin.eyebrow")}
        </span>
      </div>

      <motion.div key={phase.kind} {...motionProps} className="flex flex-1 flex-col">
        {phase.kind === "identifier" && (
          <form onSubmit={onRequestOtp} className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold text-foreground">
              {t("cockpitLogin.identifierTitle")}
            </h1>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cockpit-identifier" className="text-muted-foreground">
                {t("cockpitLogin.identifierLabel")}
              </Label>
              <Input
                id="cockpit-identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="characters"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={t("cockpitLogin.identifierPlaceholder")}
                disabled={inFlight}
              />
            </div>
            {status.kind === "error" && (
              <FieldMessage tone="error">{status.message}</FieldMessage>
            )}
            <Button type="submit" disabled={inFlight || !identifier.trim() || cooldown > 0}>
              {inFlight ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("cockpitLogin.sending")}
                </span>
              ) : cooldown > 0 ? (
                t("cockpitLogin.cooldown", { seconds: cooldown })
              ) : (
                t("cockpitLogin.sendCode")
              )}
            </Button>
          </form>
        )}

        {phase.kind === "otp" && (
          <KeypadEntry
            title={t("cockpitLogin.otpTitle")}
            hint={t("cockpitLogin.otpHint")}
            length={6}
            reset={keypadReset}
            pending={inFlight}
            status={status}
            onSubmit={onOtpSubmit}
            escapeLabel={t("cockpitLogin.useDifferentId")}
            onEscape={() => transitionTo({ kind: "identifier" })}
          />
        )}

        {phase.kind === "quick" && (
          <KeypadEntry
            title={t("cockpitLogin.quickPinTitle")}
            hint={t("cockpitLogin.quickPinHint")}
            length={6}
            reset={keypadReset}
            pending={inFlight}
            status={status}
            onSubmit={onQuickSubmit}
            escapeLabel={t("cockpitLogin.useCodeInstead")}
            onEscape={() => transitionTo({ kind: "identifier" })}
          />
        )}

        {phase.kind === "remember" && (
          <KeypadEntry
            title={t("cockpitLogin.rememberTitle")}
            hint={t("cockpitLogin.rememberHint")}
            length={6}
            reset={keypadReset}
            pending={inFlight}
            status={status}
            onSubmit={onRememberSubmit}
            escapeLabel={t("cockpitLogin.rememberSkip")}
            onEscape={navigateHome}
          />
        )}
      </motion.div>
    </main>
  );
}

// ── presentational keypad entry (OTP / quick-PIN / remember) ──────────────────
// Mirrors PinEntry's bufferRef pattern but length-parameterised and using
// semantic tokens so the owner theme re-tints it.

interface KeypadEntryProps {
  title: string;
  hint: string;
  length: number;
  reset: number;
  pending: boolean;
  status: Status;
  onSubmit: (code: string) => void;
  escapeLabel: string;
  onEscape: () => void;
}

function KeypadEntry({
  title,
  hint,
  length,
  reset,
  pending,
  status,
  onSubmit,
  escapeLabel,
  onEscape,
}: KeypadEntryProps) {
  const t = useT();
  const [buffer, setBuffer] = useState("");
  const bufferRef = useRef("");

  useEffect(() => {
    setBuffer("");
    bufferRef.current = "";
  }, [reset]);

  const handle = (key: string) => {
    if (pending) return;
    if (key === "C") {
      bufferRef.current = "";
      setBuffer("");
      return;
    }
    if (key === "⌫") {
      const next = bufferRef.current.slice(0, -1);
      bufferRef.current = next;
      setBuffer(next);
      return;
    }
    if (bufferRef.current.length >= length) return;
    const next = bufferRef.current + key;
    bufferRef.current = next;
    setBuffer(next);
    if (next.length === length) onSubmit(next);
  };

  const showMessage = !pending && (status.kind === "error" || status.kind === "success");

  return (
    <div className="flex flex-1 flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>

      {pending ? (
        <div
          role="status"
          aria-live="polite"
          className="flex h-4 items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("cockpitLogin.verifying")}</span>
        </div>
      ) : (
        <div className="flex gap-2.5" data-testid="otp-buffer">
          {Array.from({ length }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-3.5 w-3.5 rounded-full border-2 border-foreground transition-colors",
                i < buffer.length && "bg-foreground",
              )}
            />
          ))}
        </div>
      )}

      {showMessage && (
        <FieldMessage tone={status.kind === "success" ? "success" : "error"}>
          {status.message}
        </FieldMessage>
      )}

      <NumericKeypad onPress={handle} size="compact" disabled={pending || status.kind === "success"} />

      <button
        type="button"
        onClick={onEscape}
        disabled={pending}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
      >
        {escapeLabel}
      </button>
    </div>
  );
}
