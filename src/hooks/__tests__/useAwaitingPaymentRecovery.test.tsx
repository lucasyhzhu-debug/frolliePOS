import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockSession: unknown;
let mockList: unknown;

vi.mock("@/hooks/useSession", () => ({
  useSession: () => mockSession,
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (q: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(q as Parameters<typeof getFunctionName>[0]);
      } catch {
        name = "";
      }
      if (name.includes("listRecentAwaitingPayment")) return mockList;
      return undefined;
    },
  };
});

import { useAwaitingPaymentRecovery } from "../useAwaitingPaymentRecovery";

describe("useAwaitingPaymentRecovery", () => {
  beforeEach(() => {
    mockSession = {
      status: "active",
      sessionId: "s1",
      staff: { _id: "x", name: "A", role: "staff" },
    };
    mockList = undefined;
  });

  it("returns count 0 / latest null while loading", () => {
    mockList = undefined;
    const { result } = renderHook(() => useAwaitingPaymentRecovery());
    expect(result.current).toEqual({ count: 0, latest: null });
  });

  it("returns count 0 / latest null when empty", () => {
    mockList = [];
    const { result } = renderHook(() => useAwaitingPaymentRecovery());
    expect(result.current).toEqual({ count: 0, latest: null });
  });

  it("returns count + the most-recent txn by created_at", () => {
    mockList = [
      { _id: "t1", created_at: 100 },
      { _id: "t3", created_at: 300 },
      { _id: "t2", created_at: 200 },
    ];
    const { result } = renderHook(() => useAwaitingPaymentRecovery());
    expect(result.current.count).toBe(3);
    expect(result.current.latest?._id).toBe("t3");
  });
});
