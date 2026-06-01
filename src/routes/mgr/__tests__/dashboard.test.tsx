import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * v0.5.3a — /mgr/dashboard surface smoke tests.
 *
 * Mocking pattern mirrors /mgr/refunds-pending tests: useQuery is dispatched
 * by FunctionReference name. The route makes two queries:
 *   - useSession's getSession   → mockSessionReturn
 *   - dashboardSummary          → mockSummaryReturn (undefined while pending)
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
let mockSummaryReturn: unknown = undefined;
let lastDashboardArgs: unknown = undefined;

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(
          query as Parameters<typeof getFunctionName>[0],
        );
      } catch {
        name = "";
      }
      if (name.includes("dashboardSummary")) {
        lastDashboardArgs = args;
        return mockSummaryReturn;
      }
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
  };
});

import MgrDashboard from "../dashboard";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/dashboard"]}>
        <Routes>
          <Route path="/mgr/dashboard" element={<MgrDashboard />} />
          <Route path="/history" element={<div>HISTORY_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

const EMPTY_SUMMARY = {
  gross: 0,
  refundsTotal: 0,
  net: 0,
  count: 0,
  avgBasket: 0,
  paymentMix: {
    qris: { count: 0, total: 0 },
    bca_va: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
  },
  topSkus: [],
  hourlyCurve: Array(24).fill(0),
  perStaff: [],
  voucherUsage: { count: 0, total: 0 },
  needsAttention: { flagged: 0 },
};

const POPULATED_SUMMARY = {
  gross: 500_000,
  refundsTotal: 50_000,
  net: 450_000,
  count: 10,
  avgBasket: 50_000,
  paymentMix: {
    qris: { count: 7, total: 350_000 },
    bca_va: { count: 3, total: 150_000 },
    unknown: { count: 0, total: 0 },
  },
  topSkus: [
    { code: "DUBAI8", name: "Dubai 8pcs", qty: 12 },
    { code: "DUBAI3", name: "Dubai 3pcs", qty: 7 },
  ],
  hourlyCurve: [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0,
  ],
  perStaff: [
    { staffId: "s1", name: "Sari", count: 6, total: 300_000 },
    { staffId: "s2", name: "Bayu", count: 4, total: 200_000 },
  ],
  voucherUsage: { count: 2, total: 30_000 },
  needsAttention: { flagged: 1 },
};

describe("MgrDashboard route (/mgr/dashboard)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    mockSummaryReturn = undefined;
    lastDashboardArgs = undefined;
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders the skeleton while the summary query is pending", () => {
    mockSummaryReturn = undefined;
    renderRoute();
    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-grid")).toBeNull();
  });

  it("renders all cards for an empty day without crashing on Math.max", () => {
    mockSummaryReturn = EMPTY_SUMMARY;
    renderRoute();
    expect(screen.getByTestId("dashboard-grid")).toBeInTheDocument();
    expect(screen.getByTestId("totals-card")).toBeInTheDocument();
    expect(screen.getByTestId("payment-mix-card")).toBeInTheDocument();
    expect(screen.getByTestId("top-skus-card")).toBeInTheDocument();
    expect(screen.getByTestId("hourly-curve-card")).toBeInTheDocument();
    expect(screen.getByTestId("voucher-usage-card")).toBeInTheDocument();
    expect(screen.getByTestId("per-staff-card")).toBeInTheDocument();
    expect(screen.getByTestId("needs-attention-card")).toBeInTheDocument();
    // 24 bars rendered, all at 0% height (Math.max guards against /0).
    expect(screen.getByTestId("hour-bar-0")).toBeInTheDocument();
    expect(screen.getByTestId("hour-bar-23")).toBeInTheDocument();
  });

  it("renders populated totals via rp()", () => {
    mockSummaryReturn = POPULATED_SUMMARY;
    renderRoute();
    expect(screen.getByTestId("totals-gross").textContent).toMatch(
      /Rp\s500\.000/,
    );
  });

  it("non-manager session shows the Hanya manajer gate and skips the query", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    renderRoute();
    expect(screen.getByText(/Hanya manajer/i)).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-grid")).toBeNull();
    expect(screen.queryByTestId("dashboard-skeleton")).toBeNull();
    // Confirm the dashboardSummary query was skipped (no args captured).
    expect(lastDashboardArgs).toBeUndefined();
  });

  it("clicking 'Lihat transaksi bermasalah' navigates to /history", () => {
    mockSummaryReturn = POPULATED_SUMMARY;
    renderRoute();
    const btn = screen.getByRole("button", {
      name: /Lihat transaksi bermasalah/i,
    });
    fireEvent.click(btn);
    expect(screen.getByText("HISTORY_PAGE")).toBeInTheDocument();
  });
});
