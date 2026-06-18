import { describe, it, expect } from "vitest";
import { errorSignature, normalizeMessage, truncate } from "../lib";

describe("ops/lib", () => {
  it("same kind+route+normalized message → same signature", () => {
    const a = errorSignature({ kind: "crash", route: "/sale", message: "Cannot read x of undefined at 0x1a2b" });
    const b = errorSignature({ kind: "crash", route: "/sale", message: "Cannot read x of undefined at 0x9f3c" });
    expect(a).toBe(b); // hex/number drift normalized away
  });
  it("different kind → different signature", () => {
    expect(errorSignature({ kind: "crash", message: "boom" }))
      .not.toBe(errorSignature({ kind: "payment", message: "boom" }));
  });
  it("normalizeMessage strips digits and hex", () => {
    expect(normalizeMessage("txn 12345 failed 0xABC")).toBe(normalizeMessage("txn 99 failed 0x00"));
  });
  it("truncate caps length", () => {
    expect(truncate("a".repeat(600), 500)).toHaveLength(500);
    expect(truncate("short", 500)).toBe("short");
  });
});
