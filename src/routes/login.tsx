import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { storeSession } from "@/hooks/useSession";
import { useLoginContext } from "@/hooks/useLoginContext";
import { getLastStaff } from "@/hooks/useLastStaff";
import { StaffListItem } from "@/components/auth/StaffListItem";
import { PinEntry } from "@/components/auth/PinEntry";
import { PinSheet } from "@/components/pos/PinSheet";
import { ConnDot } from "@/components/layout/ConnDot";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { hasShownDenial, markDenialShown } from "@/lib/pinResetDenials";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/hooks/useSession";

type Stage =
  | { kind: "list" }
  | { kind: "pin"; staff: { _id: Id<"staff">; name: string; role: "staff" | "manager" } }
  | { kind: "blocked"; staff: { _id: Id<"staff">; name: string; role: "staff" | "manager" } };

// Async result-state for the PIN submit, lifted out of toasts into an inline
// FieldMessage (ADR-048): idle → pending → success | error.
type Phase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string; sticky: boolean }
  | { kind: "success" };

export default function LoginRoute() {
  const navigate = useNavigate();
  const deviceId = useDeviceId();
  const ctx = useLoginContext();
  const session = useSession();
  const t = useT();
  // v2.0 Task 10: roster scoped to the device's bound outlet. Falls back while
  // deviceId resolves (skip → undefined). The outlet chip below derives from the
  // active session's outlet_label so it persists across re-renders.
  const staff = useQuery(
    api.auth.public.listStaffForDevice,
    deviceId ? { deviceId } : "skip",
  );
  // Outlet label from an existing active session (survives between pre-stage + PIN entry),
  // or from a completed login before navigation completes.
  const outletLabel =
    session.status === "active" ? session.staff.outlet_label : undefined;
  const login = useAction(api.auth.actions.loginWithPin);
  const managerOverride = useAction(api.shifts.actions.managerOverride);
  const requestOverride = useAction(api.approvals.actions.requestShiftOverride);

  const [stage, setStage] = useState<Stage>({ kind: "list" });
  const [pinReset, setPinReset] = useState(0);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Manager override state (reuses PinSheet pattern from lock.tsx)
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [pickedManager, setPickedManager] = useState<{
    _id: Id<"staff">;
    name: string;
  } | null>(null);
  const [overrideError, setOverrideError] = useState<string | undefined>();
  const [overridePending, setOverridePending] = useState(false);

  // Two-path override (v1.3.1): inline (Close/Release + PIN) + Request via Telegram.
  // resultingState: which outcome the inline manager override produces. Default
  // "release" — the blocked-booth recovery case is "someone needs to get in", so the
  // safe default keeps the outlet OPEN and hands off; "close" (end-of-day) is the
  // deliberate opt-in. (Defaulting to "close" was a footgun: a manager tapping through
  // would shut the whole booth instead of releasing the stranded holder.)
  const [resultingState, setResultingState] = useState<"close" | "release">("release");
  // Telegram-request path: pending/requested/error states.
  const [overrideRequested, setOverrideRequested] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [requestError, setRequestError] = useState<string | undefined>();
  // Separate idempotency counter + key for the requestShiftOverride action.
  const [requestReset, setRequestReset] = useState(0);
  const requestKey = useIdempotency(`shift:override:request:${deviceId ?? "none"}:${requestReset}`);
  // Track the pending approval requestId for reactive status polling.
  const [requestId, setRequestId] = useState<Id<"pos_approval_requests"> | null>(null);
  // Terminal result of the remote request so we can show denied/expired feedback.
  const [overrideResult, setOverrideResult] = useState<"declined" | "expired" | null>(null);
  // Reactive subscription for the pending shift-override approval request.
  // "skip" when no request is outstanding so we don't issue unnecessary queries.
  const reqStatus = useQuery(
    api.approvals.public.getRequestStatus,
    requestId ? { requestId } : "skip",
  );

  // Managers derived from the device-scoped staff list.
  const managers = staff?.filter((s) => s.role === "manager") ?? [];

  // Pre-stage to PIN entry for the last-known staffer (UX optimisation — no
  // auth bypass; PIN is still required). Runs once when the active-staff list
  // first resolves.
  //
  // Guard: when the outlet is open with a holder, only auto-pre-stage if the
  // holder is the same person as lastStaff (they're resuming their own shift).
  // This prevents auto-selecting a different staffer who would just hit the
  // block screen anyway.
  //
  // Silently falls back to the list if the stored id is absent from the active
  // list (deactivated, removed, or never set).
  const hasPreStaged = useRef(false);
  useEffect(() => {
    if (hasPreStaged.current) return;
    if (staff === undefined) return;
    // I-B: don't pre-stage before loginContext resolves; without ctx the block
    // check below is a no-op and a blocked staffer could be silently pre-staged.
    if (ctx === undefined) return;
    const lastId = getLastStaff();
    if (!lastId) return;
    const match = staff.find((s) => s._id === lastId);
    if (!match) return;

    // When outlet is open with a different holder, don't pre-stage — that
    // person is blocked and would need manager override.
    if (
      ctx?.outletOpen === true &&
      ctx.holderStaffId !== null &&
      ctx.holderStaffId !== lastId
    ) return;

    // Only flip the ref after a successful pre-stage.
    hasPreStaged.current = true;
    setStage({ kind: "pin", staff: match });
  }, [staff, ctx]);

  // Clear any stale inline message when the stage changes (e.g. switching staff
  // or returning to the list).
  useEffect(() => {
    setPhase({ kind: "idle" });
  }, [stage]);

  // Reactive guard: when a Telegram-requested override is approved (or the hold
  // is cleared any other way), holderStaffId becomes null. Move back to the list
  // so the blocked staffer can tap their own name to log in.
  useEffect(() => {
    if (stage.kind === "blocked" && ctx !== undefined && ctx.holderStaffId === null) {
      setStage({ kind: "list" });
      setOverrideRequested(false);
      setRequestError(undefined);
      setRequestId(null);
      setOverrideResult(null);
    }
  }, [stage.kind, ctx]);

  // React to the approval request status — surface denied/expired to the blocked
  // staffer so they can retry rather than waiting indefinitely.
  useEffect(() => {
    if (!reqStatus) return;
    if (reqStatus.status === "denied") {
      setOverrideRequested(false);
      setRequestId(null); // unsubscribe
      setOverrideResult("declined");
    } else if (reqStatus.status === "expired") {
      setOverrideRequested(false);
      setRequestId(null); // unsubscribe
      setOverrideResult("expired");
    } else if (reqStatus.status === "resolved") {
      // Approval went through — the ctx holderStaffId effect handles returning to
      // the list once the mutation commit propagates; just clear the subscription.
      setRequestId(null);
    }
  }, [reqStatus]);

  // Use a stable fallback while deviceId resolves so useIdempotency key is stable.
  // Include `pinReset` so each retry mints a FRESH idempotencyKey — otherwise
  // every wrong-PIN attempt re-uses the same key and the server's
  // `_recordFailedAttempt_internal` dedupes them, freezing fail_count at 1 and
  // silently preventing lockout.
  const staffId = stage.kind === "pin" || stage.kind === "blocked" ? stage.staff._id : null;
  const intentKey = staffId
    ? `login:${staffId}:${deviceId ?? "pending"}:${pinReset}`
    : "login:none";
  const idempotencyKey = useIdempotency(intentKey);

  // Separate idempotency key for manager override (must not share root with login key).
  const [overrideReset, setOverrideReset] = useState(0);
  // C1: distinct prefix for login-screen override + reset counter so each attempt
  // (success or failure) gets a fresh idempotency key (mirrors pinReset rotation).
  const overrideKey = useIdempotency(`shift:override:login:${deviceId ?? "none"}:${overrideReset}`);

  // Reactive notification when the manager declines a pending PIN-reset for
  // this staff.
  const recentPinReset = useQuery(
    api.approvals.public.getRecentPinResetForStaff,
    stage.kind === "pin" ? { staffId: stage.staff._id } : "skip",
  );
  useEffect(() => {
    if (!recentPinReset || recentPinReset.status !== "denied") return;
    // Dedup across component remounts via localStorage — an in-memory ref resets
    // on every mount, re-firing the denial toast each time login re-renders (#11).
    if (hasShownDenial(recentPinReset.requestId)) return;
    markDenialShown(recentPinReset.requestId);
    const name = recentPinReset.denied_by_manager_name ?? t("login.managerFallback");
    const code = recentPinReset.denied_by_manager_code;
    const denierLabel = code ? `${name} (${code})` : name;
    const reason = recentPinReset.deny_reason;
    toast.error(
      reason
        ? t("login.pinResetDeniedWithReason", { denier: denierLabel, reason })
        : t("login.pinResetDenied", { denier: denierLabel }),
      { duration: 10_000 },
    );
  }, [recentPinReset, t]);

  const onPinSubmit = async (pin: string) => {
    if (stage.kind !== "pin") return;
    if (!deviceId) {
      setPhase({ kind: "error", message: t("login.deviceNotReady"), sticky: false });
      setPinReset((n) => n + 1); // clear the stale buffer so the staffer can retry
      return;
    }
    if (!idempotencyKey) return; // IDB not yet resolved — guard ADR-013
    // I-B: re-check block predicate here — loginContext is reactive and may have
    // updated between when the user tapped their name and when they finished
    // entering their PIN (e.g. another staff logged in and claimed the holder
    // slot while the PIN digits were being typed).
    if (
      ctx !== undefined &&
      ctx.outletOpen === true &&
      ctx.holderStaffId !== null &&
      ctx.holderStaffId !== stage.staff._id
    ) {
      setPhase({ kind: "error", message: t("login.shiftHeldBy", { name: ctx.holderName ?? "" }), sticky: true });
      setPinReset((n) => n + 1);
      return;
    }
    setPhase({ kind: "pending" });
    try {
      const { sessionId } = await login({
        staffId: stage.staff._id, pin, deviceId, idempotencyKey,
      });
      storeSession(sessionId, stage.staff._id);

      // Resolve the navigation target from loginContext (two-level stored state):
      //   outlet closed       → start of day checklist (/shift/start)
      //   outlet open, no holder → incoming count wizard (/shift/begin)
      //   outlet open, holder === me → resume at home (/)
      // (The blocked case — holder !== me — never reaches here; name tap is
      //  intercepted before opening PIN entry.)
      let target = "/";
      if (ctx?.outletOpen === false) {
        target = "/shift/start";
      } else if (ctx?.holderStaffId === null) {
        target = "/shift/begin";
      }
      // else: outlet open + holderStaffId === me → resume at "/" (holder shift untouched)

      // Navigate synchronously. A deferred (setTimeout) navigate is unsafe here:
      // storeSession() flips useSession to "loading" (stored id set, getSession
      // not yet resolved), which makes RootLayout swap the Outlet for its
      // fallback — unmounting THIS route and cancelling any pending timer before
      // it fires, stranding the staffer on /login. The success tint still paints
      // for the render before unmount. (Regression: PR #104 / fixed here.)
      setPhase({ kind: "success" });
      navigate(target, { replace: true });
    } catch (err) {
      // errorMessage unwraps ConvexError.data (a raw err.message would miss it);
      // the LOCKED_OUT/INVALID_PIN codes are thrown as plain Errors so they pass
      // through unchanged for the substring match below.
      const msg = errorMessage(err);
      const lockedMatch = msg.match(/LOCKED_OUT:(\d+)/);
      if (lockedMatch) {
        setPhase({
          kind: "error",
          message: t("login.errorLockedOut", { seconds: lockedMatch[1] }),
          sticky: true,
        });
      } else if (msg.includes("INVALID_PIN")) {
        setPhase({ kind: "error", message: t("login.errorWrongPin"), sticky: false });
      } else {
        setPhase({ kind: "error", message: t("login.errorGeneric"), sticky: false });
      }
      setPinReset((n) => n + 1);
    }
  };

  const handleStaffTap = (s: { _id: Id<"staff">; name: string; role: "staff" | "manager" }) => {
    // Block if the outlet is open with a different holder — the incoming staffer
    // must wait for handover or have a manager force-end the stranded shift.
    if (
      ctx?.outletOpen === true &&
      ctx.holderStaffId !== null &&
      ctx.holderStaffId !== s._id
    ) {
      setStage({ kind: "blocked", staff: s });
      return;
    }
    setStage({ kind: "pin", staff: s });
  };

  const handleOverrideOpen = () => {
    setPickedManager(null);
    setOverrideError(undefined);
    setResultingState("release"); // reset to the safe default (keep booth open) each open
    setOverrideOpen(true);
  };

  const handleOverridePin = async (pin: string) => {
    if (!deviceId || !overrideKey || !pickedManager) {
      setOverrideError(t("login.deviceNotReady"));
      return;
    }
    setOverridePending(true);
    setOverrideError(undefined);
    try {
      await managerOverride({
        idempotencyKey: overrideKey,
        deviceId,
        managerStaffId: pickedManager._id,
        managerPin: pin,
        resultingState,
      });
      setOverrideOpen(false);
      setPickedManager(null);
      // ctx will reactively update (holderStaffId → null) once the mutation
      // commits; the blocked staffer will see the block UI clear.
      // Move back to the list so they can tap their own name to log in.
      setStage({ kind: "list" });
    } catch (err) {
      const msg = errorMessage(err);
      setOverrideError(
        msg.includes("INVALID_PIN") ? t("login.errorWrongPin") :
        msg.includes("NOT_MANAGER") ? t("lock.errorNotManager") :
        msg.includes("LOCKED_OUT") ? t("lock.errorLockedOut") :
        msg,
      );
    } finally {
      setOverridePending(false);
      // C1: rotate the key after every attempt (success + failure) so the next
      // call never replays a stale idempotency result.
      setOverrideReset((n) => n + 1);
    }
  };

  // Telegram-request path: sends a shift-override request to the managers channel.
  // On { requestId } → show waiting state; on { noHold: true } → no hold, go to list.
  const handleRequestOverride = async () => {
    // Don't silently no-op if the idempotency key isn't ready yet (IDB race): tell
    // the staffer to retry rather than leaving the tap looking dead. The button is
    // also disabled until requestKey resolves; this is the belt-and-braces guard.
    if (!deviceId || !requestKey) {
      setRequestError(t("login.overrideNotReady"));
      return;
    }
    setRequestPending(true);
    setRequestError(undefined);
    setOverrideResult(null); // clear any previous denied/expired state on retry
    try {
      const result = await requestOverride({ deviceId, idempotencyKey: requestKey });
      if ("noHold" in result && result.noHold) {
        // Hold already gone — move back to list so the blocked staffer can log in
        setStage({ kind: "list" });
      } else if ("notifyFailed" in result && result.notifyFailed) {
        // Telegram send failed — the request was rolled back. Steer the staffer to
        // the Telegram-INDEPENDENT inline manager-PIN override (or retry) instead of
        // a dead end.
        setRequestError(t("login.overrideNotifyFailed"));
      } else {
        // Store requestId to subscribe to its status reactively.
        setOverrideRequested(true);
        setRequestId((result as { requestId: Id<"pos_approval_requests"> }).requestId);
      }
    } catch (err) {
      setRequestError(errorMessage(err));
    } finally {
      setRequestPending(false);
      // Rotate key after every attempt so the next call never replays a stale result.
      setRequestReset((n) => n + 1);
    }
  };

  // Show a minimal loading state while the device id is being resolved from IDB.
  if (deviceId === null) {
    return (
      <main className="flex flex-1 flex-col p-6">
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      </main>
    );
  }

  // Map the Phase machine to PinEntry's feedback props in one place (the union
  // is discriminated once here rather than three times in the JSX below).
  const pinFeedback =
    phase.kind === "error"
      ? { phase: "error" as const, message: phase.message, persist: phase.sticky }
      : phase.kind === "success"
        ? { phase: "success" as const, message: t("login.welcome"), persist: false }
        : { phase: "idle" as const, message: undefined, persist: false };

  // Heading text derived from stage. The blocked stage uses a neutral title —
  // showing the tapped staffer's name there read as confusing next to a message
  // about the *current holder* (UAT UX-NIT).
  const heading =
    stage.kind === "list"
      ? t("login.whoIsWorking")
      : stage.kind === "blocked"
        ? t("login.shiftInProgressTitle")
        : stage.staff.name;

  return (
    <main className="flex flex-1 flex-col p-6">
      {/* Brand mark */}
      <div className="mb-8 flex flex-col items-center gap-1 pt-6">
        <span className="text-2xl font-bold tracking-tight text-primary">{"frollie"}</span>
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t("login.appSubtitle")}
        </span>
      </div>

      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">
          {heading}
        </h1>
        <div className="flex items-center gap-2">
          {outletLabel && (
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              {t("login.outletChip", { outlet: outletLabel })}
            </span>
          )}
          <ConnDot />
        </div>
      </header>

      {stage.kind === "list" ? (
        <div className="flex flex-col gap-2">
          {staff === undefined ? (
            <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
          ) : staff.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t("login.noStaff")}
            </div>
          ) : (
            staff.map((s) => (
              <StaffListItem
                key={s._id} name={s.name} role={s.role}
                onClick={() => handleStaffTap(s)}
              />
            ))
          )}
        </div>
      ) : stage.kind === "blocked" ? (
        // Shift held by someone else — block entry, offer two override paths:
        //   A) Inline: manager on-device enters their PIN (Close or Release).
        //   B) Remote: send a Telegram approval request to the managers channel.
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm text-muted-foreground">
            {t("login.shiftHeldBy", { name: ctx?.holderName ?? "" })}
          </p>
          {overrideRequested ? (
            // Telegram request sent — wait for manager approval; ctx clears the block reactively.
            <p className="text-sm text-muted-foreground">{t("login.overrideRequested")}</p>
          ) : (
            <>
              {overrideResult === "declined" && (
                <p className="text-sm text-destructive">{t("login.overrideDeclined")}</p>
              )}
              {overrideResult === "expired" && (
                <p className="text-sm text-muted-foreground">{t("login.overrideExpired")}</p>
              )}
              <button
                type="button"
                onClick={handleOverrideOpen}
                className="rounded-lg bg-card border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
              >
                {t("login.managerOverride")}
              </button>
              <button
                type="button"
                onClick={handleRequestOverride}
                disabled={requestPending || !requestKey}
                className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
              >
                {t("login.requestOverrideViaTelegram")}
              </button>
              {requestError && (
                <p className="text-sm text-destructive">{requestError}</p>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setStage({ kind: "list" });
              setOverrideRequested(false);
              setRequestError(undefined);
              setRequestId(null);
              setOverrideResult(null);
            }}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t("login.back")}
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <PinEntry
            onSubmit={onPinSubmit}
            reset={pinReset}
            pending={phase.kind === "pending"}
            {...pinFeedback}
          />
          <button
            type="button"
            onClick={() => setStage({ kind: "list" })}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t("login.back")}
          </button>
        </div>
      )}

      {/* Manager-picker + PIN sheet for override */}
      <PinSheet
        open={overrideOpen}
        title={t("login.managerOverride")}
        label={
          pickedManager
            ? t("lock.pinForManager", { name: pickedManager.name })
            : t("login.overridePickManager")
        }
        pending={overridePending}
        error={overrideError}
        onSubmit={pickedManager ? handleOverridePin : () => undefined}
        onCancel={() => {
          setOverrideOpen(false);
          setPickedManager(null);
          setOverrideError(undefined);
        }}
        extraField={
          !pickedManager ? (
            <div className="flex flex-col gap-1 mb-2">
              {managers.map((m) => (
                <button
                  key={m._id}
                  type="button"
                  className="rounded border border-border bg-card px-3 py-2 text-sm text-left hover:bg-accent"
                  onClick={() => setPickedManager(m)}
                >
                  {m.name}
                </button>
              ))}
              {managers.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("lock.noManagers")}</p>
              )}
            </div>
          ) : (
            // Close/Release segmented control — shown once a manager is picked.
            // "Close" ends the hold AND closes the outlet (end-of-day).
            // "Release" ends the hold only, leaving the outlet open for the next staff.
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setResultingState("close")}
                className={`flex-1 rounded border px-3 py-2 text-sm font-medium transition-colors ${
                  resultingState === "close"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:bg-accent"
                }`}
              >
                {t("common.outcomeClose")}
              </button>
              <button
                type="button"
                onClick={() => setResultingState("release")}
                className={`flex-1 rounded border px-3 py-2 text-sm font-medium transition-colors ${
                  resultingState === "release"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:bg-accent"
                }`}
              >
                {t("common.outcomeRelease")}
              </button>
            </div>
          )
        }
      />
    </main>
  );
}
