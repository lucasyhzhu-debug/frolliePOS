import { describe, it, expect } from "vitest";
import { isoDaysAgo, wibYear } from "../time";

describe("lib/time wibYear", () => {
  // staffreview Critical #2 regression: the WIB-year boundary. Moved here in v2.0
  // when _allocateReceiptNumber_internal took `year` as a param (the receipt test
  // no longer exercises wibYear(Date.now())); this guards the pure function that
  // _confirmPaid_internal now calls to compute the year.
  it("23:30 WIB Dec 31 is still the old year; 00:01 WIB Jan 1 is the new year", () => {
    // 23:30 WIB = 16:30 UTC Dec 31 2025 → WIB year 2025
    expect(wibYear(Date.UTC(2025, 11, 31, 16, 30, 0))).toBe(2025);
    // 00:01 WIB Jan 1 2026 = 17:01 UTC Dec 31 2025 → WIB year 2026
    expect(wibYear(Date.UTC(2025, 11, 31, 17, 1, 0))).toBe(2026);
  });
});

describe("lib/time isoDaysAgo", () => {
  it("returns an RFC3339 UTC date-time exactly N days before now, not a bare YYYY-MM-DD", () => {
    const now = Date.UTC(2026, 5, 10); // 2026-06-10T00:00:00.000Z
    const iso = isoDaysAgo(now, 7);

    // The bug this guards (issue #66): a date-only string ("2026-06-03") fails
    // Xendit GET /transactions with 400 `updated/gte must match format
    // "date-time"`. The exact-value assertion is the real check; the regex below
    // is a redundant shape-doc guard naming the RFC3339 form for the next reader.
    expect(iso).toBe("2026-06-03T00:00:00.000Z");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("subtracts whole days as a UTC instant (preserves the time-of-day)", () => {
    const now = Date.UTC(2026, 5, 10, 9, 30, 0); // 2026-06-10T09:30:00.000Z
    expect(isoDaysAgo(now, 1)).toBe("2026-06-09T09:30:00.000Z");
  });
});
