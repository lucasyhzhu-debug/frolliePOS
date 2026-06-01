import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * v0.5.3a T9 — /history list smoke tests.
 *
 * Mirrors src/routes/refund/__tests__/detail.test.tsx: useQuery is mocked by
 * Convex FunctionReference name (stable across React 19 strict re-renders),
 * with mockSessionReturn + mockRowsReturn driving the rendered states.
 */

const FAKE_SESSION_ID = "session_abc";

const DEFAULT_ROW = {
  _id: "txn_1",
  created_at: Date.now(),
  total: 75_000,
  subtotal: 75_000,
  voucher_discount: 0,
  staff_id: "staff_1",
  staff_name: "Andi",
  instrument: "qris" as const,
  flags: 0,
  lines: [
    {
      product_code_snapshot: "DUB-8",
      product_name_snapshot: "Dubai Chocolate 8pcs",
      qty: 1,
      refunded_qty: 0,
    },
  ],
  refundsTotal: 0,
  hasRefunds: false,
  refundStatus: "none" as const,
};

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Andi", role: "staff" },
};
let mockRowsReturn: unknown = undefined;

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
      if (name.includes("listDayTransactions")) return mockRowsReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
  };
});

import HistoryIndex from "../index";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/history"]}>
        <Routes>
          <Route path="/history" element={<HistoryIndex />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("HistoryIndex route (/history)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    mockRowsReturn = undefined;
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders the skeleton while listDayTransactions is pending", () => {
    mockRowsReturn = undefined;
    renderRoute();
    expect(screen.getByTestId("history-skeleton")).toBeInTheDocument();
  });

  it("renders the empty state when the list is empty (staff/today)", () => {
    mockRowsReturn = [];
    renderRoute();
    const empty = screen.getByTestId("history-empty");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toContain("Belum ada transaksi hari ini");
  });

  it("renders rows when the list has entries", () => {
    mockRowsReturn = [DEFAULT_ROW];
    renderRoute();
    expect(screen.getByTestId("history-list")).toBeInTheDocument();
    // Total formatted as Rp (locale may inject NBSP — substring-check on the
    // digits is the robust signal).
    expect(screen.getByText(/75\.000/)).toBeInTheDocument();
    // Instrument badge.
    expect(screen.getByText("QRIS")).toBeInTheDocument();
    // Refund status badge (no refunds → LUNAS).
    expect(screen.getByText("LUNAS")).toBeInTheDocument();
  });

  it("hides the date picker for staff sessions", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    mockRowsReturn = [];
    renderRoute();
    expect(screen.queryByLabelText(/Tanggal/i)).toBeNull();
  });

  it("shows the date picker for manager sessions", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "mgr_1", name: "Lucy", role: "manager" },
    };
    mockRowsReturn = [];
    renderRoute();
    expect(screen.getByLabelText(/Tanggal/i)).toBeInTheDocument();
  });
});
