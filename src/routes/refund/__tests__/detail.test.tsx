import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";
import { __resetForTests } from "@/hooks/useIdempotency";

/**
 * B23 — /refund/[txnId] form smoke tests. Three behaviours:
 *   1. Stepper caps at refundable (RefundLineSelector inc-clamp via useRefund).
 *   2. Reason validation gates both submit buttons (canSubmit drives disabled).
 *   3. Both submit paths render and become enabled when canSubmit is true.
 *
 * useQuery dispatch is by ARGS SHAPE rather than slot order — slot order is
 * fragile under React 19 strict-mode re-renders. The three calls have distinct
 * arg signatures:
 *   - useSession's getSession: { sessionId }
 *   - listForTransaction:      { sessionId, transactionId }
 *   - listActiveManagers:      { sessionId }                (same shape as
 *     getSession but only fires from inside the route → narrowed via a "have
 *     we seen transactionId yet" flag so listForTransaction sets it, then any
 *     subsequent { sessionId }-only call routes to managers.)
 *
 * useAction is a no-op stub — tests 1 & 2 don't trigger submits; test 3 only
 * checks both buttons are enabled.
 */

const FAKE_SESSION_ID = "session_abc";
const FAKE_TXN_ID = "txn_xyz";

const DEFAULT_LINE = {
  _id: "line_1",
  _creationTime: 0,
  transaction_id: FAKE_TXN_ID,
  product_id: "prod_1",
  product_code_snapshot: "DUB-8",
  product_name_snapshot: "Dubai Chocolate 8pcs",
  unit_price_snapshot: 50_000,
  tax_rate_snapshot: 0,
  qty: 3,
  line_subtotal: 150_000,
  refunded_qty: 1,
  refundable: 2,
};

const DEFAULT_TXN = {
  _id: FAKE_TXN_ID,
  _creationTime: 0,
  total: 150_000,
  status: "paid",
  paid_at: Date.now(),
  created_at: Date.now(),
  receipt_number: "R-0001",
};

const DEFAULT_LIST = {
  txn: DEFAULT_TXN,
  lines: [DEFAULT_LINE],
  refunds: [],
};

const DEFAULT_MANAGERS = [
  { name: "Lucy", code: "MGR01" },
  { name: "Marco", code: "MGR02" },
];

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Andi", role: "staff" },
};
let mockListReturn: unknown = DEFAULT_LIST;
let mockManagersReturn: unknown = DEFAULT_MANAGERS;

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      // Dispatch by FunctionReference name — stable across re-renders and
      // unambiguous even when two queries share the { sessionId }-only arg
      // shape (auth.public.getSession + staff.public.listActiveManagers).
      let name = "";
      try {
        name = getFunctionName(
          query as Parameters<typeof getFunctionName>[0],
        );
      } catch {
        name = "";
      }
      if (name.includes("listForTransaction")) return mockListReturn;
      if (name.includes("listActiveManagers")) return mockManagersReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

import RefundDetail from "../detail";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={[`/refund/${FAKE_TXN_ID}`]}>
        <Routes>
          <Route path="/refund/:txnId" element={<RefundDetail />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("RefundDetail route (/refund/:txnId)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetForTests();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    mockListReturn = { ...DEFAULT_LIST, lines: [{ ...DEFAULT_LINE }] };
    mockManagersReturn = DEFAULT_MANAGERS;
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("caps the stepper at refundable", async () => {
    renderRoute();
    // The line input lands once data resolves.
    const input = await screen.findByLabelText(
      /Refund quantity for Dubai Chocolate 8pcs/i,
    );
    const incBtn = screen.getByRole("button", { name: /Increase quantity/i });
    // Tap inc three times on a line with refundable=2 — the third tap is a
    // no-op (button disables at the cap; useRefund's setQty is upper-bounded
    // by RefundLineSelector via Math.min(refundable, value + 1)).
    fireEvent.click(incBtn);
    fireEvent.click(incBtn);
    fireEvent.click(incBtn);
    expect((input as HTMLInputElement).value).toBe("2");
  });

  it("disables both submit buttons until reason + qty are set", async () => {
    renderRoute();
    await screen.findByLabelText(
      /Refund quantity for Dubai Chocolate 8pcs/i,
    );

    const inlineBtn = screen.getByTestId("refund-submit-inline");
    const tgBtn = screen.getByTestId("refund-submit-telegram");

    // Select 1 unit but leave reason blank → both still disabled (canSubmit
    // requires reason.trim().length > 0).
    fireEvent.click(screen.getByRole("button", { name: /Increase quantity/i }));
    expect(inlineBtn).toBeDisabled();
    expect(tgBtn).toBeDisabled();

    // Type a reason → both enabled once useIdempotency keys resolve.
    fireEvent.change(screen.getByTestId("refund-reason"), {
      target: { value: "customer changed mind" },
    });
    await waitFor(() => expect(inlineBtn).not.toBeDisabled());
    expect(tgBtn).not.toBeDisabled();
  });

  it("renders both submit paths when canSubmit", async () => {
    renderRoute();
    await screen.findByLabelText(
      /Refund quantity for Dubai Chocolate 8pcs/i,
    );

    fireEvent.click(screen.getByRole("button", { name: /Increase quantity/i }));
    fireEvent.change(screen.getByTestId("refund-reason"), {
      target: { value: "wrong item" },
    });

    const inlineBtn = await screen.findByTestId("refund-submit-inline");
    const tgBtn = screen.getByTestId("refund-submit-telegram");
    expect(inlineBtn).toBeInTheDocument();
    expect(tgBtn).toBeInTheDocument();
    await waitFor(() => expect(inlineBtn).not.toBeDisabled());
    expect(tgBtn).not.toBeDisabled();
  });
});
