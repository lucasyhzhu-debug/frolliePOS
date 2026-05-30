import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Mock convex/react so useQuery is a no-op — localStorage layer tests don't
// need a ConvexProvider. Full integration covered by the Login route test (Task 14).
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
}));

import { useSession, storeSession, clearSession } from "./useSession";

// These tests cover the localStorage layer only. The hook short-circuits
// before invoking the Convex `useQuery` when localStorage is empty, so no
// ConvexProvider is required. Full integration with the Convex query is
// covered by the Login route test (Task 14).
describe("useSession (localStorage layer)", () => {
  beforeEach(() => {
    localStorage.clear();
    // Ensure a clean session state between tests.
    clearSession();
  });

  it("returns status:none when no session stored", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.status).toBe("none"));
  });

  it("storeSession notifies same-tab listeners (Fix 1)", async () => {
    // Render two independent useSession hooks in the same tab.
    const { result: r1 } = renderHook(() => useSession());
    const { result: r2 } = renderHook(() => useSession());

    // Both start as none.
    await waitFor(() => expect(r1.current.status).toBe("none"));
    await waitFor(() => expect(r2.current.status).toBe("none"));

    // storeSession writes to localStorage and notifies all listeners.
    // useQuery is mocked to return undefined (loading state), so status
    // transitions from 'none' → 'loading' once stored is set.
    act(() => {
      storeSession("test-session-id", "staff_dummy" as import("../../convex/_generated/dataModel").Id<"staff">);
    });

    // Both hooks must react — status moves from 'none' to 'loading'
    // (because useQuery mock returns undefined for the validation check).
    await waitFor(() => expect(r1.current.status).toBe("loading"));
    await waitFor(() => expect(r2.current.status).toBe("loading"));
  });

  it("clearSession notifies same-tab listeners", async () => {
    // Start with a stored session.
    storeSession("another-session-id", "staff_dummy" as import("../../convex/_generated/dataModel").Id<"staff">);

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.status).toBe("loading"));

    act(() => {
      clearSession();
    });

    await waitFor(() => expect(result.current.status).toBe("none"));
  });
});
