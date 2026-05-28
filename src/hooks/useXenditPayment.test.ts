import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock convex/react — same pattern as useSession.test.tsx.
// useQuery returns the value from the current mock implementation;
// useAction returns the action mock fn.
// ---------------------------------------------------------------------------
const mockUseQuery = vi.fn();
const mockUseAction = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

// Import AFTER mocks are in place.
import {
  useXenditPayment,
  computePhase,
  POLL_INTERVAL_MS,
  POLL_CEILING_MS,
} from "./useXenditPayment";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeTxnId = "pos_transactions:abc123" as Id<"pos_transactions">;

function makeTxn(status: string) {
  return {
    _id: fakeTxnId,
    status,
    total: 50000,
    xendit_invoice_id_current: "inv_001",
  };
}

function makeInvoice(xenditId = "xen_001") {
  return {
    _id: "pos_xendit_invoices:inv1" as Id<"pos_xendit_invoices">,
    xendit_invoice_id: xenditId,
    transaction_id: fakeTxnId,
  };
}

// ---------------------------------------------------------------------------
// computePhase unit tests (pure — no hook mounting needed)
// ---------------------------------------------------------------------------
describe("computePhase", () => {
  it("returns {kind:'loading'} when txn is undefined", () => {
    expect(computePhase(undefined, makeInvoice())).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when invoice is undefined", () => {
    expect(computePhase(makeTxn("awaiting_payment"), undefined)).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when both are undefined", () => {
    expect(computePhase(undefined, undefined)).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when txn is null", () => {
    expect(computePhase(null, makeInvoice())).toEqual({ kind: "loading" });
  });

  it("returns {kind:'loading'} when invoice is null", () => {
    expect(computePhase(makeTxn("awaiting_payment"), null)).toEqual({ kind: "loading" });
  });

  it("returns {kind:'paid'} when txn.status === 'paid'", () => {
    expect(computePhase(makeTxn("paid"), makeInvoice())).toEqual({ kind: "paid" });
  });

  it("returns {kind:'cancelled'} when txn.status === 'cancelled'", () => {
    expect(computePhase(makeTxn("cancelled"), makeInvoice())).toEqual({ kind: "cancelled" });
  });

  it("returns {kind:'showing'} for awaiting_payment", () => {
    expect(computePhase(makeTxn("awaiting_payment"), makeInvoice())).toEqual({
      kind: "showing",
    });
  });
});

