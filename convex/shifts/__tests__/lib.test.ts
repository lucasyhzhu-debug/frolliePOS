// convex/shifts/__tests__/lib.test.ts
import { expect, test, describe } from "vitest";
import { deriveBoothState, computeShiftHoursMs } from "../lib";

const DAY = 24 * 60 * 60 * 1000;
const wibDayStart = 1_000_000_000_000;

describe("deriveBoothState", () => {
  test("null latest → closed", () => {
    expect(deriveBoothState(null, wibDayStart).state).toBe("closed");
  });
  test("start_of_day today → open, names staff", () => {
    const r = deriveBoothState(
      { type: "start_of_day", staff_id: "s1" as any, created_at: wibDayStart + 10, shift_started_at: wibDayStart + 10 },
      wibDayStart,
    );
    expect(r.state).toBe("open");
    expect(r.staffId).toBe("s1");
  });
  test("lock → locked", () => {
    expect(deriveBoothState({ type: "lock", staff_id: "s1" as any, created_at: wibDayStart + 5, shift_started_at: wibDayStart }, wibDayStart).state).toBe("locked");
  });
  test("handover_out → handover_pending", () => {
    expect(deriveBoothState({ type: "handover_out", staff_id: "s1" as any, created_at: wibDayStart + 5, shift_started_at: wibDayStart }, wibDayStart).state).toBe("handover_pending");
  });
  test("signoff_close → closed", () => {
    expect(deriveBoothState({ type: "signoff_close", staff_id: "s1" as any, created_at: wibDayStart + 5, shift_started_at: wibDayStart }, wibDayStart).state).toBe("closed");
  });
  test("stale open from a prior WIB day → closed + staleAutoclose", () => {
    const r = deriveBoothState({ type: "start_of_day", staff_id: "s1" as any, created_at: wibDayStart - DAY, shift_started_at: wibDayStart - DAY }, wibDayStart);
    expect(r.state).toBe("closed");
    expect(r.staleAutoclose).toBe(true);
  });
});

test("computeShiftHoursMs", () => {
  expect(computeShiftHoursMs(1000, 1000 + 3_600_000)).toBe(3_600_000);
});
