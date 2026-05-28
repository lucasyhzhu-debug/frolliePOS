import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock convex/react — same pattern as useXenditPayment.test.ts
// ---------------------------------------------------------------------------
const mockUseQuery = vi.fn();
const mockUseAction = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

// Mock sonner toast
const mockToastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}));

// Import AFTER mocks are in place.
import { useStartupReconciliation } from "./useStartupReconciliation";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeSessionId = "staff_sessions:abc" as Id<"staff_sessions">;

function makePendingTxn(xenditId: string) {
  return {
    _id: "pos_transactions:t1" as Id<"pos_transactions">,
    status: "awaiting_payment" as const,
    xendit_invoice_id_current: xenditId,
    total: 100_000,
    created_at: Date.now() - 60_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("useStartupReconciliation", () => {
  const checkStatusMock = vi.fn();

  beforeEach(() => {
    mockUseQuery.mockReset();
    mockUseAction.mockReset();
    mockToastSuccess.mockClear();
    checkStatusMock.mockReset();
    mockUseAction.mockReturnValue(checkStatusMock);
  });

  it("calls checkStatus and shows toast when a recent txn resolves as PAID", async () => {
    const txn = makePendingTxn("xen_001");
    mockUseQuery.mockReturnValue([txn]);
    checkStatusMock.mockResolvedValue({ status: "PAID" });

    renderHook(() => useStartupReconciliation(fakeSessionId));

    await waitFor(() => expect(checkStatusMock).toHaveBeenCalledWith({ invoiceId: "xen_001" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Reconciled 1 pending payment."));
  });

  it("shows plural message when multiple txns reconcile", async () => {
    const txns = [makePendingTxn("xen_A"), makePendingTxn("xen_B")].map((t, i) => ({
      ...t,
      _id: `pos_transactions:t${i}` as Id<"pos_transactions">,
    }));
    mockUseQuery.mockReturnValue(txns);
    checkStatusMock.mockResolvedValue({ status: "PAID" });

    renderHook(() => useStartupReconciliation(fakeSessionId));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Reconciled 2 pending payments."));
  });

  it("does not call checkStatus or toast when recent is empty", async () => {
    mockUseQuery.mockReturnValue([]);

    renderHook(() => useStartupReconciliation(fakeSessionId));

    // Allow microtasks to flush.
    await act(async () => {});

    expect(checkStatusMock).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("does not call checkStatus or toast when status is PENDING", async () => {
    const txn = makePendingTxn("xen_pending");
    mockUseQuery.mockReturnValue([txn]);
    checkStatusMock.mockResolvedValue({ status: "PENDING" });

    renderHook(() => useStartupReconciliation(fakeSessionId));

    await waitFor(() => expect(checkStatusMock).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("skips txns with no xendit_invoice_id_current", async () => {
    const txn = {
      ...makePendingTxn("xen_skip"),
      xendit_invoice_id_current: undefined,
    };
    mockUseQuery.mockReturnValue([txn]);

    renderHook(() => useStartupReconciliation(fakeSessionId));

    await act(async () => {});

    expect(checkStatusMock).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("swallows errors from checkStatus without crashing", async () => {
    const txn = makePendingTxn("xen_err");
    mockUseQuery.mockReturnValue([txn]);
    checkStatusMock.mockRejectedValue(new Error("Network error"));

    // Should not throw.
    const { result } = renderHook(() => useStartupReconciliation(fakeSessionId));
    await act(async () => {});
    // Hook still exists — no crash.
    expect(result.error).toBeUndefined();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("runs only once per mount (ref guard) — does not re-run on re-render", async () => {
    const txn = makePendingTxn("xen_once");
    mockUseQuery.mockReturnValue([txn]);
    checkStatusMock.mockResolvedValue({ status: "PAID" });

    const { rerender } = renderHook(() => useStartupReconciliation(fakeSessionId));
    await waitFor(() => expect(checkStatusMock).toHaveBeenCalledTimes(1));

    // Force a re-render — the ref guard should prevent a second run.
    rerender();
    await act(async () => {});

    expect(checkStatusMock).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });

  it("passes 'skip' to useQuery when sessionId is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);

    renderHook(() => useStartupReconciliation(undefined));

    // First arg to useQuery must be the api reference; second must be "skip".
    const calls = mockUseQuery.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // The second argument (args) should be "skip" when sessionId is undefined.
    expect(calls[0][1]).toBe("skip");
    expect(checkStatusMock).not.toHaveBeenCalled();
  });

  it("does not run while recent is still loading (undefined)", async () => {
    mockUseQuery.mockReturnValue(undefined);

    renderHook(() => useStartupReconciliation(fakeSessionId));
    await act(async () => {});

    expect(checkStatusMock).not.toHaveBeenCalled();
  });
});
