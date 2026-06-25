/**
 * Tests for CockpitHomeRoute (v1.3.0 Task 9) — real dashboard landing.
 * Covers consolidated headline, per-outlet cards, loading/empty states, and the
 * existing sign-out flow (preserved from the Spec-2 stub tests).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, waitFor, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import CockpitHomeRoute from "../index";

// ── hoisted mocks ──────────────────────────────────────────────────────────────

const { mockLogout, mockClearSession, mockUseQuery, mockUseOutletContext } =
  vi.hoisted(() => ({
    mockLogout: vi.fn().mockResolvedValue(null),
    mockClearSession: vi.fn(),
    mockUseQuery: vi.fn().mockReturnValue(undefined),
    mockUseOutletContext: vi.fn(),
  }));

// ── module mocks ───────────────────────────────────────────────────────────────

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useMutation: vi.fn(() => mockLogout),
    useQuery: mockUseQuery,
  };
});

// framer-motion: make useReducedMotion deterministic in jsdom
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

vi.mock("@/contexts/OutletContext", () => ({
  useOutletContext: (...args: unknown[]) => mockUseOutletContext(...args),
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idem-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({
    status: "active",
    sessionId: "kn7ses000000000000000000000",
    kind: "cockpit",
    staff: { _id: "kn7own", name: "Lucas", role: "owner" },
  })),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
}));

// ── fixtures ───────────────────────────────────────────────────────────────────

const CONSOLIDATED = { gross: 500000, txnCount: 7, refundTotal: 10000 };
const PW_OUTLET = {
  outletId: "kn7out000000000000000000000" as never,
  code: "PW",
  name: "Pakuwon Mall",
  gross: 500000,
  txnCount: 7,
};
const SB_OUTLET = {
  outletId: "kn7out111111111111111111111" as never,
  code: "SB",
  name: "Surabaya",
  gross: 120000,
  txnCount: 2,
};

/** Configure useQuery to return consolidated (1st call) + perOutlet (2nd call) */
function setLoadedQueries(perOutlet = [PW_OUTLET]) {
  mockUseQuery.mockImplementation((_fn: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    // Hooks are called in fixed order: consolidatedSummary (odd positions),
    // perOutletSummary (even positions). mock.calls.length includes the current
    // call at implementation time, so (length-1)%2 correctly alternates.
    return (mockUseQuery.mock.calls.length - 1) % 2 === 0 ? CONSOLIDATED : perOutlet;
  });
}

// ── render helper ──────────────────────────────────────────────────────────────

function renderHome() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/cockpit"]}>
        <Routes>
          <Route path="/cockpit" element={<CockpitHomeRoute />} />
          <Route path="/cockpit/login" element={<div data-testid="cockpit-login-page" />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// ── setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLogout.mockResolvedValue(null);
  // Reset to loading state by default
  mockUseQuery.mockReturnValue(undefined);
  // Reset outlet context to "all outlets" view by default
  mockUseOutletContext.mockReturnValue({
    currentOutletId: "all",
    outlets: undefined,
    setCurrentOutlet: vi.fn(),
  });
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe("Cockpit home", () => {
  it("renders the page heading and owner name while data loads", async () => {
    renderHome();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /today/i })).toBeInTheDocument(),
    );
    expect(screen.getByText("Lucas")).toBeInTheDocument();
  });

  it("shows loading skeletons while queries are undefined", async () => {
    // mockUseQuery returns undefined (default beforeEach state)
    renderHome();
    await waitFor(() =>
      expect(screen.getByTestId("consolidated-skeleton")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("outlets-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("consolidated-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("outlets-grid")).not.toBeInTheDocument();
  });

  it("renders consolidated headline numbers when data loads", async () => {
    setLoadedQueries();
    renderHome();
    await waitFor(() =>
      expect(screen.getByTestId("consolidated-card")).toBeInTheDocument(),
    );
    // Gross: rp(500000) → "Rp 500.000" (id-ID locale)
    expect(screen.getByTestId("consolidated-gross")).toHaveTextContent("500");
    // Transaction count is a plain number
    expect(screen.getByTestId("consolidated-txn-count")).toHaveTextContent("7");
    // Refund total: rp(10000) → "Rp 10.000"
    expect(screen.getByTestId("consolidated-refund-total")).toHaveTextContent("10");
    // Skeletons gone
    expect(screen.queryByTestId("consolidated-skeleton")).not.toBeInTheDocument();
  });

  it("renders one outlet card per outlet when currentOutletId is 'all'", async () => {
    setLoadedQueries([PW_OUTLET, SB_OUTLET]);
    renderHome();
    await waitFor(() =>
      expect(screen.getByTestId("outlets-grid")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("outlet-card-PW")).toBeInTheDocument();
    expect(screen.getByTestId("outlet-card-SB")).toBeInTheDocument();
    expect(screen.getByText("Pakuwon Mall")).toBeInTheDocument();
    expect(screen.getByText("Surabaya")).toBeInTheDocument();
  });

  it("filters to the selected outlet card when a specific outlet is selected", async () => {
    // Override outlet context to select PW only
    mockUseOutletContext.mockReturnValue({
      currentOutletId: PW_OUTLET.outletId,
      outlets: [PW_OUTLET, SB_OUTLET],
      setCurrentOutlet: vi.fn(),
    });
    setLoadedQueries([PW_OUTLET, SB_OUTLET]);
    renderHome();
    await waitFor(() =>
      expect(screen.getByTestId("outlet-card-PW")).toBeInTheDocument(),
    );
    // SB card filtered out
    expect(screen.queryByTestId("outlet-card-SB")).not.toBeInTheDocument();
    // Consolidated headline is unaffected (still business-wide)
    expect(screen.getByTestId("consolidated-card")).toBeInTheDocument();
  });

  it("renders the empty-outlets state when there are no outlets", async () => {
    setLoadedQueries([]); // empty perOutlet array
    renderHome();
    await waitFor(() =>
      expect(screen.getByTestId("empty-outlets")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("outlets-grid")).not.toBeInTheDocument();
  });

  it("sign-out ends the cockpit session, clears the local session, and returns to login", async () => {
    renderHome();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(mockLogout).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "kn7ses000000000000000000000" }),
    );
    expect(mockClearSession).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-login-page")).toBeInTheDocument(),
    );
  });

  it("still clears the local session and returns to login if the backend logout throws", async () => {
    mockLogout.mockRejectedValueOnce(new Error("NETWORK"));
    renderHome();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    // Best-effort: local session cleared + redirected regardless of the throw.
    await waitFor(() => expect(mockClearSession).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-login-page")).toBeInTheDocument(),
    );
  });
});
