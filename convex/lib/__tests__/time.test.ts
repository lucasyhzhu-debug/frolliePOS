import { describe, it, expect } from "vitest";
import { isoDaysAgo } from "../time";

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
