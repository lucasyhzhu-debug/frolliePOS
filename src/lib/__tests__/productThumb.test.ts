import { describe, test, expect } from "vitest";
import { deriveInitials, resolveHue, chipColors } from "../productThumb";

describe("deriveInitials", () => {
  test("stored initials win, uppercased, max 3", () => {
    expect(deriveInitials("Whatever", "d8")).toBe("D8");
    expect(deriveInitials("Whatever", "abcd")).toBe("ABC");
  });
  test("derives first letter + first digit run from name", () => {
    expect(deriveInitials("Dubai 8pcs")).toBe("D8");
    expect(deriveInitials("Mixed Box 4pcs")).toBe("M4");
  });
  test("no digits → first letter only, uppercase", () => {
    expect(deriveInitials("Lotus")).toBe("L");
  });
});

describe("resolveHue", () => {
  test("valid stored hue wins", () => {
    expect(resolveHue("DUBAI_8PC", 30)).toBe(30);
  });
  test("ignores out-of-range stored hue and hashes code", () => {
    const h = resolveHue("DUBAI_8PC", 999);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  test("hash is deterministic and in range", () => {
    expect(resolveHue("ABC")).toBe(resolveHue("ABC"));
    expect(resolveHue("ABC")).toBeGreaterThanOrEqual(0);
    expect(resolveHue("ABC")).toBeLessThan(360);
  });
});

describe("chipColors", () => {
  test("returns hsl strings for the hue", () => {
    const c = chipColors(30);
    expect(c.bg).toContain("hsl(30");
    expect(c.fg).toContain("hsl(30");
    expect(c.border).toContain("hsl(30");
  });
});
