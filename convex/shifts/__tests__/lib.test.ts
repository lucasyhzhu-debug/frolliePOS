// convex/shifts/__tests__/lib.test.ts
// deriveBoothState tests removed (ADR-053): deriveBoothState deleted from lib.ts.
import { expect, test } from "vitest";
import { computeShiftHoursMs } from "../lib";

test("computeShiftHoursMs", () => {
  expect(computeShiftHoursMs(1000, 1000 + 3_600_000)).toBe(3_600_000);
});
