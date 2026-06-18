// convex/lib/__tests__/apiCursor.test.ts
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../apiCursor";

describe("cursor codec", () => {
  it("round-trips (orderKeyMs, creationTime)", () => {
    const c = encodeCursor(1718600000000, 1718600000123.4);
    expect(decodeCursor(c)).toEqual({ orderKeyMs: 1718600000000, creationTime: 1718600000123.4 });
  });
  it("is opaque base64url (no '+' '/' '=')", () => {
    expect(encodeCursor(1, 2)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("throws BAD_CURSOR on garbage", () => {
    expect(() => decodeCursor("@@@not-base64@@@")).toThrow("BAD_CURSOR");
  });
});
