import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Hoist mocks so they are available when vi.mock factories run.
const { mockUseQuery, mockUseDeviceId } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseDeviceId: vi.fn<[], string | null>(),
}));

vi.mock("convex/react", () => ({ useQuery: mockUseQuery }));

vi.mock("@/hooks/useDeviceId", () => ({ useDeviceId: mockUseDeviceId }));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    shifts: {
      public: {
        boothState: "shifts:public:boothState",
      },
    },
  },
}));

import { useBoothState } from "../useBoothState";

describe("useBoothState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined while the query is loading (useQuery returns undefined)", () => {
    mockUseDeviceId.mockReturnValue("device-abc");
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useBoothState());
    expect(result.current).toBeUndefined();
  });

  it("returns the booth state when the query resolves", () => {
    const boothData = {
      state: "open" as const,
      staffId: "kn7staff0000000000000000000000",
      staffName: "Alice",
      staleAutoclose: false,
    };
    mockUseDeviceId.mockReturnValue("device-abc");
    mockUseQuery.mockReturnValue(boothData);

    const { result } = renderHook(() => useBoothState());
    expect(result.current).toEqual(boothData);
  });

  it("passes deviceId as the query arg when deviceId is ready", () => {
    mockUseDeviceId.mockReturnValue("device-xyz");
    mockUseQuery.mockReturnValue(undefined);

    renderHook(() => useBoothState());

    expect(mockUseQuery).toHaveBeenCalledTimes(1);
    const [, secondArg] = mockUseQuery.mock.calls[0];
    expect(secondArg).toEqual({ deviceId: "device-xyz" });
  });

  it('passes "skip" to useQuery when deviceId is null (not yet ready)', () => {
    mockUseDeviceId.mockReturnValue(null);
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useBoothState());

    expect(mockUseQuery).toHaveBeenCalledTimes(1);
    const [, secondArg] = mockUseQuery.mock.calls[0];
    expect(secondArg).toBe("skip");
    expect(result.current).toBeUndefined();
  });

  it("returns the closed state when staffId is null", () => {
    const boothData = {
      state: "closed" as const,
      staffId: null,
      staffName: null,
      staleAutoclose: false,
    };
    mockUseDeviceId.mockReturnValue("device-abc");
    mockUseQuery.mockReturnValue(boothData);

    const { result } = renderHook(() => useBoothState());
    expect(result.current).toEqual(boothData);
  });
});