// ---------------------------------------------------------------------------
// Hook integration tests
// ---------------------------------------------------------------------------
describe("useXenditPayment (hook)", () => {
  const checkStatusMock = vi.fn().mockResolvedValue({ status: "PENDING" });

  beforeEach(() => {
    vi.useFakeTimers();
    mockUseQuery.mockReturnValue(undefined);
    mockUseAction.mockReturnValue(checkStatusMock);
    checkStatusMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns {phase:{kind:'loading'}} when both queries return undefined", () => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useXenditPayment(fakeTxnId));

    expect(result.current.phase).toEqual({ kind: "loading" });
    expect(result.current.txn).toBeUndefined();
    expect(result.current.invoice).toBeUndefined();
  });

  it("returns {phase:{kind:'paid'}} when txn.status === 'paid' and does NOT start polling", async () => {
    const txn = makeTxn("paid");
    const invoice = makeInvoice();

    // First call is for getById, second for getCurrentInvoice.
    mockUseQuery
      .mockReturnValueOnce(txn)
      .mockReturnValueOnce(invoice)
      .mockReturnValue(undefined);

    const { result } = renderHook(() => useXenditPayment(fakeTxnId));

    expect(result.current.phase).toEqual({ kind: "paid" });

    // Advance timers well past the polling interval — checkStatus must not fire.
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });

    expect(checkStatusMock).not.toHaveBeenCalled();
  });

  it("starts polling after 2s for awaiting_payment and calls checkStatus", async () => {
    const txn = makeTxn("awaiting_payment");
    const invoice = makeInvoice("xen_poll_test");

    mockUseQuery
      .mockReturnValueOnce(txn)
      .mockReturnValueOnce(invoice)
      // Subsequent renders keep the same values.
      .mockReturnValue(undefined);

    // Provide stable values on every render so useQuery always returns both.
    mockUseQuery.mockImplementation(() => {
      // Both queries need values; alternate by tracking calls is fragile — use
      // implementation that returns based on call argument inspection instead.
      return undefined; // reset then override below
    });

    // Simpler: always return txn for first call, invoice for second per render.
    let callCount = 0;
    mockUseQuery.mockImplementation(() => {
      const idx = callCount++ % 2;
      return idx === 0 ? txn : invoice;
    });

    checkStatusMock.mockResolvedValue({ status: "PENDING" });

    const { result } = renderHook(() => useXenditPayment(fakeTxnId));

    expect(result.current.phase).toEqual({ kind: "showing" });

    // Advance past the first poll (2s timeout fires first poll).
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS + 50);
    });

    expect(checkStatusMock).toHaveBeenCalledWith({ invoiceId: "xen_poll_test" });
    // Both the initial setTimeout(2s) and the setInterval(2s) may fire at the
    // same fake-timer tick, so allow 1 or 2 calls at this point.
    expect(checkStatusMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("stops polling after 60s ceiling is reached", async () => {
    const txn = makeTxn("awaiting_payment");
    const invoice = makeInvoice("xen_ceiling");

    let callCount = 0;
    mockUseQuery.mockImplementation(() => {
      const idx = callCount++ % 2;
      return idx === 0 ? txn : invoice;
    });

    checkStatusMock.mockResolvedValue({ status: "PENDING" });

    renderHook(() => useXenditPayment(fakeTxnId));

    // Advance well past ceiling — POLL_CEILING_MS / POLL_INTERVAL_MS = 30 ticks max.
    // After ceiling, the interval's own guard clears it and no further calls happen.
    await act(async () => {
      vi.advanceTimersByTime(POLL_CEILING_MS + POLL_INTERVAL_MS * 5);
    });

    // The initial setTimeout fires at 2s, then the interval fires every 2s.
    // After 60s ceiling the interval stops. Max calls = ~31 (1 initial + 30 interval
    // ticks within 60s). Allow some tolerance for timer rounding.
    const callsMade = checkStatusMock.mock.calls.length;
    // Should be roughly 31 calls (initial + ceiling/interval ticks)
    // but definitely NOT hundreds — assert it stopped growing.
    expect(callsMade).toBeLessThanOrEqual(35);
    expect(callsMade).toBeGreaterThan(0);

    // Capture count and advance further — should not grow.
    const countAtCeiling = callsMade;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 10);
    });
    expect(checkStatusMock.mock.calls.length).toBe(countAtCeiling);
  });

  it("stops polling when hook unmounts", async () => {
    const txn = makeTxn("awaiting_payment");
    const invoice = makeInvoice("xen_unmount");

    let callCount = 0;
    mockUseQuery.mockImplementation(() => {
      const idx = callCount++ % 2;
      return idx === 0 ? txn : invoice;
    });

    checkStatusMock.mockResolvedValue({ status: "PENDING" });

    const { unmount } = renderHook(() => useXenditPayment(fakeTxnId));

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS + 50);
    });

    const callsBeforeUnmount = checkStatusMock.mock.calls.length;
    expect(callsBeforeUnmount).toBeGreaterThan(0);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });

    // No additional calls after unmount.
    expect(checkStatusMock.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it("exports POLL_INTERVAL_MS = 2000 and POLL_CEILING_MS = 60000", () => {
    expect(POLL_INTERVAL_MS).toBe(2000);
    expect(POLL_CEILING_MS).toBe(60_000);
  });
});
