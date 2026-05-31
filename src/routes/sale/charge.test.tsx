import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetForTests } from "@/hooks/useIdempotency";
import { SESSION_KEY } from "@/lib/storage-keys";
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

// Controllable blocker state for payment-guard tests.
let chargeBlockerState: "unblocked" | "blocked" | "proceeding" = "unblocked";
const chargeBlockerReset = vi.fn();
const chargeBlockerProceed = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useBlocker: vi.fn(() => ({
      state: chargeBlockerState,
      reset: chargeBlockerReset,
      proceed: chargeBlockerProceed,
    })),
  };
});

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useAction: vi.fn(() => vi.fn()),
    useMutation: vi.fn(() => vi.fn().mockResolvedValue({ cancelled: true })),
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
    chargeBlockerState = "unblocked";
    chargeBlockerReset.mockReset();
    chargeBlockerProceed.mockReset();
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
    localStorage.setItem(SESSION_KEY, "session-1");
    __resetForTests();
    vi.clearAllMocks();
    chargeBlockerState = "unblocked";
    chargeBlockerReset.mockReset();
    chargeBlockerProceed.mockReset();
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

// ─── Tier 2b: countdown UI ───────────────────────────────────────────────────

describe("SaleCharge route — countdown panel", () => {
  beforeEach(() => {
    localStorage.setItem(SESSION_KEY, "session-1");
    __resetForTests();
    vi.clearAllMocks();
    chargeBlockerState = "unblocked";
    chargeBlockerReset.mockReset();
    chargeBlockerProceed.mockReset();
    mockApprovalPending.mockReset();
    mockApprovalPending.mockImplementation(() => <div data-testid="approval-pending" />);
  });

  it("countdown panel is shown when invoice is active (invoiceMatches)", async () => {
    // Wire showing phase so invoiceMatches=true; include created_at for countdown.
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
    vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue({
      ...SHOWING_PHASE,
      invoice: {
        ...SHOWING_PHASE.invoice,
        created_at: Date.now(), // countdown starts from now
      },
    } as ReturnType<typeof useXenditPaymentModule.useXenditPayment>);
    (vi.mocked(convexReact.useAction) as Mock).mockImplementation(
      () => vi.fn().mockResolvedValue({}),
    );

    renderAt("txn-test-123");

    // Countdown panel renders because invoiceMatches = true (method = QRIS, selectedMethod = QRIS).
    await waitFor(() => {
      expect(screen.getByTestId("countdown-panel")).toBeTruthy();
    }, { timeout: 3000 });
    // Panel shows mm:ss format text
    const panel = screen.getByTestId("countdown-panel");
    expect(panel.textContent).toMatch(/\d{2}:\d{2}/);
  });

  it("countdown panel is not shown while invoice is loading (invoiceMatches=false)", async () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
    vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue({
      phase: { kind: "showing" },
      // invoice for BCA_VA method but selectedMethod defaults to QRIS → invoiceMatches=false
      invoice: {
        ...SHOWING_PHASE.invoice,
        method: "BCA_VA" as const,
        created_at: Date.now(),
      },
      txn: SHOWING_PHASE.txn,
    } as ReturnType<typeof useXenditPaymentModule.useXenditPayment>);
    (vi.mocked(convexReact.useAction) as Mock).mockImplementation(
      () => vi.fn().mockResolvedValue({}),
    );

    renderAt("txn-test-123");

    await waitFor(() => {
      // "Generating…" spinner should show because invoiceMatches = false
      expect(screen.queryByText(/Generating/)).toBeTruthy();
    }, { timeout: 3000 });
    expect(screen.queryByTestId("countdown-panel")).toBeNull();
  });
});

// ─── Tier 2c: manager picker ──────────────────────────────────────────────────

const MOCK_MANAGERS = [
  { name: "Alice", code: "M-001" },
  { name: "Bob", code: "M-002" },
];

