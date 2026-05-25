import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        // shadcn defaults
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",

        success:
          "border-transparent bg-success-bg text-success",
        warning:
          "border-transparent bg-warning-bg text-warning",
        error:
          "border-transparent bg-error-bg text-error",
        info:
          "border-transparent bg-info-bg text-info",

        gofood:
          "border-transparent bg-gofood-light text-gofood-badge",
        grabfood:
          "border-transparent bg-grabfood-light text-grabfood",
        k3mart:
          "border-transparent bg-k3mart-light text-k3mart-badge",

        admin:
          "border-transparent bg-role-admin-bg text-role-admin",
        manager:
          "border-transparent bg-role-manager-bg text-role-manager",
        staff:
          "border-transparent bg-role-staff-bg text-role-staff",
        kitchen:
          "border-transparent bg-role-kitchen-bg text-role-kitchen",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
