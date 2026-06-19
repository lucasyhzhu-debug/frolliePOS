import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

const FAKE_SESSION_ID = "session_abc";
const FAKE_TXN_ID = "txn_xyz";

const DEFAULT_DETAIL = {
  txn: {
    _id: FAKE_TXN_ID, _creationTime: 0, subtotal: 100_000, total: 100_000,
    voucher_discount: 0, status: "paid", paid_at: Date.now(), created_at: Date.now(),
    receipt_number: "R-0001", confirmed_via: "webhook", flags: 0,
  },
  lines: [{
    _id: "line_1", _creationTime: 0, transaction_id: FAKE_TXN_ID, product_id: "p1",
    product_code_snapshot: "DUB-8", product_name_snapshot: "Dubai 8pcs",
    unit_price_snapshot: 50_000, tax_rate_snapshot: 0, qty: 2, line_subtotal: 100_000, refunded_qty: 0,
  }],
  refundStatus: "none" as const,
};

const PRINT_VM = { viewModel: { foo: "bar" }, status: "paid", statusLabel: "LUNAS" };

let mockSessionReturn: unknown = { sessionId: FAKE_SESSION_ID, staff: { _id: "s1", name: "Andi", role: "staff" } };
const mockPrint = vi.fn();
let mockPrinterStatus = "connected";
const mockConnect = vi.fn();
const mockEncode = vi.fn(() => new Uint8Array([1, 2, 3]));

vi.mock("@/components/pos/PrinterProvider", () => ({
  usePrinter: () => ({ status: mockPrinterStatus, connect: mockConnect, print: mockPrint, disconnect: vi.fn() }),
}));
vi.mock("@/lib/escpos", () => ({ encodeReceipt: (...a: unknown[]) => mockEncode(...a) }));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try { name = getFunctionName(query as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("getTransactionDetail")) return DEFAULT_DETAIL;
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
        <Routes><Route path="/history/:txnId" element={<HistoryDetail />} /></Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("HistoryDetail print button (Part C)", () => {
  beforeAll(() => { vi.stubEnv("VITE_CONVEX_URL", "https://test.convex.cloud"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    localStorage.clear();
    mockSessionReturn = { sessionId: FAKE_SESSION_ID, staff: { _id: "s1", name: "Andi", role: "staff" } };
    mockPrint.mockReset(); mockPrint.mockResolvedValue(undefined);
    mockConnect.mockReset(); mockEncode.mockClear();
    mockPrinterStatus = "connected";
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("connected: clicking print encodes the getReceiptForPrint view-model and prints", async () => {
    renderRoute();
    fireEvent.click(await screen.findByTestId("history-print"));
    await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(1));
    expect(mockEncode).toHaveBeenCalledWith(PRINT_VM.viewModel, PRINT_VM.status, PRINT_VM.statusLabel);
    expect(mockPrint).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("disconnected: button label invites connect and calls connect()", async () => {
    mockPrinterStatus = "disconnected";
    renderRoute();
    fireEvent.click(await screen.findByTestId("history-print"));
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockPrint).not.toHaveBeenCalled();
  });
});
