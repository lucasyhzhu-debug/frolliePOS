import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Mock convex/react so useQuery is a no-op — localStorage layer tests don't
// need a ConvexProvider. Full integration covered by the Login route test (Task 14).
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
}));

import { useSession } from "./useSession";

// These tests cover the localStorage layer only. The hook short-circuits
// before invoking the Convex `useQuery` when localStorage is empty, so no
// ConvexProvider is required. Full integration with the Convex query is
// covered by the Login route test (Task 14).
describe("useSession (localStorage layer)", () => {
  beforeEach(() => localStorage.clear());

  it("returns status:none when no session stored", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.status).toBe("none"));
  });
});
