import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockConvex: {
  connectionState?: () => { isWebSocketConnected: boolean };
  onStateChange?: (cb: () => void) => () => void;
} = {};

vi.mock("convex/react", () => ({
  useConvex: () => mockConvex,
}));

import { useIsOnline } from "@/hooks/useIsOnline";

describe("useIsOnline", () => {
  it("returns true when the websocket is connected", () => {
    mockConvex.connectionState = () => ({ isWebSocketConnected: true });
    mockConvex.onStateChange = (cb) => {
      cb();
      return () => {};
    };
    const { result } = renderHook(() => useIsOnline());
    expect(result.current).toBe(true);
  });

  it("returns false when disconnected and flips when state changes", () => {
    let connected = false;
    let listener: (() => void) | undefined;
    mockConvex.connectionState = () => ({ isWebSocketConnected: connected });
    mockConvex.onStateChange = (cb) => {
      listener = cb;
      cb();
      return () => {};
    };
    const { result } = renderHook(() => useIsOnline());
    expect(result.current).toBe(false);
    act(() => {
      connected = true;
      listener?.();
    });
    expect(result.current).toBe(true);
  });

  it("defaults to online when the state API is unavailable", () => {
    delete mockConvex.connectionState;
    delete mockConvex.onStateChange;
    const { result } = renderHook(() => useIsOnline());
    expect(result.current).toBe(true);
  });
});