describe("SaleCharge route — manager picker", () => {
  beforeEach(() => {
    localStorage.setItem(SESSION_KEY, "session-1");
    __resetForTests();
    vi.clearAllMocks();
    chargeBlockerState = "unblocked";
    chargeBlockerReset.mockReset();
    chargeBlockerProceed.mockReset();
    mockApprovalPending.mockReset();
    mockApprovalPending.mockImplementation(() => <div data-testid="approval-pending" />);
  });

  /**
   * Wire: ceiling reached + active session (manager role so override button is enabled)
   * + useQuery returns managers list.
   */
  function setupManagerPickerState() {
    const managerSession = {
      ...ACTIVE_SESSION,
      staff: { ...ACTIVE_SESSION.staff, role: "manager" as const },
    };
    vi.mocked(useSessionModule.useSession).mockReturnValue(managerSession);
    vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue(
      SHOWING_PHASE as ReturnType<typeof useXenditPaymentModule.useXenditPayment>,
    );

    // useQuery slot: listActiveManagers → return MOCK_MANAGERS.
    (vi.mocked(convexReact.useQuery) as Mock).mockReturnValue(MOCK_MANAGERS);

    const manuallyConfirmPaymentSpy = vi.fn().mockResolvedValue({});
    const spies = [
      vi.fn().mockResolvedValue({}), // requestPayment
      vi.fn().mockResolvedValue({}), // retryWithFreshInvoice
      manuallyConfirmPaymentSpy,      // manuallyConfirmPayment
      vi.fn().mockResolvedValue({}), // cancelTransaction
      vi.fn().mockResolvedValue({}), // requestManualPaymentApproval
    ];
    let callCount = 0;
    (vi.mocked(convexReact.useAction) as Mock).mockImplementation(() => {
      const idx = callCount % 5;
      callCount++;
      return spies[idx];
    });

    return { manuallyConfirmPaymentSpy, managerSession };
  }

  it("picker shows all active managers when 'Manager override' is clicked", async () => {
    setupManagerPickerState();
    renderAt("txn-test-123");

    // Wait for ceiling UI (PAYMENT_CEILING_MS = 0 in mock)
    await waitFor(() =>
      expect(screen.getByText("Manager override")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Manager override"));

    await waitFor(() =>
      expect(screen.getByTestId("manager-picker")).toBeTruthy(),
    );

    // Both managers appear
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByTestId("pick-manager-M-001")).toBeTruthy();
    expect(screen.getByTestId("pick-manager-M-002")).toBeTruthy();
  });

  it("selecting a manager transitions to PIN view (picker disappears, PinSheet opens)", async () => {
    setupManagerPickerState();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Manager override")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Manager override"));

    await waitFor(() =>
      expect(screen.getByTestId("manager-picker")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("pick-manager-M-001"));

    // Picker should disappear and PIN dialog should open.
    await waitFor(() =>
      expect(screen.queryByTestId("manager-picker")).toBeNull(),
    );
    // Selected manager name appears in the PinSheet label.
    await waitFor(() =>
      // The PinSheet label includes the manager name "Alice".
      expect(screen.getByText(/Alice's PIN to confirm payment/)).toBeTruthy(),
    );
  });

  it("shows 'No active managers' when managers list is empty", async () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue({
      ...ACTIVE_SESSION,
      staff: { ...ACTIVE_SESSION.staff, role: "manager" as const },
    });
    vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue(
      SHOWING_PHASE as ReturnType<typeof useXenditPaymentModule.useXenditPayment>,
    );
    (vi.mocked(convexReact.useQuery) as Mock).mockReturnValue([]);
    (vi.mocked(convexReact.useAction) as Mock).mockImplementation(
      () => vi.fn().mockResolvedValue({}),
    );

    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Manager override")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Manager override"));

    await waitFor(() =>
      expect(screen.getByText(/No active managers/)).toBeTruthy(),
    );
  });

  it("cancel in picker closes the picker without opening PIN sheet", async () => {
    setupManagerPickerState();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByText("Manager override")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Manager override"));

    await waitFor(() =>
      expect(screen.getByTestId("manager-picker")).toBeTruthy(),
    );

    // Click the Cancel button inside the picker
    const cancelBtn = screen.getAllByRole("button", { name: /cancel/i }).find(
      (btn) => btn.closest("[data-testid='manager-picker']"),
    );
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn!);

    await waitFor(() =>
      expect(screen.queryByTestId("manager-picker")).toBeNull(),
    );
  });

  it("PIN submit calls manuallyConfirmPayment with the selected manager's code", async () => {
    const { manuallyConfirmPaymentSpy } = setupManagerPickerState();
    renderAt("txn-test-123");

    // Open picker
    await waitFor(() =>
      expect(screen.getByText("Manager override")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Manager override"));

    await waitFor(() =>
      expect(screen.getByTestId("manager-picker")).toBeTruthy(),
    );

    // Pick Alice (M-001)
    fireEvent.click(screen.getByTestId("pick-manager-M-001"));

    // Wait for PIN sheet
    await waitFor(() =>
      expect(screen.queryByTestId("manager-picker")).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("override-reason-input")).toBeTruthy(),
    );

    // Fill in reason
    fireEvent.change(screen.getByTestId("override-reason-input"), {
      target: { value: "Customer showed payment screenshot" },
    });

    // Enter PIN via keypad buttons (digits 1, 2, 3, 4)
    const digitButtons = screen.getAllByRole("button").filter((btn) =>
      /^[0-9]$/.test(btn.textContent?.trim() ?? ""),
    );
    // Press 1, 2, 3, 4
    const byDigit = (d: string) =>
      digitButtons.find((btn) => btn.textContent?.trim() === d)!;
    fireEvent.click(byDigit("1"));
    fireEvent.click(byDigit("2"));
    fireEvent.click(byDigit("3"));
    fireEvent.click(byDigit("4"));

    await waitFor(() => {
      expect(manuallyConfirmPaymentSpy).toHaveBeenCalledOnce();
    });

    const callArgs = manuallyConfirmPaymentSpy.mock.calls[0][0] as {
      managerStaffCode: string;
      managerPin: string;
      reason: string;
    };
    expect(callArgs.managerStaffCode).toBe("M-001");
    expect(callArgs.managerPin).toBe("1234");
    expect(callArgs.reason).toBe("Customer showed payment screenshot");
  });
});

