import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { Button } from "@/components/ui/button";
import { PinSheet } from "@/components/pos/PinSheet";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";

/**
 * Start-of-day wizard — fires when a staff logs in to a CLOSED booth.
 * Walks 4 steps from the open-booth SOP (spec §3A):
 *   1. Count Dubai Chewy Cookies (count step → inventory via CountStep)
 *   2. Power on all devices + confirm GoFood OPEN (instruction)
 *   3. Put 5 cookies in the display (instruction)
 *   4. Tidy booth · clear banner · photo → WA group (instruction)
 *
 * onComplete:
 *   → openBooth({ idempotencyKey, sessionId, steps, openCount })
 *   → navigate("/", { replace: true })
 *
 * Manager skip (server-driven — no client shiftSkip flag):
 *   → PinSheet → managerSkipOpen({ idempotencyKey, sessionId, managerPin })
 *   → navigate("/", { replace: true })
 *
 * ADR-013: useIdempotency provides the IDB-persisted key; guard on `!key` before
 * submitting. The mutation/action itself wraps withIdempotency on the backend.
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
  const openBooth = useMutation(api.shifts.shifts.openBooth);
  const managerSkipOpen = useAction(api.shifts.actions.managerSkipOpen);

  const sessionId = session.status === "active" ? session.sessionId : null;

  // Distinct idempotency intents: open and skip must not share a key.
  const openKey = useIdempotency(
    sessionId ? `shift:start:${sessionId}` : "shift:start:none",
  );
  const skipKey = useIdempotency(
    sessionId ? `shift:start:skip:${sessionId}` : "shift:start:skip:none",
  );

  // Manager-skip PinSheet state
  const [skipPinOpen, setSkipPinOpen] = useState(false);
  const [skipPinError, setSkipPinError] = useState<string | undefined>();
  const [skipPinPending, setSkipPinPending] = useState(false);

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout redirects

  const isManager = session.staff.role === "manager";

  async function onComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!openKey || !sessionId) return;
    await openBooth({
      idempotencyKey: openKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { openCount: countChanged } : {}),
    });
    navigate("/", { replace: true });
  }

  // Manager-only escape hatch: skip the SOP checklist via PIN verification.
  // managerSkipOpen flips outletOpen=true on the backend so the RootLayout SOP
  // gate lifts naturally on the next loginContext query tick.
  async function onSkipPin(pin: string) {
    if (!skipKey || !sessionId) {
      setSkipPinError(t("lock.errorNotReady")); // guard — shouldn't happen
      return;
    }
    setSkipPinPending(true);
    setSkipPinError(undefined);
    try {
      await managerSkipOpen({ idempotencyKey: skipKey, sessionId, managerPin: pin });
      setSkipPinOpen(false);
      navigate("/", { replace: true });
    } catch (err) {
      const msg = errorMessage(err) || t("lock.errorNotReady");
      setSkipPinError(
        msg.includes("INVALID_PIN") ? t("lock.errorInvalidPin") :
        msg.includes("NOT_MANAGER") ? t("lock.errorNotManager") :
        msg.includes("LOCKED_OUT") ? t("lock.errorLockedOut") :
        msg,
      );
    } finally {
      setSkipPinPending(false);
    }
  }

  return (
    <div className="flex flex-col">
      <ShiftWizard
        title={t("shiftStart.title")}
        steps={steps}
        onComplete={onComplete}
        terminalLabel={t("shiftStart.terminalLabel")}
      />
      {isManager && (
        <div className="px-4 pb-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setSkipPinError(undefined);
              setSkipPinOpen(true);
            }}
          >
            {t("shiftStart.skipManager")}
          </Button>
        </div>
      )}

      <PinSheet
        open={skipPinOpen}
        title={t("shiftStart.skipPinTitle")}
        label={t("shiftStart.skipPinLabel")}
        pending={skipPinPending}
        error={skipPinError}
        onSubmit={onSkipPin}
        onCancel={() => {
          setSkipPinOpen(false);
          setSkipPinError(undefined);
        }}
      />
    </div>
  );
}
