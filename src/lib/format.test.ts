import { describe, it, expect } from "vitest";
import { rp, fmtTime, fmtDate, fmtRelative } from "./format";

describe("rp", () => {
  it("formats positive integers with Rp prefix and id-ID grouping", () => {
    expect(rp(25000)).toBe("Rp 25.000");
    expect(rp(1_500_000)).toBe("Rp 1.500.000");
  });
  it("handles zero", () => {
    expect(rp(0)).toBe("Rp 0");
  });
});

describe("fmtTime", () => {
  it("returns HH:mm in Jakarta time", () => {
    // 2026-05-25T07:38:00Z = 14:38 Jakarta (UTC+7, no DST)
    const ts = Date.UTC(2026, 4, 25, 7, 38, 0);
    expect(fmtTime(ts)).toBe("14:38");
  });
});

describe("fmtDate", () => {
  it("returns short day + month in id-ID", () => {
    const ts = Date.UTC(2026, 4, 25, 7, 0, 0);
    // "25 Mei" in Indonesian
    expect(fmtDate(ts)).toMatch(/25 Mei/);
  });
});

describe("fmtRelative", () => {
  it("returns 'just now' for <30s ago", () => {
    expect(fmtRelative(Date.now() - 5_000)).toBe("just now");
  });
  it("returns Xm ago for minutes", () => {
    expect(fmtRelative(Date.now() - 4 * 60_000)).toBe("4m ago");
  });
});
