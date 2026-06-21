import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import ShiftWizard, { type WizardStep, type ConfirmedStep } from "@/components/pos/ShiftWizard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fmtShiftDuration } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * /shift/end — choice screen + close/handover-out wizards.
 *
 * Local state:
 *   "choice"   → two cards: "Tutup booth" or "Serah terima"
 *   "close"    → 5-step end-of-day wizard (spec §3B)
 *   "handover" → 2-step handover-out wizard (spec §3C)
 *
 * On close completion:
 *   → endOfDaySignOff → staff summary (hours + stock, NO financials)
 *   → "Selesai" → clearSession + navigate("/login")
 *
 * On handover completion:
 *   → handoverOut → navigate("/shift/handover")
 *
 * ADR-013: two distinct idempotency intents so close and handover never
 * share a dedupe key even if the user bounces between them.
 */

function useCloseSteps(): WizardStep[] {
  const t = useT();
  return [
    {
      key: "reminder",
      label: t("shiftEnd.stepReminderLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftEnd.stepReminderTitle")}</p>
          <p className="mt-2">{t("shiftEnd.stepReminderBody")}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("shiftEnd.stepReminderHint")}
          </p>
        </div>
      ),
    },
    {
      key: "count",
      label: t("shiftEnd.stepCountLabel"),
      type: "count",
    },
    {
      key: "check-supplies",
      label: t("shiftEnd.stepCheckSuppliesLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftEnd.stepCheckSuppliesTitle")}</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>{t("shiftEnd.supplyStickers")}</li>
            <li>{t("shiftEnd.supplySealStickers")}</li>
            <li>{t("shiftEnd.supplyPaperBag")}</li>
            <li>{t("shiftEnd.supplyOnionBag")}</li>
            <li>{t("shiftEnd.supplyCableTies")}</li>
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            {t("shiftEnd.stepCheckSuppliesHint")}
          </p>
        </div>
      ),
    },
    {
      key: "tidy-devices",
      label: t("shiftEnd.stepTidyDevicesLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftEnd.stepTidyDevicesTitle")}</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>{t("shiftEnd.tidyDevicesItem1")}</li>
            <li>{t("shiftEnd.tidyDevicesItem2")}</li>
            <li>{t("shiftEnd.tidyDevicesItem3")}</li>
            <li>{t("shiftEnd.tidyDevicesItem4")}</li>
          </ul>
        </div>
      ),
    },
    {
      key: "lock-lockers",
      label: t("shiftEnd.stepLockLockersLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftEnd.stepLockLockersTitle")}</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>{t("shiftEnd.lockLockersItem1")}</li>
            <li>{t("shiftEnd.lockLockersItem2")}</li>
            <li>{t("shiftEnd.lockLockersItem3")}</li>
          </ul>
        </div>
      ),
    },
  ];
}

