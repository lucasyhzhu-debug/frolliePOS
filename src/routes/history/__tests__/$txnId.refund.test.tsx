import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

const FAKE_SESSION_ID = "session_abc";
const FAKE_TXN_ID = "txn_xyz";

type RefundStatus = "none" | "partial" | "full";

function makeDetail(opts: { status?: string; refundStatus?: RefundStatus } = {}) {
  return {
    txn: {
      _id: FAKE_TXN_ID,
      _creationTime: 0,
      subtotal: 100_000,
      total: 100_000,
      voucher_discount: 0,
      status: opts.status ?? "paid",
      paid_at: Date.now(),
      created_at: Date.now(),
      receipt_number: "R-0001",
      confirmed_via: "webhook",
      flags: 0,
    },
    lines: [
      {
        _id: "line_1",
        _creationTime: 0,
        transaction_id: FAKE_TXN_ID,
        product_id: "p1",
        product_code_snapshot: "DUB-8",
        product_name_snapshot: "Dubai 8pcs",
        unit_price_snapshot: 50_000,
        tax_rate_snapshot: 0,
        qty: 2,
        line_subtotal: 100_000,
        refunded_qty: 0,
      },
    ],
    refundStatus: opts.refundStatus ?? "none",
  };
}

const PRINT_VM = { viewModel: { foo: "bar" }, status: "paid", statusLabel: "LUNAS" };

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "s1", name: "Andi", role: "staff" },
};
let mockDetail: ReturnType<typeof makeDetail> = makeDetail();
const mockNavigate = vi.fn();

// Stub PrinterProvider to deterministic 'unsupported' so the Task 3 print
// button stays disabled / out of the way for this test.
vi.mock("@/components/pos/PrinterProvider", () => ({
  usePrinter: () => ({
    status: "unsupported",
    connect: vi.fn(),
    print: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(query as Parameters<typeof getFunctionName>[0]);
      } catch {
        name = "";
      }
      if (name.includes("getTransactionDetail")) return mockDetail;
      if (name.includes("getReceiptForPrint")) return PRINT_VM;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({ token: "t" }),
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

describe("HistoryDetail refund button (Part D)", () => {
  beforeAll(() => {
    vi.stubEnv("VITE_CONVEX_URL", "https://test.convex.cloud");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    localStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "s1", name: "Andi", role: "staff" },
    };
    mockNavigate.mockReset();
    mockDetail = makeDetail();
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("paid + refundStatus=none: shows refund button; click navigates to /refund/:txnId", async () => {
    mockDetail = makeDetail({ status: "paid", refundStatus: "none" });
    renderRoute();
    const btn = await screen.findByTestId("history-refund");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(`/refund/${FAKE_TXN_ID}`),
    );
  });

  it("paid + refundStatus=partial: refund button still visible", async () => {
    mockDetail = makeDetail({ status: "paid", refundStatus: "partial" });
    renderRoute();
    expect(await screen.findByTestId("history-refund")).toBeInTheDocument();
  });

  it("paid + refundStatus=full: refund button hidden", async () => {
    mockDetail = makeDetail({ status: "paid", refundStatus: "full" });
    renderRoute();
    // Wait for detail render
    await screen.findByTestId("history-receipt-number");
    expect(screen.queryByTestId("history-refund")).toBeNull();
  });

  it("awaiting_payment: refund button hidden", async () => {
    mockDetail = makeDetail({ status: "awaiting_payment", refundStatus: "none" });
    renderRoute();
    await screen.findByTestId("history-receipt-number");
    expect(screen.queryByTestId("history-refund")).toBeNull();
  });
});
