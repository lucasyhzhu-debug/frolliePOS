import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    delete mockConvex.connectionState;
    delete mockConvex.onStateChange;
  });

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

  it("polls every 5s when connectionState exists but onStateChange is absent", () => {
    let connected = false;
    mockConvex.connectionState = () => ({ isWebSocketConnected: connected });
    // onStateChange intentionally absent — polling path
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useIsOnline());
      expect(result.current).toBe(false);
      connected = true;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the polling interval on unmount", () => {
    let connected = false;
    mockConvex.connectionState = () => ({ isWebSocketConnected: connected });
    // onStateChange intentionally absent — polling path
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useIsOnline());
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      // Advancing time after unmount should not throw
      vi.advanceTimersByTime(10000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
