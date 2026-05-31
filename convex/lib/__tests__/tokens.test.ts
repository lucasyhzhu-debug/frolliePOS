import { describe, it, expect } from "vitest";
import { mintUrlSafeToken } from "../tokens";

describe("mintUrlSafeToken", () => {
  it("returns a 43-character URL-safe string for 32 bytes (base64url, no padding)", () => {
    const t = mintUrlSafeToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → ceil(32 * 4/3) = 43 chars, no `=` padding in base64url
    expect(t.length).toBe(43);
  });

  it("returns distinct tokens across calls (entropy sanity check)", () => {
    const a = mintUrlSafeToken();
    const b = mintUrlSafeToken();
    expect(a).not.toBe(b);
  });

  it("supports custom byte counts", () => {
    expect(mintUrlSafeToken(16).length).toBe(22);
  });
});
