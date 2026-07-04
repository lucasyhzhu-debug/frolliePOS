import { Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useLoginContext } from "@/hooks/useLoginContext";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";

/**
 * /shift/begin — session-FULL incoming-shift count → startShift.
 *
 * Reached via the login post-handover target (set by T11 loginContext):
 * after the outgoing staffer calls handover(), the incoming staffer logs in
 * and their loginTarget is "/shift/begin" (outletOpen=true, holderStaffId=null).
 *
 * One-step count wizard → startShift → navigate("/").
 *
 * Guard: if outletOpen is false or a shift holder already exists, redirect to
 * "/" (stray visit — RootLayout's SOP gate handles further routing).
 *
 * ADR-013: IDB-persisted idempotency key scoped to the incoming session.
 */

function useSteps(): WizardStep[] {
  const t = useT();
  return [
    {
      key: "count",
      label: t("shiftBegin.stepCountLabel"),
      type: "count",
    },
  ];
}

export default function ShiftBegin() {
  const t = useT();
  const navigate = useNavigate();
  const session = useSession();
  const ctx = useLoginContext();
  const steps = useSteps();
  const startShift = useMutation(api.shifts.shifts.startShift);
  const lock = useMutation(api.shifts.shifts.lock);

  const sessionId = session.status === "active" ? session.sessionId : null;
  const idempotencyKey = useIdempotency(
    sessionId ? `shift:begin:${sessionId}` : "shift:begin:none",
  );
  // Distinct intent from the begin key — used only to end the session server-side
  // when a self-handover is rejected (mirrors lock.tsx's lock-then-clear pattern).
  const lockKey = useIdempotency(
    sessionId ? `shift:begin:lock:${sessionId}` : "shift:begin:lock:none",
  );

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout no-session gate handles

  // Guard: wait for ctx to resolve before deciding whether to redirect.
  if (ctx === undefined) return null;

  // Stray visit guard: redirect if outlet is closed (RootLayout SOP gate will
  // then send to /shift/start) or a shift is already in progress.
  if (!ctx.outletOpen || ctx.holderStaffId !== null) {
    return <Navigate to="/" replace />;
  }

  async function onComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!idempotencyKey || !sessionId) return;
    try {
      await startShift({
        idempotencyKey,
        sessionId,
        steps: confirmed,
        ...(countChanged != null ? { openCount: countChanged } : {}),
      });
      navigate("/", { replace: true });
    } catch (err) {
      // SELF_HANDOVER_NOT_ALLOWED: the staffer who just handed over tried to re-claim
      // the booth. Sending them back to /login (logged out) leaves the booth open +
      // holderless so the actual next person can take over — and prevents the
      // stranded-holder trap that blocked every other login in prod.
      if (errorMessage(err).includes("SELF_HANDOVER_NOT_ALLOWED")) {
        toast.error(t("shiftBegin.selfHandoverBlocked"));
        // End the just-created session server-side before clearing the client, so we
        // don't leave an orphaned ended_at:null row (mirrors lock.tsx). Best-effort:
        // a lock failure must not strand the staffer on /shift/begin.
        try {
          if (lockKey) await lock({ idempotencyKey: lockKey, sessionId });
        } catch { /* best-effort session cleanup */ }
        clearSession();
        navigate("/login", { replace: true });
        return;
      }
      throw err;
    }
  }

  return (
    <div className="flex flex-col">
      <ShiftWizard
        title={t("shiftBegin.title")}
        steps={steps}
        onComplete={onComplete}
        terminalLabel={t("shiftBegin.terminalLabel")}
        sessionId={sessionId ?? undefined}
      />
    </div>
  );
}
