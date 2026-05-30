import { describe, it, expect } from "vitest";
import { wibYear, wibDayWindow } from "./time";

describe("wibYear", () => {
  it("returns 2026 for noon UTC June 15 2026 (= 19:00 WIB same day)", () => {
    expect(wibYear(Date.UTC(2026, 5, 15, 12, 0, 0))).toBe(2026);
  });

  it("returns 2026 (new year) for 20:00 UTC Dec 31 2025 (= 03:00 WIB Jan 1 2026)", () => {
    expect(wibYear(Date.UTC(2025, 11, 31, 20, 0, 0))).toBe(2026);
  });

  it("returns 2025 for 16:30 UTC Dec 31 2025 (= 23:30 WIB Dec 31 2025 — still old year)", () => {
    expect(wibYear(Date.UTC(2025, 11, 31, 16, 30, 0))).toBe(2025);
  });

  it("returns 2026 for 17:01 UTC Dec 31 2025 (= 00:01 WIB Jan 1 2026 — new year)", () => {
    expect(wibYear(Date.UTC(2025, 11, 31, 17, 1, 0))).toBe(2026);
  });

  it("defaults to Date.now() when no argument", () => {
    const y = wibYear();
    expect(y).toBeGreaterThanOrEqual(2025);
    expect(y).toBeLessThan(2100);
  });
});

describe("wibDayWindow", () => {
  it("WIB day starts at 17:00 UTC the previous day", () => {
    // 2026-05-30 10:00 WIB = 2026-05-30 03:00 UTC
    const now = Date.UTC(2026, 4, 30, 3, 0, 0);
    const w = wibDayWindow(now);
    // WIB 2026-05-30 starts at 2026-05-29 17:00 UTC and ends at 2026-05-30 17:00 UTC
    expect(w.dayStartMs).toBe(Date.UTC(2026, 4, 29, 17, 0, 0));
    expect(w.dayEndMs).toBe(Date.UTC(2026, 4, 30, 17, 0, 0));
    expect(w.dateLabel).toBe("2026-05-30");
  });

  it("a time at exactly 17:00 UTC is the START of the next WIB day", () => {
    const now = Date.UTC(2026, 4, 30, 17, 0, 0);
    const w = wibDayWindow(now);
    expect(w.dateLabel).toBe("2026-05-31");
  });

  it("a time at 16:59:59 UTC is still the previous WIB day", () => {
    const now = Date.UTC(2026, 4, 30, 16, 59, 59);
    const w = wibDayWindow(now);
    expect(w.dateLabel).toBe("2026-05-30");
  });

  it("dayEndMs is exactly 24h after dayStartMs", () => {
    const now = Date.UTC(2026, 4, 30, 3, 0, 0);
    const w = wibDayWindow(now);
    expect(w.dayEndMs - w.dayStartMs).toBe(86_400_000);
  });
});
