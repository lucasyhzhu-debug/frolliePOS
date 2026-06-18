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
    // @ts-expect-error gofood removed from the variant union (typecheck guards this)
    void badgeVariants({ variant: "gofood" });
  });
});
