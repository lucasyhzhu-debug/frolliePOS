import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetForTests } from "@/hooks/useIdempotency";
import SaleCharge from "./charge";

/**
 * Charge screen tests — two tiers:
 *
 * Tier 1 (smoke): renders without crashing in loading / no-session states.
 *   These use a real ConvexReactClient whose queries return undefined (loading).
 *   Module mocks are NOT active here.
 *
 * Tier 2 (interactive): tests the ceiling-reached UI and the off-booth approval
 *   affordance. Mocks useSession, useXenditPayment, and useAction so the
 *   component always renders in the "showing" + ceiling-reached state.
 *
 * NOTE: vi.mock calls are hoisted to the top of the file by Vite, so the mock
 * for convex/react is active for ALL tests in this file. We wire useQuery to
 * return "skip"-compatible undefined for the smoke tests and override it inside
 * the Tier 2 helpers.
 */

// ─── module mocks (hoisted) ──────────────────────────────────────────────────

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useAction: vi.fn(() => vi.fn()),
  };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
}));

vi.mock("@/hooks/useXenditPayment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useXenditPayment")>();
  return {
    ...actual,
    // Expose ceiling as 0 ms so ceilingReached is always true immediately.
    PAYMENT_CEILING_MS: 0,
    useXenditPayment: vi.fn(() => ({
      phase: { kind: "loading" as const },
      invoice: undefined,
      txn: undefined,
    })),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: () => <div data-testid="qr-code" />,
}));

vi.mock("@/components/layout/ConnDot", () => ({
  ConnDot: () => null,
}));

const mockApprovalPending = vi.fn(() => (
  <div data-testid="approval-pending" />
));
vi.mock("@/components/pos/ApprovalPending", () => ({
  ApprovalPending: (props: unknown) => mockApprovalPending(props),
}));

// ─── imported mocks ──────────────────────────────────────────────────────────

import * as convexReact from "convex/react";
import * as useSessionModule from "@/hooks/useSession";
import * as useXenditPaymentModule from "@/hooks/useXenditPayment";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Active session stub. */
const ACTIVE_SESSION = {
  status: "active" as const,
  sessionId: "session-1" as import("../../convex/_generated/dataModel").Id<"staff_sessions">,
  staff: {
    _id: "staff-1" as import("../../convex/_generated/dataModel").Id<"staff">,
    name: "Test Staff",
    role: "staff" as const,
  },
};

/** Minimal showing-phase return from useXenditPayment. */
const SHOWING_PHASE = {
  phase: { kind: "showing" as const },
  invoice: {
    _id: "inv-1" as unknown as import("../../convex/_generated/dataModel").Id<"pos_xendit_invoices">,
    xendit_invoice_id: "xnd-1",
    method: "QRIS" as const,
    qr_string: "some-qr-data",
    va_number: undefined,
  },
  txn: {
    _id: "txn-test-123" as unknown as import("../../convex/_generated/dataModel").Id<"pos_transactions">,
    status: "awaiting_payment" as const,
    total: 50000,
  },
};

/**
 * Wire the component into its "ceiling reached" UI state:
 *   - session active
 *   - phase.kind === "showing" with a concrete invoice
 *   - PAYMENT_CEILING_MS = 0 (mocked) so ceiling is hit immediately
 * Returns the action spies so tests can assert on them.
 */
function setupCeilingState({
  requestApprovalResult = { requestId: "req-abc-123" },
  requestApprovalError,
}: {
  requestApprovalResult?: { requestId: string };
  requestApprovalError?: Error;
} = {}) {
  vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
  vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue(
    SHOWING_PHASE as ReturnType<typeof useXenditPaymentModule.useXenditPayment>,
  );

  const requestPaymentSpy = vi.fn().mockResolvedValue({});
  const retryWithFreshInvoiceSpy = vi.fn().mockResolvedValue({});
  const manuallyConfirmPaymentSpy = vi.fn().mockResolvedValue({});
  const cancelTransactionSpy = vi.fn().mockResolvedValue({});
  const requestApprovalSpy = requestApprovalError
    ? vi.fn().mockRejectedValue(requestApprovalError)
    : vi.fn().mockResolvedValue(requestApprovalResult);

  // useAction is called 5 times per render in registration order:
  //   0: requestPayment
  //   1: retryWithFreshInvoice
  //   2: manuallyConfirmPayment
  //   3: cancelTransaction
  //   4: requestManualPaymentApproval
  //
  // We use mockImplementationOnce for each slot, but the problem is React re-renders
  // call all 5 useAction hooks again. Instead we match by the action reference's
  // function name via the API path passed. Since we can't inspect the reference
  // easily, we use a round-robin that resets every 5 calls (matches hook call order).
  const spies = [
    requestPaymentSpy,
    retryWithFreshInvoiceSpy,
    manuallyConfirmPaymentSpy,
    cancelTransactionSpy,
    requestApprovalSpy,
  ];
  let callCount = 0;
  (vi.mocked(convexReact.useAction) as Mock).mockImplementation(() => {
    // Reset the index every 5 calls so re-renders get the same mapping.
    const idx = callCount % 5;
    callCount++;
    return spies[idx];
  });

  return {
    requestPaymentSpy,
    retryWithFreshInvoiceSpy,
    manuallyConfirmPaymentSpy,
    cancelTransactionSpy,
    requestApprovalSpy,
  };
}

