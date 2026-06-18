import { describe, it, expect } from "vitest";
import { sha256Hex } from "../sha256";

describe("sha256Hex", () => {
  it("matches the known SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("is deterministic", async () => {
    expect(await sha256Hex("frpos_live_x")).toBe(await sha256Hex("frpos_live_x"));
  });
});
