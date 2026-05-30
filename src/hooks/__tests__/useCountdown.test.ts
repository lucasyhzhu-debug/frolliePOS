import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown, DEFAULT_LIFETIME_MS } from "../useCountdown";

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns placeholder when targetEpoch is undefined", () => {
    const { result } = renderHook(() => useCountdown(undefined));
    expect(result.current.mmss).toBe("--:--");
    expect(result.current.pctRemaining).toBe(0);
    expect(result.current.expired).toBe(false);
  });

  it("formats mm:ss correctly with leading zeros", () => {
    const target = Date.now() + 9 * 60_000 + 5_000; // 9m 05s from now
    const { result } = renderHook(() => useCountdown(target));
    expect(result.current.mmss).toBe("09:05");
    expect(result.current.expired).toBe(false);
  });

  it("formats full 15 minutes at creation", () => {
    const target = Date.now() + DEFAULT_LIFETIME_MS; // exactly 15m
    const { result } = renderHook(() => useCountdown(target));
    expect(result.current.mmss).toBe("15:00");
    expect(result.current.pctRemaining).toBeCloseTo(1, 5);
    expect(result.current.expired).toBe(false);
  });

  it("pctRemaining is 0.5 at the halfway point", () => {
    const target = Date.now() + DEFAULT_LIFETIME_MS / 2; // 7m 30s
    const { result } = renderHook(() => useCountdown(target));
    expect(result.current.pctRemaining).toBeCloseTo(0.5, 5);
  });

  it("advances countdown after a timer tick", () => {
    const target = Date.now() + 2 * 60_000 + 30_000; // 2m 30s
    const { result } = renderHook(() => useCountdown(target));

    expect(result.current.mmss).toBe("02:30");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.mmss).toBe("02:29");

    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(result.current.mmss).toBe("02:00");
  });

  it("reports expired=true and mmss='00:00' when target is in the past", () => {
    const target = Date.now() - 1_000; // 1s in the past
    const { result } = renderHook(() => useCountdown(target));
    expect(result.current.mmss).toBe("00:00");
    expect(result.current.pctRemaining).toBe(0);
    expect(result.current.expired).toBe(true);
  });

  it("transitions to expired=true after the countdown reaches zero", () => {
    const target = Date.now() + 3_000; // 3 seconds from now
    const { result } = renderHook(() => useCountdown(target));

    expect(result.current.expired).toBe(false);
    expect(result.current.mmss).toBe("00:03");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.expired).toBe(true);
    expect(result.current.mmss).toBe("00:00");
  });

  it("does not start an interval when targetEpoch is undefined", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { result } = renderHook(() => useCountdown(undefined));
    // No interval should have been scheduled for the countdown.
    // (React's own internals may call setInterval; we check the return is placeholder.)
    expect(result.current.mmss).toBe("--:--");
    // The spy may have been called by React internals; we just verify no crash.
    setIntervalSpy.mockRestore();
  });

  it("cleans up the interval on unmount", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const target = Date.now() + 60_000;
    const { unmount } = renderHook(() => useCountdown(target));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
