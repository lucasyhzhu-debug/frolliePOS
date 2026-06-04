import { describe, it, expect } from "vitest";
import { isChunkLoadError } from "../chunkLoadError";

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: /assets/foo.js",
    "Importing a module script failed.",
    "TypeError: Failed to fetch dynamically imported module",
    "error loading dynamically imported module",
  ])("returns true for chunk-load message: %s", (msg) => {
    expect(isChunkLoadError(new Error(msg))).toBe(true);
  });

  it.each([
    "TypeError: cannot read property 'x' of undefined",
    "Network request failed",
    "Some unrelated error",
  ])("returns false for non-chunk message: %s", (msg) => {
    expect(isChunkLoadError(new Error(msg))).toBe(false);
  });

  it.each([null, undefined, {}, "", 0])("returns false for non-Error / falsy input: %s", (val) => {
    expect(isChunkLoadError(val)).toBe(false);
  });

  it("also matches when given a plain object with .message", () => {
    expect(isChunkLoadError({ message: "Failed to fetch dynamically imported module" })).toBe(true);
  });

  it("matches a bare string passed directly (no Error wrapper)", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
    expect(isChunkLoadError("some unrelated string")).toBe(false);
  });
});
