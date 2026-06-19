import { cn } from "@/lib/utils";

export interface StepRailProps {
  steps: { key: string; label: string }[];
  currentIndex: number;
  doneCount: number;
}

/**
 * StepRail — vertical progress rail for ShiftWizard (v1.2 Task 11).
 *
 * Done steps  → teal checkmark (text-success)
 * Current step → citrus ring   (text-citrus + border-citrus ring)
 * Pending steps → muted         (text-muted-foreground)
 *
 * Uses semantic tokens ONLY — no raw Tailwind palette literals.
 */
export default function StepRail({ steps, currentIndex, doneCount }: StepRailProps) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((step, i) => {
        const isDone = i < doneCount;
        const isCurrent = i === currentIndex;

        return (
          <li key={step.key} className="flex items-center gap-3">
            {/* Step indicator */}
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold",
                isDone
                  ? "border-success bg-success/15 text-success"
                  : isCurrent
                    ? "border-citrus text-citrus"
                    : "border-muted-foreground/40 text-muted-foreground",
              )}
              aria-current={isCurrent ? "step" : undefined}
            >
              {isDone ? (
                <svg
                  aria-hidden
                  viewBox="0 0 12 12"
                  className="h-4 w-4 stroke-current"
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="2,6 5,9 10,3" />
                </svg>
              ) : (
                <span>{i + 1}</span>
              )}
            </span>

            {/* Step label */}
            <span
              className={cn(
                "text-sm",
                isDone
                  ? "text-success"
                  : isCurrent
                    ? "font-medium text-citrus"
                    : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
