import { Navigate, useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useLoginContext } from "@/hooks/useLoginContext";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { useT } from "@/lib/i18n";

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

  const sessionId = session.status === "active" ? session.sessionId : null;
  const idempotencyKey = useIdempotency(
    sessionId ? `shift:begin:${sessionId}` : "shift:begin:none",
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
    await startShift({
      idempotencyKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { openCount: countChanged } : {}),
    });
    navigate("/", { replace: true });
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
