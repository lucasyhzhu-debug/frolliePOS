import { describe, it, expect } from "vitest";
import { fieldMessageVariants } from "../field-message";

describe("fieldMessageVariants", () => {
  it("keeps tone variants (each returns base classes)", () => {
    for (const tone of ["error", "success"] as const) {
      expect(fieldMessageVariants({ tone })).toContain("border-l-2");
    }
  });
  it("default tone is error", () => {
    expect(fieldMessageVariants({})).toContain("text-error");
  });
  it("type no longer accepts an unsupported tone", () => {
    // Type-level guard: tone union is error|success only. Mirrors badge.test.tsx —
    // test files are excluded from `npm run typecheck` (tsconfig.app.json), so this
    // is enforced by the editor TS server / direct tsc, not CI typecheck. The real
    // CI guard is that any consumer writing tone="warning" fails `tsc -b`.
    // @ts-expect-error 'warning' removed from the tone union
    void fieldMessageVariants({ tone: "warning" });
  });
});
