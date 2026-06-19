import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";
import SaleCharge from "../charge";

// Radix Tabs trigger relies on Pointer Events APIs that jsdom doesn't implement.
// Without these stubs userEvent.click on a <TabsTrigger> never fires
// onValueChange, so the tab never switches (the manual branch stays unmounted).
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}

/**
 * Charge screen — manual bank-transfer tender (v1.2 #10 Task 8).
 *
 * Verifies the MANUAL_BCA tab renders independently of the invoice-driven
 * `phase` machine (C1): the manual tab never mints an invoice, so `phase.kind`
 * is stuck on "loading" — the manual UI must render BEFORE that switch.
 *
 * Trap handled: `useIdempotency` resolves `undefined` for a paint cycle under
 * jsdom; here it's mocked to a stable string so `handleManualConfirm`'s
 * `!manualConfirmKey` guard never silently disables the confirm button.
 */

// ─── module mocks (hoisted) ──────────────────────────────────────────────────

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    // No path-change blocker interference for these tests.
    useBlocker: vi.fn(() => ({ state: "unblocked", reset: vi.fn(), proceed: vi.fn() })),
  };
});

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useAction: vi.fn(() => vi.fn()),
    useMutation: vi.fn(() => vi.fn().mockResolvedValue({})),
  };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
}));

vi.mock("@/hooks/useXenditPayment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useXenditPayment")>();
  return {
    ...actual,
    PAYMENT_CEILING_MS: 0,
    useXenditPayment: vi.fn(() => ({
      phase: { kind: "loading" as const },
      invoice: undefined,
      txn: undefined,
    })),
  };
});

// CRITICAL: mock useIdempotency to a STABLE string. Under jsdom the real hook
// resolves `undefined` for a render cycle, which makes handleManualConfirm
// early-return (the `!manualConfirmKey` guard) and silently disables the
// confirm button → false green. (#12 exec trap.)
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "confirm-manual:txn-test-123:stub-key"),
  __resetForTests: vi.fn(),
  clearIntent: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: () => <div data-testid="qr-code" />,
}));

vi.mock("@/hooks/useIsOnline", () => ({
  useIsOnline: vi.fn(() => true),
}));

vi.mock("@/components/pos/ApprovalPending", () => ({
  ApprovalPending: () => <div data-testid="approval-pending" />,
}));

// ─── imported mocks ──────────────────────────────────────────────────────────

import * as convexReact from "convex/react";
import * as useSessionModule from "@/hooks/useSession";
import * as useXenditPaymentModule from "@/hooks/useXenditPayment";
import { useIsOnline } from "@/hooks/useIsOnline";

type IdT<T extends string> = import("../../../convex/_generated/dataModel").Id<T>;

const ACTIVE_SESSION = {
  status: "active" as const,
  sessionId: "session-1" as IdT<"staff_sessions">,
  staff: {
    _id: "staff-1" as IdT<"staff">,
    name: "Test Staff",
    role: "staff" as const,
  },
};

const MANUAL_BCA_ENABLED = {
  enabled: true,
  bank_name: "BCA",
  account_name: "PT Frollie",
  account_number: "1234567890",
};

// useXenditPayment returns loading (no invoice) — the manual tab never creates
// one. txn carries the total so the AMOUNT DUE block renders.
const NO_INVOICE_PHASE = {
  phase: { kind: "loading" as const },
  invoice: undefined,
  txn: {
    _id: "txn-test-123" as IdT<"pos_transactions">,
    status: "awaiting_payment" as const,
    total: 50000,
  },
};

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

/**
 * Wire: active session + manual-BCA enabled + select the MANUAL_BCA tab.
 * Returns the confirm mutation spy.
 */
