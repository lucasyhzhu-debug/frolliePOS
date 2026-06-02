import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { PrinterProvider, usePrinter } from "../PrinterProvider";

/**
 * The provider hoists the BLE connection above the router so it survives
 * navigation. These tests cover the wiring + the safe no-op default that lets
 * the 100+ component tests render without wrapping in the provider.
 */
describe("usePrinter", () => {
  it("returns a safe no-op default outside a provider", async () => {
    const { result } = renderHook(() => usePrinter());
    expect(result.current.status).toBe("unsupported");
    // Default print rejects rather than silently succeeding.
    await expect(result.current.print(new Uint8Array())).rejects.toThrow();
  });

  it("exposes the shared printer api inside the provider", () => {
    const { result } = renderHook(() => usePrinter(), {
      wrapper: ({ children }) => <PrinterProvider>{children}</PrinterProvider>,
    });
    // jsdom has no navigator.bluetooth → the real hook initializes "unsupported".
    expect(result.current.status).toBe("unsupported");
    expect(typeof result.current.connect).toBe("function");
    expect(typeof result.current.disconnect).toBe("function");
    expect(typeof result.current.print).toBe("function");
  });
});
