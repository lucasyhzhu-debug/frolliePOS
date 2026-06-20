import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { useT } from "@/lib/i18n";

/**
 * Start-of-day wizard — fires when a staff logs in to a CLOSED booth.
 * Walks 4 steps from the open-booth SOP (spec §3A):
 *   1. Count Dubai Chewy Cookies (count step → inventory via CountStep)
 *   2. Power on all devices + confirm GoFood OPEN (instruction)
 *   3. Put 5 cookies in the display (instruction)
 *   4. Tidy booth · clear banner · photo → WA group (instruction)
 *
 * onComplete:
 *   → completeStartOfDay({ idempotencyKey, sessionId, steps, countChanged })
 *   → navigate("/", { replace: true })
 *
 * ADR-013: useIdempotency provides the IDB-persisted key; guard on `!key` before
 * submitting. The mutation itself wraps withIdempotency on the backend.
 */

function useSteps(): WizardStep[] {
  const t = useT();
  return [
    {
      key: "count",
      label: t("shiftStart.stepCountLabel"),
      type: "count",
    },
    {
      key: "power-on",
      label: t("shiftStart.stepPowerOnLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftStart.stepPowerOnTitle")}</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>{t("shiftStart.powerOnWifi")}</li>
            <li>{t("shiftStart.powerOnPrinter")}</li>
            <li>{"HP Frollie"}</li>
          </ul>
          <p className="mt-3">{t("shiftStart.stepPowerOnGofood")}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("shiftStart.stepPowerOnHint")}
          </p>
        </div>
      ),
    },
    {
      key: "fill-display",
      label: t("shiftStart.stepFillDisplayLabel"),
      type: "instruction",
      body: (
        <div>
          <p>{t("shiftStart.stepFillDisplayBody")}</p>
        </div>
      ),
    },
    {
      key: "tidy-booth",
      label: t("shiftStart.stepTidyBoothLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftStart.stepTidyBoothTitle")}</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>{t("shiftStart.stepTidyBoothItem1")}</li>
            <li>{t("shiftStart.stepTidyBoothItem2")}</li>
            <li>{t("shiftStart.stepTidyBoothItem3")}</li>
          </ul>
        </div>
      ),
    },
  ];
}

export default function ShiftStart() {
  const t = useT();
  const navigate = useNavigate();
  const session = useSession();
  const steps = useSteps();
  const completeStartOfDay = useMutation(api.shifts.public.completeStartOfDay);

  const sessionId = session.status === "active" ? session.sessionId : null;
  const idempotencyKey = useIdempotency(
    sessionId ? `shift:start:${sessionId}` : "shift:start:none",
  );

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout redirects

  async function onComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!idempotencyKey || !sessionId) return;
    await completeStartOfDay({
      idempotencyKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { countChanged } : {}),
    });
    navigate("/", { replace: true });
  }

  return (
    <ShiftWizard
      title={t("shiftStart.title")}
      steps={steps}
      onComplete={onComplete}
      terminalLabel={t("shiftStart.terminalLabel")}
    />
  );
}
