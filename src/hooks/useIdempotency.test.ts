import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIdempotency } from "./useIdempotency";

describe("useIdempotency", () => {
  it("returns the same key across renders for the same intent", () => {
    const { result, rerender } = renderHook(({ intent }) => useIdempotency(intent), {
      initialProps: { intent: "login:citra" },
    });
    const k1 = result.current;
    rerender({ intent: "login:citra" });
    expect(result.current).toBe(k1);
  });

  it("returns a different key when intent changes", () => {
    const { result, rerender } = renderHook(({ intent }) => useIdempotency(intent), {
      initialProps: { intent: "login:citra" },
    });
    const k1 = result.current;
    rerender({ intent: "login:bayu" });
    expect(result.current).not.toBe(k1);
  });
});
