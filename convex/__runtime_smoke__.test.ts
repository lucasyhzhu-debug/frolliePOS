import { describe, it, expect } from "vitest";
import { argon2id, argon2Verify } from "hash-wasm";

describe("hash-wasm runtime", () => {
  it("loads + hashes + verifies under Node (used by Convex action runtime)", async () => {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const hash = await argon2id({
      password: "1234",
      salt,
      parallelism: 1,
      iterations: 2,
      memorySize: 19_456,
      hashLength: 32,
      outputType: "encoded",
    });
    expect(hash.startsWith("$argon2id$")).toBe(true);

    const ok = await argon2Verify({ password: "1234", hash });
    expect(ok).toBe(true);

    const bad = await argon2Verify({ password: "0000", hash });
    expect(bad).toBe(false);
  });
});
