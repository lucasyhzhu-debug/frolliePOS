import { describe, it, expect } from "vitest";
import { wibYear } from "./time";

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
