import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock convex/react's useQuery — must be done BEFORE importing the hook under test.
vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

import { useQuery } from "convex/react";
import { useApproval } from "./useApproval";

describe("useApproval", () => {
  it("returns 'missing' for null requestId", () => {
    vi.mocked(useQuery).mockReturnValue(undefined);
    const { result } = renderHook(() => useApproval(null));
    expect(result.current).toBe("missing");
  });

  it("returns 'loading' while convex is fetching", () => {
    vi.mocked(useQuery).mockReturnValue(undefined);
    const { result } = renderHook(() => useApproval("req_abc" as any));
    expect(result.current).toBe("loading");
  });

  it("returns 'missing' when the row does not exist (query returned null)", () => {
    vi.mocked(useQuery).mockReturnValue(null);
    const { result } = renderHook(() => useApproval("req_abc" as any));
    expect(result.current).toBe("missing");
  });

  it.each(["pending", "resolved", "denied", "expired"] as const)(
    "surfaces status '%s' from the reactive query",
    (status) => {
      vi.mocked(useQuery).mockReturnValue({ status });
      const { result } = renderHook(() => useApproval("req_abc" as any));
      expect(result.current).toBe(status);
    },
  );
});
