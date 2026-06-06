import { describe, it, expect } from "vitest";
import { buildAddCardLabel } from "../label";

// Cross-reference: convex/seed/internal.ts:101-109 defines the 7 seed products.
// If this list changes there, update here.
describe("buildAddCardLabel", () => {
  it.each([
    ["Dubai", "1 pc", "Add Dubai 1 pc"],
    ["Dubai", "3 pcs", "Add Dubai 3 pcs"],
    ["Dubai", "8 pcs", "Add Dubai 8 pcs"],
    ["Choco", "1 pc", "Add Choco 1 pc"],
    ["Matcha", "1 pc", "Add Matcha 1 pc"],
    ["Lotus", "1 pc", "Add Lotus 1 pc"],
    ["Mixed Box", "4 pcs", "Add Mixed Box 4 pcs"],
  ])("seed product: %s %s → %s", (name, packLabel, expected) => {
    expect(buildAddCardLabel(name, packLabel)).toBe(expected);
  });

  it("empty pack_label → omits the trailing segment", () => {
    expect(buildAddCardLabel("Dubai", "")).toBe("Add Dubai");
  });

  it("whitespace-only pack_label → treated as empty", () => {
    expect(buildAddCardLabel("Dubai", "   ")).toBe("Add Dubai");
  });

  it("preserves whitespace inside the name (Mixed Box)", () => {
    expect(buildAddCardLabel("Mixed Box", "4 pcs")).toBe("Add Mixed Box 4 pcs");
  });
});
