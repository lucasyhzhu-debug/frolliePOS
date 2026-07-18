import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useLoginContext } from "@/hooks/useLoginContext";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { toast } from "sonner";

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
  // when the operator chooses "log out for the next person" from the self-handover
  // prompt (mirrors lock.tsx's lock-then-clear pattern).
  const lockKey = useIdempotency(
    sessionId ? `shift:begin:lock:${sessionId}` : "shift:begin:lock:none",
  );

  // Self-handover prompt (issue #158). When the SAME staffer who just handed the
  // booth over completes the count, startShift rejects with SELF_HANDOVER_NOT_ALLOWED.
  // Instead of silently bouncing to /login — which loops forever for a SOLO operator
  // with no colleague to take over (PROD 2026-07-05) — we surface an explicit choice:
  // Resume this shift (re-submit with allowSelfResume), or log out for the next person.
  // Holds the completed count so "Resume" can re-submit without re-counting.
  const [resumePrompt, setResumePrompt] = useState<
    { confirmed: ConfirmedStep[]; countChanged: number | null } | null
  >(null);
  const [resumePending, setResumePending] = useState(false);

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout no-session gate handles

  // Guard: wait for ctx to resolve before deciding whether to redirect.
  if (ctx === undefined) return null;

  // Stray visit guard: redirect if outlet is closed (RootLayout SOP gate will
  // then send to /shift/start) or a shift is already in progress. Suppressed while
  // the resume prompt is open — the prompt owns the next navigation.
  if (resumePrompt === null && (!ctx.outletOpen || ctx.holderStaffId !== null)) {
    return <Navigate to="/" replace />;
  }

  // Single start path. allowSelfResume is set ONLY by the explicit Resume tap.
  async function runStart(
    confirmed: ConfirmedStep[],
    countChanged: number | null,
    allowSelfResume: boolean,
  ) {
    if (!idempotencyKey || !sessionId) return;
    await startShift({
      idempotencyKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { openCount: countChanged } : {}),
      ...(allowSelfResume ? { allowSelfResume: true } : {}),
    });
    navigate("/", { replace: true });
  }

  async function onComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!idempotencyKey || !sessionId) return;
    try {
      await runStart(confirmed, countChanged, false);
    } catch (err) {
      if (errorMessage(err).includes("SELF_HANDOVER_NOT_ALLOWED")) {
        // Don't act yet — let the operator decide (Resume / Log out).
        setResumePrompt({ confirmed, countChanged });
        return;
      }
      // Anything else must be VISIBLE — a rethrow here dies as an unhandled
      // rejection and the terminal button reads as dead (PROD 2026-07-18: prod
      // redacts plain server Errors to "Server Error", which is unmatched by
      // design). Toast + stay on the wizard so the operator can retry.
      toast.error(errorMessage(err));
    }
  }

  async function onResume() {
    if (!resumePrompt) return;
    setResumePending(true);
    try {
      await runStart(resumePrompt.confirmed, resumePrompt.countChanged, true);
    } catch (err) {
      // Same visibility rule as onComplete: never die silently.
      toast.error(errorMessage(err));
    } finally {
      setResumePending(false);
    }
  }

  async function onLogoutForNext() {
    // No shift was created (startShift threw + rolled back). End this session so the
    // booth stays open + holderless and the next person logs in fresh. Best-effort:
    // a lock failure must not strand the operator on the prompt.
    try {
      if (lockKey && sessionId) await lock({ idempotencyKey: lockKey, sessionId });
    } catch { /* best-effort session cleanup */ }
    clearSession();
    navigate("/login", { replace: true });
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

      {/* Self-handover resume choice. Plain inline overlay (NOT a Radix Dialog —
          Radix can leave body{pointer-events:none} stuck on close amid state churn). */}
      {resumePrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("shiftBegin.resumeTitle")}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground">
              {t("shiftBegin.resumeTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("shiftBegin.resumeBody")}
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <Button onClick={onResume} disabled={resumePending} size="lg">
                {t("shiftBegin.resumeConfirm")}
              </Button>
              <Button
                variant="ghost"
                onClick={onLogoutForNext}
                disabled={resumePending}
              >
                {t("shiftBegin.resumeLogout")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