function setupManualTab(confirmImpl?: Mock) {
  vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
  vi.mocked(useXenditPaymentModule.useXenditPayment).mockReturnValue(
    NO_INVOICE_PHASE as ReturnType<typeof useXenditPaymentModule.useXenditPayment>,
  );
  // getManualBcaAccount is the only useQuery in args-resolving state (listActiveManagers
  // is "skip" until override opens), so returning the enabled config is sufficient.
  (vi.mocked(convexReact.useQuery) as Mock).mockReturnValue(MANUAL_BCA_ENABLED);

  const confirmSpy = confirmImpl ?? vi.fn().mockResolvedValue({ ok: true });
  (vi.mocked(convexReact.useMutation) as Mock).mockReturnValue(confirmSpy);
  (vi.mocked(convexReact.useAction) as Mock).mockImplementation(() =>
    vi.fn().mockResolvedValue({}),
  );
  return { confirmSpy };
}

describe("SaleCharge — manual bank-transfer tender", () => {
  beforeEach(() => {
    localStorage.setItem(SESSION_KEY, "session-1");
    vi.clearAllMocks();
    vi.mocked(useIsOnline).mockReturnValue(true);
  });

  it("shows the 'Bank transfer' tab only when manual BCA is enabled", async () => {
    setupManualTab();
    renderAt("txn-test-123");

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Bank transfer" })).toBeTruthy(),
    );
    // QRIS tab is always present.
    expect(screen.getByRole("tab", { name: "QRIS" })).toBeTruthy();
  });

  it("manual tab renders the account (not the 'Preparing payment…' spinner)", async () => {
    const user = userEvent.setup();
    setupManualTab();
    renderAt("txn-test-123");

    // Select the manual tab.
    await user.click(await screen.findByRole("tab", { name: "Bank transfer" }));

    // C1: the manual UI renders despite phase.kind === "loading".
    await waitFor(() => {
      expect(screen.getByText("1234567890")).toBeTruthy();
    });
    expect(screen.getByText(/BCA/)).toBeTruthy();
    expect(screen.getByText(/PT Frollie/)).toBeTruthy();
    // Must NOT be stuck on the invoice-loading spinner.
    expect(screen.queryByText("Preparing payment…")).toBeNull();
  });

  it("confirm button is disabled until the attestation checkbox is checked", async () => {
    const user = userEvent.setup();
    setupManualTab();
    renderAt("txn-test-123");

    await user.click(await screen.findByRole("tab", { name: "Bank transfer" }));

    const confirmBtn = await screen.findByRole("button", { name: /confirm payment/i });
    expect(confirmBtn).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
  });

  it("confirm calls confirmManualBcaPayment and navigates to success", async () => {
    const user = userEvent.setup();
    const { confirmSpy } = setupManualTab();
    renderAt("txn-test-123");

    await user.click(await screen.findByRole("tab", { name: "Bank transfer" }));
    await user.click(await screen.findByRole("checkbox"));

    const confirmBtn = await screen.findByRole("button", { name: /confirm payment/i });
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());
    const args = confirmSpy.mock.calls[0][0] as {
      idempotencyKey: string;
      sessionId: string;
      txnId: string;
    };
    expect(args.sessionId).toBe("session-1");
    expect(args.txnId).toBe("txn-test-123");
    expect(typeof args.idempotencyKey).toBe("string");
    expect(args.idempotencyKey.length).toBeGreaterThan(0);

    await waitFor(() =>
      expect(screen.getByTestId("charge-success")).toBeTruthy(),
    );
  });

  it("maps a raw server error to friendly inline copy when confirmManualBcaPayment throws", async () => {
    const user = userEvent.setup();
    // Backend throws RECEIPT_UNCONFIRMED when the txn is no longer awaiting
    // (cancelled/expired race) — the FE must surface friendly copy, not the code.
    const failing = vi.fn().mockRejectedValue(new Error("RECEIPT_UNCONFIRMED"));
    setupManualTab(failing);
    renderAt("txn-test-123");

    await user.click(await screen.findByRole("tab", { name: "Bank transfer" }));
    await user.click(await screen.findByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: /confirm payment/i }));

    await waitFor(() =>
      expect(
        screen.getByText("This sale is no longer waiting for payment"),
      ).toBeTruthy(),
    );
    // Raw code never leaks to the cashier.
    expect(screen.queryByText(/RECEIPT_UNCONFIRMED/)).toBeNull();
    // Did NOT navigate to success.
    expect(screen.queryByTestId("charge-success")).toBeNull();
  });
});
