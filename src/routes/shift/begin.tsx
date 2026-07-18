import { Navigate, useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { useLoginContext } from "@/hooks/useLoginContext";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
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
 * The incoming staffer may be the SAME person who just handed over (solo booth,
 * or the replacement never showed) — that's allowed (v1.4.9, reverses the
 * v1.4.4 self-handover guard): startShift just mints her a fresh shift, audited
 * with self_resume:true. No prompt, no block.
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
    try {
      await startShift({
        idempotencyKey,
        sessionId,
        steps: confirmed,
        ...(countChanged != null ? { openCount: countChanged } : {}),
      });
      navigate("/", { replace: true });
    } catch (err) {
      // Every failure must be VISIBLE — a rethrow here dies as an unhandled
      // rejection and the terminal button reads as dead (PROD 2026-07-18: prod
      // redacts plain server Errors to "Server Error", which is unmatched by
      // design). Toast + stay on the wizard so the operator can retry.
      toast.error(errorMessage(err));
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
