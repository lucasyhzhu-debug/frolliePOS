// convex/shifts/__tests__/lib.test.ts
// deriveBoothState tests removed (ADR-053): deriveBoothState deleted from lib.ts.
// computeShiftHoursMs tests removed: helper deleted (dead, unused).
import { expect, test } from "vitest";
import { resolveStaffName } from "../lib";
import type { Id } from "../../_generated/dataModel";

test("resolveStaffName finds a name and falls back", () => {
  const a = "staff_a" as Id<"staff">;
  const names = [{ _id: a, name: "Sisca" }];
  expect(resolveStaffName(names, a)).toBe("Sisca");
  expect(resolveStaffName(names, "staff_x" as Id<"staff">)).toBe("Unknown");
  expect(resolveStaffName(names, null, "")).toBe("");
});
