import { useState } from "react";
import type { ReactNode } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import StepRail from "./StepRail";
import CountStep from "./CountStep";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Types (consumed by Tasks 13/14/15)
// ---------------------------------------------------------------------------

export type WizardStep = { key: string; label: string } & (
  | { type: "instruction"; body: ReactNode }
  | { type: "count" }
);

export interface ConfirmedStep {
  key: string;
  label: string;
  type: "instruction" | "count";
  confirmed_at: number;
}

export interface ShiftWizardProps {
  title: string;
  steps: WizardStep[];
  onComplete: (confirmed: ConfirmedStep[], countChanged: number | null) => Promise<void>;
  /** Override the final-step button text without touching the rail's step label. */
  terminalLabel?: string;
  /** Authoritative session id, forwarded to the count step (see CountStep). */
  sessionId?: Id<"staff_sessions">;
}

// ---------------------------------------------------------------------------
// Animation variants — guard every interaction with reduce (useReducedMotion)
// ---------------------------------------------------------------------------

const stepVariants = (reduce: boolean) => ({
  enter: { opacity: reduce ? 1 : 0, x: reduce ? 0 : 24 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: reduce ? 1 : 0, x: reduce ? 0 : -24 },
});

const transition = (reduce: boolean) =>
  reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30 };

// ---------------------------------------------------------------------------

export default function ShiftWizard({ title, steps, onComplete, terminalLabel, sessionId }: ShiftWizardProps) {
  const t = useT();
  const reduce = useReducedMotion() ?? false;

  const [currentIndex, setCurrentIndex] = useState(0);
  // confirmed steps banked so far (index-keyed)
  const [confirmed, setConfirmed] = useState<ConfirmedStep[]>([]);
  // lastCountChanged — captured from the most-recent count step onSubmitted
  const [lastCountChanged, setLastCountChanged] = useState<number | null>(null);
  // whether the current count step has been submitted yet
  const [countReady, setCountReady] = useState(false);
  const [busy, setBusy] = useState(false);
  // flips to true after onComplete resolves so all steps show as done in the rail
  const [completed, setCompleted] = useState(false);

  const currentStep = steps[currentIndex];
  const isLastStep = currentIndex === steps.length - 1;
  const isCountStep = currentStep.type === "count";

  // For a count step, the wizard waits for CountStep.onSubmitted before
  // revealing the advance button.
  const canAdvance = !isCountStep || countReady;

  function bankCurrentStep() {
    const entry: ConfirmedStep = {
      key: currentStep.key,
      label: currentStep.label,
      type: currentStep.type,
      confirmed_at: Date.now(),
    };
    return entry;
  }

  async function handleNext() {
    const entry = bankCurrentStep();
    const next = [...confirmed, entry];
    // Functional updater form avoids closing over stale confirmed.
    setConfirmed((prev) => [...prev, entry]);

    if (isLastStep) {
      setBusy(true);
      try {
        await onComplete(next, lastCountChanged);
        setCompleted(true);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Reset count-readiness for the upcoming step
    setCountReady(false);
    setCurrentIndex((i) => i + 1);
  }

  function handleBack() {
    if (currentIndex === 0) return;
    setCountReady(false);
    setCurrentIndex((i) => i - 1);
    // Remove the last banked entry (user went back)
    setConfirmed((prev) => prev.slice(0, -1));
  }

  function handleCountSubmitted(changed: number) {
    setLastCountChanged(changed);
    setCountReady(true);
  }

  // After onComplete resolves, all steps are done; otherwise steps before currentIndex are done
  const doneCount = completed ? steps.length : currentIndex;

  const variants = stepVariants(reduce);
  const trans = transition(reduce);

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* Title */}
      <h2 className="text-xl font-semibold">{title}</h2>

      {/* Rail + Step body side-by-side on wider screens, stacked on mobile */}
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        {/* Step rail */}
        <aside className="sm:w-44">
          <StepRail
            steps={steps.map((s) => ({ key: s.key, label: s.label }))}
            currentIndex={currentIndex}
            doneCount={doneCount}
          />
        </aside>

        {/* Step content */}
        <div className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentStep.key}
              initial="enter"
              animate="center"
              exit="exit"
              variants={variants}
              transition={trans}
            >
              {isCountStep ? (
                <CountStep
                  sessionId={sessionId}
                  onSubmitted={handleCountSubmitted}
                  submitLabel={t("shiftWizard.saveCount")}
                />
              ) : (
                <div className="prose prose-sm dark:prose-invert">
                  {(currentStep as Extract<WizardStep, { type: "instruction" }>).body}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <Button
          variant="outline"
          disabled={currentIndex === 0 || busy}
          onClick={handleBack}
        >
          {t("shiftWizard.back")}
        </Button>

        {/* For count steps: only show the advance button once countReady */}
        {canAdvance && (
          <Button disabled={busy} onClick={handleNext}>
            {isLastStep ? (terminalLabel ?? steps[currentIndex].label) : t("shiftWizard.next")}
          </Button>
        )}
      </div>
    </div>
  );
}