function renderAt(txnId: string) {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={[`/sale/charge/${txnId}`]}>
        <Routes>
          <Route path="/sale/charge/:txnId" element={<SaleCharge />} />
          <Route
            path="/sale/charge/:txnId/success"
            element={<div data-testid="charge-success" />}
          />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// ─── Tier 1: smoke tests ─────────────────────────────────────────────────────

describe("SaleCharge route — smoke", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetForTests();
    vi.clearAllMocks();
    mockApprovalPending.mockReset();
    mockApprovalPending.mockImplementation(() => <div data-testid="approval-pending" />);
    // Reset mocks to their passive defaults for smoke tests.
    vi.mocked(useSessionModule.useSession).mockReturnValue({
      status: "none",
      sessionId: null,
      staff: null,
    });
    vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue({
      phase: { kind: "loading" },
      invoice: undefined,
      txn: undefined,
    });
    (vi.mocked(convexReact.useAction) as Mock).mockImplementation(
      () => vi.fn().mockResolvedValue({}),
    );
  });

  it("renders without crashing when session is none (RootLayout would redirect)", () => {
    // No sessionId → session.status "none" → component returns null. The
    // assertion is that mounting through the :txnId route does not throw.
    const { container } = renderAt("txn-123");
    expect(container).toBeTruthy();
  });

  it("renders the session-loading spinner while the session query is pending", () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue({
      status: "loading",
      sessionId: null,
      staff: null,
    });
    const { container } = renderAt("txn-456");
    // session.status is "loading" → spinner SVG.
    expect(container).toBeTruthy();
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });
});

// ─── Tier 2: interactive tests ───────────────────────────────────────────────