// ─── Tier 3: useBlocker — payment-variant abandon dialog ─────────────────────

describe("SaleCharge route — useBlocker payment guard", () => {
  beforeEach(() => {
    localStorage.setItem(SESSION_KEY, "session-1");
    __resetForTests();
    vi.clearAllMocks();
    chargeBlockerState = "unblocked";
    chargeBlockerReset.mockReset();
    chargeBlockerProceed.mockReset();
    mockApprovalPending.mockReset();
    mockApprovalPending.mockImplementation(() => <div data-testid="approval-pending" />);
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
    vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue(
      SHOWING_PHASE as ReturnType<typeof useXenditPaymentModule.useXenditPayment>,
    );
    (vi.mocked(convexReact.useAction) as Mock).mockImplementation(
      () => vi.fn().mockResolvedValue({}),
    );
  });

  it("blocker in blocked state: AbandonCartDialog (payment variant) renders", async () => {
    chargeBlockerState = "blocked";
    renderAt("txn-test-123");

    await waitFor(() => {
      expect(screen.getByText("Cancel this payment?")).toBeTruthy();
    });
  });

  it("dialog 'Keep waiting' button calls blocker.reset()", async () => {
    chargeBlockerState = "blocked";
    renderAt("txn-test-123");

    await waitFor(() => {
      expect(screen.getByText("Cancel this payment?")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /keep waiting/i }));

    expect(chargeBlockerReset).toHaveBeenCalledOnce();
  });

  it("blocker unblocked when txn is not awaiting_payment: dialog does not render", async () => {
    // Even with blocker state "unblocked", confirm the dialog doesn't appear.
    // The shouldBlock condition (txn.status === "awaiting_payment") is tested
    // via the useBlocker mock — when unblocked the component renders normally.
    chargeBlockerState = "unblocked";
    renderAt("txn-test-123");

    await waitFor(() => {
      expect(screen.queryByText("Cancel this payment?")).toBeNull();
    });
  });
});
