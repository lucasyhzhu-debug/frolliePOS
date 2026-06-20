import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * v0.5.3a T9 — /history/:txnId detail smoke tests.
 *
 * useQuery dispatch by FunctionReference name; useMutation is a configurable
 * stub so we can assert the shareReceipt call shape + the window.open side
 * effect on click.
 */

const FAKE_SESSION_ID = "session_abc";
const FAKE_TXN_ID = "txn_xyz";

const DEFAULT_TXN = {
  _id: FAKE_TXN_ID,
  _creationTime: 0,
  subtotal: 100_000,
  total: 100_000,
  voucher_discount: 0,
  status: "paid",
  paid_at: Date.now(),
  created_at: Date.now(),
  receipt_number: "R-0001",
  confirmed_via: "webhook" as const,
  flags: 0,
};

const DEFAULT_LINES = [
  {
    _id: "line_1",
    _creationTime: 0,
    transaction_id: FAKE_TXN_ID,
    product_id: "prod_1",
    product_code_snapshot: "DUB-8",
    product_name_snapshot: "Dubai Chocolate 8pcs",
    unit_price_snapshot: 50_000,
    tax_rate_snapshot: 0,
    qty: 2,
    line_subtotal: 100_000,
    refunded_qty: 0,
  },
];

const DEFAULT_DETAIL = {
  txn: DEFAULT_TXN,
  lines: DEFAULT_LINES,
  refundStatus: "none" as const,
};

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Andi", role: "staff" },
};
let mockDetailReturn: unknown = DEFAULT_DETAIL;
const mockShareReceipt = vi.fn();

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
      if (name.includes("getTransactionDetail")) return mockDetailReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: (mut: unknown) => {
      let name = "";
      try {
        name = getFunctionName(
          mut as Parameters<typeof getFunctionName>[0],
        );
      } catch {
        name = "";
      }
      if (name.includes("shareReceipt")) return mockShareReceipt;
      return vi.fn().mockResolvedValue({});
    },
  };
});

import HistoryDetail from "../$txnId";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={[`/history/${FAKE_TXN_ID}`]}>
        <Routes>
          <Route path="/history/:txnId" element={<HistoryDetail />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("HistoryDetail route (/history/:txnId)", () => {
  beforeAll(() => {
    vi.stubEnv("VITE_CONVEX_URL", "https://test.convex.cloud");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    mockDetailReturn = DEFAULT_DETAIL;
    mockShareReceipt.mockReset();
    mockShareReceipt.mockResolvedValue({ token: "tok_123" });
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders the detail when the query resolves", async () => {
    renderRoute();
    expect(
      await screen.findByTestId("history-receipt-number"),
    ).toHaveTextContent("R-0001");
    // Line product appears.
    expect(screen.getByText(/Dubai Chocolate 8pcs/)).toBeInTheDocument();
    // Total formatted (digits-only substring is robust against NBSP variants).
    expect(screen.getByTestId("history-total").textContent).toMatch(
      /100\.000/,
    );
    // No refunds → LUNAS badge.
    expect(screen.getByTestId("history-refund-status")).toHaveTextContent(
      "LUNAS",
    );
  });

  it("renders 'tidak ditemukan' when detail is null", () => {
    mockDetailReturn = null;
    renderRoute();
    expect(
      screen.getByText(/Transaction not found/i),
    ).toBeInTheDocument();
  });

  it("calls shareReceipt and opens /r/<token> in a new tab when the share button is clicked", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    renderRoute();
    const btn = await screen.findByTestId("history-share-receipt");
    fireEvent.click(btn);

    await waitFor(() => expect(mockShareReceipt).toHaveBeenCalledTimes(1));
    const call = mockShareReceipt.mock.calls[0][0];
    expect(call.sessionId).toBe(FAKE_SESSION_ID);
    expect(call.txnId).toBe(FAKE_TXN_ID);
    expect(typeof call.idempotencyKey).toBe("string");
    expect(call.idempotencyKey.length).toBeGreaterThan(0);

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        "https://test.convex.site/r/tok_123",
        "_blank",
      ),
    );

    openSpy.mockRestore();
  });
});
