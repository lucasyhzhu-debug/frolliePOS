import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { fieldMessageVariants, FieldMessage } from "../field-message";

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

describe("FieldMessage component rendering", () => {
  it("renders with tone=error and exposes role=alert", () => {
    render(<FieldMessage tone="error">Something went wrong</FieldMessage>);
    const el = screen.getByRole("alert");
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("Something went wrong");
  });

  it("renders with tone=success and exposes role=status", () => {
    render(<FieldMessage tone="success">Looks good</FieldMessage>);
    const el = screen.getByRole("status");
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("Looks good");
  });
});
