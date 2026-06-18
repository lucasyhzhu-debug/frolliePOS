import { describe, it, expect } from "vitest";
import { badgeVariants } from "../badge";

describe("badgeVariants", () => {
  it("keeps role + semantic variants (each returns base classes)", () => {
    for (const v of ["default","secondary","destructive","outline","success","warning","error","info","admin","manager","staff","kitchen"] as const) {
      expect(badgeVariants({ variant: v })).toContain("inline-flex");
    }
  });
  it("default variant includes the primary fill", () => {
    expect(badgeVariants({ variant: "default" })).toContain("bg-primary");
  });
  it("type no longer accepts removed channel variants", () => {
    // Type-level guard: `gofood` was removed from the variant union, so this
    // line only compiles because of the @ts-expect-error. NOTE: test files are
    // excluded from `npm run typecheck` (tsconfig.app.json), so this assertion
    // is enforced by the editor TS server / a direct `tsc` over this file, not
    // the CI typecheck. The real CI guard for the prune is that any *consumer*
    // writing `variant="gofood"` fails `tsc -b` (consumers are type-checked).
    // @ts-expect-error gofood removed from the variant union
    void badgeVariants({ variant: "gofood" });
  });
});