function useHandoverSteps(): WizardStep[] {
  const t = useT();
  return [
    {
      key: "count",
      label: t("shiftEnd.stepCountLabel"),
      type: "count",
    },
    {
      key: "check-supplies",
      label: t("shiftEnd.stepCheckSuppliesLabel"),
      type: "instruction",
      body: (
        <div>
          <p className="font-medium">{t("shiftEnd.stepCheckSuppliesTitle")}</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>{t("shiftEnd.supplyStickers")}</li>
            <li>{t("shiftEnd.supplySealStickers")}</li>
            <li>{t("shiftEnd.supplyPaperBag")}</li>
            <li>{t("shiftEnd.supplyOnionBag")}</li>
            <li>{t("shiftEnd.supplyCableTies")}</li>
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            {t("shiftEnd.stepCheckSuppliesHint")}
          </p>
        </div>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = "choice" | "close" | "handover";

export default function ShiftEnd() {
  const t = useT();
  const navigate = useNavigate();
  const session = useSession();
  const endOfDaySignOff = useMutation(api.shifts.public.endOfDaySignOff);
  const handoverOut = useMutation(api.shifts.public.handoverOut);

  const closeSteps = useCloseSteps();
  const handoverSteps = useHandoverSteps();

  const sessionId = session.status === "active" ? session.sessionId : null;

  // Distinct idempotency intents so close and handover don't share a dedupe key.
  const closeKey = useIdempotency(
    sessionId ? `shift:end:close:${sessionId}` : "shift:end:close:none",
  );
  const handoverKey = useIdempotency(
    sessionId ? `shift:end:handover:${sessionId}` : "shift:end:handover:none",
  );

  // Home now deep-links straight into a wizard via `?mode=close|handover`
  // (the two big shift-end buttons), skipping the choice screen. A bare
  // /shift/end (or any other value) still shows the choice screen.
  const [searchParams] = useSearchParams();
  const requestedMode = searchParams.get("mode");
  const [mode, setMode] = useState<Mode>(
    requestedMode === "close" || requestedMode === "handover"
      ? requestedMode
      : "choice",
  );
  // Set after endOfDaySignOff resolves: durationMs returned by the mutation.
  const [signOffDurationMs, setSignOffDurationMs] = useState<number | null>(null);
  // countChanged captured from the count step (shown on summary screen).
  const [signOffCountChanged, setSignOffCountChanged] = useState<number | null>(null);

  if (session.status === "loading") return null;
  if (session.status !== "active") return null; // RootLayout redirects

  // -------------------------------------------------------------------------
  // Close wizard onComplete
  // -------------------------------------------------------------------------
  async function onCloseComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!closeKey || !sessionId) return;
    const result = await endOfDaySignOff({
      idempotencyKey: closeKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { countChanged } : {}),
    });
    setSignOffCountChanged(countChanged);
    setSignOffDurationMs(result.durationMs);
  }

  // -------------------------------------------------------------------------
  // Handover wizard onComplete
  // -------------------------------------------------------------------------
  async function onHandoverComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!handoverKey || !sessionId) return;
    await handoverOut({
      idempotencyKey: handoverKey,
      sessionId,
      steps: confirmed,
      ...(countChanged != null ? { countChanged } : {}),
    });
    navigate("/shift/handover");
  }

  // -------------------------------------------------------------------------
  // Post-signoff: clear session + go to login (mirror lock.tsx, minus lockShift)
  // -------------------------------------------------------------------------
  function handleFinalSignOff() {
    clearSession();
    navigate("/login", { replace: true });
  }

  // -------------------------------------------------------------------------
  // Summary screen (shown after close wizard completes)
  // -------------------------------------------------------------------------
  if (mode === "close" && signOffDurationMs !== null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 gap-6">
        <Card className="w-full max-w-sm p-6 text-center">
          <h2 className="text-xl font-semibold">{t("shiftEnd.summaryTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("shiftEnd.summarySubtitle")}
          </p>

          <div className="mt-6 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {t("shiftEnd.summaryHoursLabel")}
              </p>
              <p className="text-3xl font-bold text-primary mt-1">
                {fmtShiftDuration(signOffDurationMs)}
              </p>
            </div>
            {signOffCountChanged != null && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t("shiftEnd.summaryStockDiffLabel")}
                </p>
                <p className="text-lg font-semibold mt-1">
                  {signOffCountChanged > 0 ? "+" : ""}
                  {signOffCountChanged}
                </p>
              </div>
            )}
          </div>

          <p className="mt-5 text-xs text-muted-foreground">
            {t("shiftEnd.summarySentNote")}
          </p>
        </Card>

        <Button className="w-full max-w-sm" onClick={handleFinalSignOff}>
          {t("shiftEnd.doneButton")}
        </Button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Wizards
  // -------------------------------------------------------------------------
  if (mode === "close") {
    return (
      <ShiftWizard
        title={t("shiftEnd.closeBooth")}
        steps={closeSteps}
        onComplete={onCloseComplete}
        terminalLabel={t("shiftEnd.closeTerminalLabel")}
      />
    );
  }

  if (mode === "handover") {
    return (
      <ShiftWizard
        title={t("shiftEnd.handoverTitle")}
        steps={handoverSteps}
        onComplete={onHandoverComplete}
        terminalLabel={t("shiftEnd.handoverTerminalLabel")}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Choice screen
  // -------------------------------------------------------------------------
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 gap-4">
      <h2 className="text-xl font-semibold">{t("shiftEnd.choiceTitle")}</h2>
      <p className="text-sm text-muted-foreground text-center">
        {t("shiftEnd.choiceSubtitle")}
      </p>

      <div className="flex flex-col gap-3 w-full max-w-sm mt-2">
        <Button
          variant="outline"
          className="h-auto py-5 flex flex-col items-start text-left"
          onClick={() => setMode("close")}
        >
          <span className="font-semibold text-base">{t("shiftEnd.closeBooth")}</span>
          <span className="text-xs text-muted-foreground mt-1">
            {t("shiftEnd.closeBoothDesc")}
          </span>
        </Button>

        <Button
          variant="outline"
          className="h-auto py-5 flex flex-col items-start text-left"
          onClick={() => setMode("handover")}
        >
          <span className="font-semibold text-base">{t("shiftEnd.handoverTitle")}</span>
          <span className="text-xs text-muted-foreground mt-1">
            {t("shiftEnd.handoverDesc")}
          </span>
        </Button>
      </div>
    </div>
  );
}
