import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useIdempotency } from "@/hooks/useIdempotency";
import { storeSession } from "@/hooks/useSession";
import { useBoothState } from "@/hooks/useBoothState";
import { getLastStaff } from "@/hooks/useLastStaff";
import { StaffListItem } from "@/components/auth/StaffListItem";
import { PinEntry } from "@/components/auth/PinEntry";
import { ConnDot } from "@/components/layout/ConnDot";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { hasShownDenial, markDenialShown } from "@/lib/pinResetDenials";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/hooks/useSession";

type Stage =
  | { kind: "list" }
  | { kind: "pin"; staff: { _id: Id<"staff">; name: string; role: "staff" | "manager" } };

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
  const boothState = useBoothState();
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
  const recordResume = useMutation(api.shifts.public.recordResume);
  const [stage, setStage] = useState<Stage>({ kind: "list" });
  const [pinReset, setPinReset] = useState(0);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Redirect immediately if booth is handover_pending — incoming staff should
  // complete the handover checklist, not go through the plain login flow.
  useEffect(() => {
    if (boothState?.state === "handover_pending") {
      navigate("/shift/handover", { replace: true });
    }
  }, [boothState, navigate]);

  // Pre-stage to PIN entry for the last-known staffer (UX optimisation — no
  // auth bypass; PIN is still required). Runs once when the active-staff list
  // first resolves.
  //
  // Tightened (v1.2 #6): only auto-pre-stage when:
  //   a) booth is "locked" AND lastStaff matches booth.staffId (same-person resume), OR
  //   b) booth state is unknown/loading (undefined) or "open" — normal login.
  //
  // Silently falls back to the list if the stored id is absent from the active
  // list (deactivated, removed, or never set).
  const hasPreStaged = useRef(false);
  useEffect(() => {
    if (hasPreStaged.current) return;
    if (staff === undefined) return;
    const lastId = getLastStaff();
    if (!lastId) return;
    const match = staff.find((s) => s._id === lastId);
    if (!match) return;

    // When booth is locked, only auto-pre-stage if the locked staffId matches.
    // This prevents auto-selecting the wrong person when a different staff
    // walks up (they must pick themselves from the list).
    if (boothState?.state === "locked" && boothState.staffId !== lastId) return;

    // Only flip the ref after a successful pre-stage.
    hasPreStaged.current = true;
    setStage({ kind: "pin", staff: match });
  }, [staff, boothState]);

  // Clear any stale inline message when the stage changes (e.g. switching staff
  // or returning to the list).
  useEffect(() => {
    setPhase({ kind: "idle" });
  }, [stage]);

  // Use a stable fallback while deviceId resolves so useIdempotency key is stable.
  // Include `pinReset` so each retry mints a FRESH idempotencyKey — otherwise
  // every wrong-PIN attempt re-uses the same key and the server's
  // `_recordFailedAttempt_internal` dedupes them, freezing fail_count at 1 and
  // silently preventing lockout.
  const intentKey = stage.kind === "pin"
    ? `login:${stage.staff._id}:${deviceId ?? "pending"}:${pinReset}`
    : "login:none";
  const idempotencyKey = useIdempotency(intentKey);

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
    setPhase({ kind: "pending" });
    try {
      const { sessionId } = await login({
        staffId: stage.staff._id, pin, deviceId, idempotencyKey,
      });
      storeSession(sessionId, stage.staff._id);

      // Resolve the navigation target on the booth state (v1.2 #6), then flash
      // the green "Welcome" before navigating.
      //   closed              → start of day checklist
      //   locked + same staff → record resume, then home
      //   open or undefined   → home (normal login)
      // (handover_pending is handled by the redirect effect above.)
      let target = "/";
      if (boothState?.state === "closed") {
        target = "/shift/start";
      } else if (boothState?.state === "locked" && stage.staff._id === boothState.staffId) {
        // Only the staff who locked the booth resumes — a different staff logging
        // in during "locked" skips recordResume and goes straight to home.
        // Resume is best-effort bookkeeping: the staffer is already authenticated
        // (session stored), so a booth-state race (e.g. another device changed
        // state → BOOTH_NOT_LOCKED) must NOT bounce them back to the auth-error
        // channel. Swallow it and proceed home; shift hours self-heal on the next
        // event. (ADR-050)
        try {
          await recordResume({ idempotencyKey: `${idempotencyKey}:resume`, sessionId });
        } catch {
          // best-effort — fall through to home
        }
      }

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
          {stage.kind === "list" ? t("login.whoIsWorking") : stage.staff.name}
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
                onClick={() => setStage({ kind: "pin", staff: s })}
              />
            ))
          )}
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
    </main>
  );
}
