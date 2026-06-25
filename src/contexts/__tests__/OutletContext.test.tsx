/**
 * Tests for OutletProvider / useOutletContext (v1.3.0 Task 8).
 *
 * Verifies:
 *  - Default `currentOutletId` is "all".
 *  - `setCurrentOutlet(id)` updates the context value.
 *  - `setCurrentOutlet(id)` writes `COCKPIT_CURRENT_OUTLET_KEY` to localStorage.
 *  - An existing localStorage value is read on mount (so the choice survives reload).
 *  - `outlets` is surfaced from the mocked `listOutlets` query.
 *  - Query is skipped when session is not an active cockpit session.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { OutletProvider, useOutletContext } from "../OutletContext";
import { COCKPIT_CURRENT_OUTLET_KEY } from "@/lib/storage-keys";
import type { Id } from "../../../convex/_generated/dataModel";

// ── mock data ─────────────────────────────────────────────────────────────────

const OUTLET_A = {
  _id: "kn7out000000001" as Id<"outlets">,
  code: "PKW",
  name: "Pakuwon Mall",
  timezone: "Asia/Jakarta",
  active: true,
  created_at: 0,
};
const OUTLET_B = {
  _id: "kn7out000000002" as Id<"outlets">,
  code: "GMD",
  name: "Grand City",
  timezone: "Asia/Jakarta",
  active: true,
  created_at: 0,
};

// ── vi.hoisted mocks ──────────────────────────────────────────────────────────

const { mockUseQuery, mockUseSession } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(() => [OUTLET_A, OUTLET_B]),
  mockUseSession: vi.fn(() => ({
    status: "active" as const,
    sessionId: "kn7ses000000000000000000000" as Id<"staff_sessions">,
    kind: "cockpit" as const,
    staff: { _id: "kn7own" as Id<"staff">, name: "Lucas", role: "owner" as const },
  })),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useQuery: mockUseQuery };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: mockUseSession,
}));

// ── probe component ───────────────────────────────────────────────────────────

function Probe() {
  const { outlets, currentOutletId, setCurrentOutlet } = useOutletContext();
  return (
    <div>
      <span data-testid="current">{currentOutletId}</span>
      <span data-testid="outlets-count">{outlets?.length ?? 0}</span>
      <button data-testid="btn-select-outlet-a" onClick={() => setCurrentOutlet(OUTLET_A._id)}>
        {"pick outlet A"}
      </button>
      <button data-testid="btn-select-all" onClick={() => setCurrentOutlet("all")}>
        {"pick all"}
      </button>
    </div>
  );
}

// ── render helper ─────────────────────────────────────────────────────────────

function renderProvider() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <OutletProvider>
        <Probe />
      </OutletProvider>
    </ConvexProvider>,
  );
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockUseQuery.mockReturnValue([OUTLET_A, OUTLET_B]);
  mockUseSession.mockReturnValue({
    status: "active" as const,
    sessionId: "kn7ses000000000000000000000" as Id<"staff_sessions">,
    kind: "cockpit" as const,
    staff: { _id: "kn7own" as Id<"staff">, name: "Lucas", role: "owner" as const },
  });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("OutletProvider", () => {
  it("defaults to 'all' when localStorage is empty", () => {
    renderProvider();
    expect(screen.getByTestId("current").textContent).toBe("all");
  });

  it("surfaces the outlets list from useQuery", () => {
    renderProvider();
    expect(screen.getByTestId("outlets-count").textContent).toBe("2");
  });

  it("setCurrentOutlet updates currentOutletId in the context", async () => {
    renderProvider();
    expect(screen.getByTestId("current").textContent).toBe("all");
    fireEvent.click(screen.getByTestId("btn-select-outlet-a"));
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe(OUTLET_A._id),
    );
  });

  it("setCurrentOutlet persists the selection to localStorage", async () => {
    renderProvider();
    fireEvent.click(screen.getByTestId("btn-select-outlet-a"));
    await waitFor(() =>
      expect(localStorage.getItem(COCKPIT_CURRENT_OUTLET_KEY)).toBe(OUTLET_A._id),
    );
  });

  it("setting back to 'all' persists 'all' to localStorage", async () => {
    renderProvider();
    fireEvent.click(screen.getByTestId("btn-select-outlet-a"));
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe(OUTLET_A._id),
    );
    fireEvent.click(screen.getByTestId("btn-select-all"));
    await waitFor(() =>
      expect(localStorage.getItem(COCKPIT_CURRENT_OUTLET_KEY)).toBe("all"),
    );
  });

  it("reads a pre-existing localStorage value on mount", () => {
    localStorage.setItem(COCKPIT_CURRENT_OUTLET_KEY, OUTLET_B._id);
    renderProvider();
    expect(screen.getByTestId("current").textContent).toBe(OUTLET_B._id);
  });

  it("skips the query when session is not an active cockpit session", () => {
    mockUseSession.mockReturnValueOnce({
      status: "none" as const,
      sessionId: null,
      staff: null,
    });
    mockUseQuery.mockReturnValue(undefined);
    renderProvider();
    // useQuery was called with "skip" → returns undefined → outlets-count is 0.
    expect(screen.getByTestId("outlets-count").textContent).toBe("0");
  });
});
