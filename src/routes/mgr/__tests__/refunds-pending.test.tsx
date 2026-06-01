import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * B24 — /mgr/refunds-pending surface smoke tests.
 *   1. Manager gate — non-manager session shows "Manager access required" and
 *      does NOT render the list.
 *   2. Empty state — manager + listPendingSettlement = [] shows the empty copy
 *      and a 0-count / Rp 0 header.
 *   3. List + summary — manager + two fixture rows renders both amounts and
 *      the correct count + sum.
 *
 * useQuery dispatch is by FunctionReference name (same as
 * src/routes/refund/__tests__/detail.test.tsx). The route makes two queries:
 *   - useSession's getSession    → mockSessionReturn
 *   - listPendingSettlement      → mockListReturn
 * useMutation is a no-op stub — no test drives the settle action (per B24 plan,
 * that path is exercised by the B28 manual smoke).
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
let mockListReturn: unknown = [];

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
      if (name.includes("listPendingSettlement")) return mockListReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
  };
});

import MgrRefundsPending from "../refunds-pending";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/refunds-pending"]}>
        <Routes>
          <Route path="/mgr/refunds-pending" element={<MgrRefundsPending />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

const REFUND_FIXTURE_1 = {
  _id: "refund_1",
  _creationTime: 0,
  transaction_id: "txn_1",
  lines: [{ line_id: "line_1", qty: 1, refund_amount: 43_333 }],
  total_refund: 43_333,
  reason: "customer changed mind",
  requested_by: "staff_1",
  approver_id: "staff_2",
  approval_source: "booth_inline",
  settlement_status: "pending",
  created_at: 1_700_000_000_000,
};

const REFUND_FIXTURE_2 = {
  _id: "refund_2",
  _creationTime: 0,
  transaction_id: "txn_2",
  lines: [{ line_id: "line_2", qty: 1, refund_amount: 50_000 }],
  total_refund: 50_000,
  reason: "wrong item",
  requested_by: "staff_1",
  approver_id: "staff_2",
  approval_source: "booth_inline",
  settlement_status: "pending",
  created_at: 1_700_000_001_000,
};

describe("MgrRefundsPending route (/mgr/refunds-pending)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    mockListReturn = [];
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("blocks non-managers with a 'Manager access required' message", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    renderRoute();
    expect(screen.getByText(/Manager access required/i)).toBeInTheDocument();
    // The summary header + empty-state should NOT render.
    expect(screen.queryByTestId("refunds-pending-count")).toBeNull();
    expect(
      screen.queryByText(/No refunds awaiting settlement\./i),
    ).toBeNull();
  });

  it("renders empty state + 0/Rp 0 header when the queue is empty", () => {
    mockListReturn = [];
    renderRoute();
    expect(
      screen.getByText(/No refunds awaiting settlement\./i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("refunds-pending-count").textContent).toMatch(
      /^0 pending refunds$/,
    );
    expect(screen.getByTestId("refunds-pending-sum").textContent).toBe("Rp 0");
  });

  it("renders both rows + summary for two pending refunds", () => {
    mockListReturn = [REFUND_FIXTURE_1, REFUND_FIXTURE_2];
    renderRoute();
    expect(screen.getByText("Rp 43.333")).toBeInTheDocument();
    expect(screen.getByText("Rp 50.000")).toBeInTheDocument();
    expect(screen.getByTestId("refunds-pending-sum").textContent).toBe(
      "Rp 93.333",
    );
    expect(screen.getByTestId("refunds-pending-count").textContent).toMatch(
      /^2 pending refunds$/,
    );
  });
});