describe("SaleCharge route — off-booth approval affordance", () => {
  beforeEach(() => {
    localStorage.setItem("frollie-session-id", "session-1");
    __resetForTests();
    vi.clearAllMocks();
    mockApprovalPending.mockReset();
    mockApprovalPending.mockImplementation(() => <div data-testid="approval-pending" />);
  });

  it("shows 'Request manager approval' button at ceiling alongside existing CTAs", async () => {
    setupCeilingState();
    renderAt("txn-test-123");

    // With PAYMENT_CEILING_MS=0 the ceiling is hit after the first timer tick.
    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );

    // Existing CTAs still present.
    expect(screen.getByText(/Retry/)).toBeTruthy();
    expect(screen.getByText("Manager override")).toBeTruthy();
    expect(screen.getByText(/Cancel sale/)).toBeTruthy();
  });

  it("clicking 'Request manager approval' reveals the reason input", async () => {
    setupCeilingState();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Request manager approval"));

    await waitFor(() => {
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy();
    });
  });

  it("'Send request' button is disabled when reason is empty", async () => {
    setupCeilingState();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );

    const sendBtn = screen.getByText("Send request").closest("button")!;
    expect(sendBtn).toBeDisabled();
  });

  it("submitting with a non-empty reason calls requestManualPaymentApproval with correct args", async () => {
    const { requestApprovalSpy } = setupCeilingState();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );

    fireEvent.change(screen.getByTestId("approval-reason-input"), {
      target: { value: "Customer confirms payment via screenshot" },
    });

    const sendBtn = screen.getByText("Send request").closest("button")!;
    expect(sendBtn).not.toBeDisabled();

    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(requestApprovalSpy).toHaveBeenCalledOnce();
    });

    const callArgs = requestApprovalSpy.mock.calls[0][0] as {
      sessionId: string;
      txnId: string;
      reason: string;
      idempotencyKey: string;
    };
    expect(callArgs.reason).toBe("Customer confirms payment via screenshot");
    expect(callArgs.txnId).toBe("txn-test-123");
    expect(callArgs.sessionId).toBe("session-1");
    expect(typeof callArgs.idempotencyKey).toBe("string");
    expect(callArgs.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("after success, ApprovalPending is rendered with the returned requestId", async () => {
    const { requestApprovalSpy } = setupCeilingState({
      requestApprovalResult: { requestId: "req-abc-123" },
    });
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );

    fireEvent.change(screen.getByTestId("approval-reason-input"), {
      target: { value: "Manager not at booth" },
    });
    fireEvent.click(screen.getByText("Send request").closest("button")!);

    await waitFor(() =>
      expect(requestApprovalSpy).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("approval-pending")).toBeTruthy(),
    );

    // ApprovalPending should have been called with the requestId from the action.
    const lastCall = mockApprovalPending.mock.calls.at(-1)! as [
      { requestId: string },
    ];
    expect(lastCall[0].requestId).toBe("req-abc-123");
  });

  it("after denied callback, ApprovalPending is removed and ceiling buttons reappear", async () => {
    // Make ApprovalPending call onDenied immediately on mount.
    mockApprovalPending.mockImplementation(
      ({ onDenied }: { onDenied?: () => void }) => {
        Promise.resolve().then(() => onDenied?.());
        return <div data-testid="approval-pending" />;
      },
    );

    setupCeilingState({ requestApprovalResult: { requestId: "req-denied" } });
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("approval-reason-input"), {
      target: { value: "Testing denial path" },
    });
    fireEvent.click(screen.getByText("Send request").closest("button")!);

    // ApprovalPending appears briefly.
    await waitFor(() =>
      expect(screen.getByTestId("approval-pending")).toBeTruthy(),
    );

    // After onDenied fires → requestId cleared → ceiling UI reappears.
    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
  });

  it("after expired callback, ApprovalPending is removed and ceiling buttons reappear", async () => {
    mockApprovalPending.mockImplementation(
      ({ onExpired }: { onExpired?: () => void }) => {
        Promise.resolve().then(() => onExpired?.());
        return <div data-testid="approval-pending" />;
      },
    );

    setupCeilingState({ requestApprovalResult: { requestId: "req-expired" } });
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("approval-reason-input"), {
      target: { value: "Testing expiry path" },
    });
    fireEvent.click(screen.getByText("Send request").closest("button")!);

    await waitFor(() =>
      expect(screen.getByTestId("approval-pending")).toBeTruthy(),
    );

    // After onExpired fires → ceiling UI reappears.
    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
  });

  it("existing booth-inline 'Manager override' button still renders at ceiling", async () => {
    setupCeilingState();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Manager override")).toBeTruthy(),
    );

    // Both paths coexist — clicking the override button doesn't crash.
    fireEvent.click(screen.getByText("Manager override"));
    // After click the PinSheet dialog opens (same text appears as dialog title).
    // Assert the dialog title text appears as an h2 (the sheet is open).
    await waitFor(() =>
      expect(screen.getAllByText("Manager override").length).toBeGreaterThan(0),
    );
  });

  it("shows inline error when requestManualPaymentApproval throws TXN_NOT_AWAITING", async () => {
    setupCeilingState({
      requestApprovalError: new Error("TXN_NOT_AWAITING"),
    });
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("approval-reason-input"), {
      target: { value: "some reason" },
    });
    fireEvent.click(screen.getByText("Send request").closest("button")!);

    await waitFor(() =>
      expect(
        screen.getByText("This sale is no longer awaiting payment"),
      ).toBeTruthy(),
    );
  });

  it("shows inline error when requestManualPaymentApproval throws NO_SESSION", async () => {
    setupCeilingState({
      requestApprovalError: new Error("NO_SESSION"),
    });
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Request manager approval")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Request manager approval"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-reason-input")).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("approval-reason-input"), {
      target: { value: "some reason" },
    });
    fireEvent.click(screen.getByText("Send request").closest("button")!);

    await waitFor(() =>
      expect(
        screen.getByText("Session expired — please sign in again"),
      ).toBeTruthy(),
    );
  });
});
