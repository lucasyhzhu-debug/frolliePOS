import { describe, it, expect } from "vitest";
import { chunkBytes } from "../useThermalPrinter";

describe("chunkBytes", () => {
  it("returns [] for empty input", () => {
    expect(chunkBytes(new Uint8Array(0), 20)).toEqual([]);
  });
  it("returns one chunk when smaller than size", () => {
    const out = chunkBytes(new Uint8Array([1, 2, 3]), 20);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
  });
  it("splits exactly on the boundary", () => {
    const out = chunkBytes(new Uint8Array([1, 2, 3, 4]), 2);
    expect(out).toHaveLength(2);
    expect(Array.from(out[1])).toEqual([3, 4]);
  });
  it("splits a remainder into a final short chunk", () => {
    const out = chunkBytes(new Uint8Array([1, 2, 3, 4, 5]), 2);
    expect(out).toHaveLength(3);
    expect(Array.from(out[2])).toEqual([5]);
  });
});
