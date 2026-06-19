import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Inline form-validation message. Sanctioned primitive for sync validation
// (ADR-048) — anchored under the field, AA-legible on the phthalo canvas.
// Tone color rides the dark-lifted --color-error/--color-success tokens.
const fieldMessageVariants = cva(
  "flex items-start gap-1.5 rounded-r-sm border-l-2 py-0.5 pl-2 text-sm leading-snug",
  {
    variants: {
      tone: {
        error: "border-error text-error bg-error/10",
        success: "border-success text-success bg-success/10",
      },
    },
    defaultVariants: { tone: "error" },
  },
);

const TONE_ICON = { error: AlertCircle, success: CheckCircle2 } as const;
// error interrupts (role=alert ⇒ assertive); success is polite (role=status).
const TONE_ROLE = { error: "alert", success: "status" } as const;

export interface FieldMessageProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof fieldMessageVariants> {}

export function FieldMessage({
  className,
  tone,
  children,
  ...props
}: FieldMessageProps) {
  const t = tone ?? "error";
  const Icon = TONE_ICON[t];
  return (
    <p
      role={TONE_ROLE[t]}
      className={cn(fieldMessageVariants({ tone }), className)}
      {...props}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export { fieldMessageVariants };
