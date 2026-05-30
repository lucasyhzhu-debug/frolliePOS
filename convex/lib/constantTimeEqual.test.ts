import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "./constantTimeEqual";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  it("returns false for strings of different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("returns false for same-length strings that differ in one char", () => {
    expect(constantTimeEqual("hello", "hellp")).toBe(false);
  });
});
