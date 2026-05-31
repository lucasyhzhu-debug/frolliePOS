import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetForTests } from "@/hooks/useIdempotency";

/**
 * Smoke + behaviour tests for the /approve/:token public approval route.
 *
 * Covers two variants:
 *   - staff_pin_reset  (v0.3, preserved intact)
 *   - manual_payment_override (v0.4, Task 28)
 *
 * ## useAction mock strategy
 * Convex API proxy objects are NOT identity-stable (each property access
 * creates a new proxy), so identity-map dispatch doesn't work.
 *
 * We use a call-sequence queue: `actionQueue` is an array of stubs loaded
 * before each render. `useAction` pops from the front on each call.
 * Components call `useAction` in a fixed order per variant:
 *   pin_reset:       [approveStaffPinReset]
 *   manual_payment:  [approveManualPayment, denyRequest]
 *
 * `stageActions(...stubs)` loads the queue before `renderAt()`.
 * Module-level refs (`mockApprove*`) let individual tests override behaviour
 * after the common `beforeEach` setup.
 *
 * PINs are never logged — tests never read pin-value state directly.
 */

// ---------- mocks ------------------------------------------------------------

let mockQueryReturn: unknown = undefined;
// Default managers returned by the second useQuery call (listActiveManagers).
// Tests don't assert on the dropdown contents — they just need a valid array
// so the Select renders without crashing on `.map`.
const DEFAULT_MANAGERS = [
  { name: "Lucy", code: "MGR01" },
  { name: "Marco", code: "MGR02" },
];

// jsdom doesn't implement these; Radix UI Select calls them when opening
// the dropdown. Polyfill before any Select renders.
if (typeof window !== "undefined") {
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  }
  if (!window.HTMLElement.prototype.hasPointerCapture) {
    window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  }
  if (!window.HTMLElement.prototype.releasePointerCapture) {
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
}

// Helper: click the manager-identity Select and pick the option whose code text matches.
// Uses role="option" to target the dropdown list item specifically (avoids
// "multiple elements" errors when Radix duplicates text in trigger + portal).
async function selectManager(code: string) {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");
  const trigger = screen.getByLabelText(/your manager identity/i);
  fireEvent.click(trigger);
  await waitFor(() =>
    expect(screen.getByRole("option", { name: new RegExp(`^${code}\\b`) }))
      .toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${code}\\b`) }));
}
let mockManagersReturn: unknown = DEFAULT_MANAGERS;
// Per-render useQuery slot counter: slot 0 = getByToken, slot 1 = listActiveManagers.
// Reset to 0 in beforeEach. Same modulo-cycling trick as the useAction slots so
// re-renders map back to the same stubs.
let queryCounter = 0;

let mockApproveStaffPinReset: ReturnType<typeof vi.fn>;
let mockApproveManualPayment: ReturnType<typeof vi.fn>;
let mockDenyRequest: ReturnType<typeof vi.fn>;

// Slot array: each entry is the stub for that useAction() call position.
// Slot 0 = first useAction call in the component (approveStaffPinReset or
//          approveManualPayment), Slot 1 = second (denyRequest).
// The slot wrapper captures its slot index at hook-call time and looks up the
// stub at invocation time — so re-renders don't advance the slot and each
// action always delegates to the correct stub even after re-renders.
const actionSlots: Array<ReturnType<typeof vi.fn>> = [];
let slotCounter = 0;

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: (_query: unknown, args: unknown) => {
      // Dispatch by args shape — getByToken takes { rawToken }, listActiveManagers
      // takes { token }. Convex FunctionReferences can't be safely string-coerced
      // (Symbol.toPrimitive throws), so we can't dispatch by query identity.
      if (args && typeof args === "object" && "token" in args && !("rawToken" in args)) {
        return mockManagersReturn;
      }
      return mockQueryReturn;
    },
    // Each call to useAction() assigns the next slot index to a closure.
    // Re-renders of the same component will call useAction() again — React
    // 19 doesn't guarantee hook call deduplication. To handle this, we use
    // the fact that React calls hooks in the SAME ORDER on every render, so
    // slot assignments are stable across re-renders.
    // The wrapper captures `slotIdx` at hook-call time; at invocation time
    // it delegates to `actionSlots[slotIdx]` (which tests can swap between
    // call and invocation). slotCounter is reset in resetSlots().
    useAction: () => {
      // Cycle through staged stubs modulo the slot count so that re-renders
      // (triggered by IDB state updates) map back to the same stubs as the
      // initial render. E.g. for 2 stubs: 0,1,0,1,... — each re-render's
      // useAction calls map to the same wrappers as the first render.
      const count = actionSlots.length || 1;
      const slotIdx = slotCounter % count;
      slotCounter++;
      return (...args: unknown[]) => {
        const stub = actionSlots[slotIdx] ?? vi.fn().mockResolvedValue({});
        return stub(...args);
      };
    },
  };
});

// ---------- helpers ----------------------------------------------------------

/**
 * Load the action stubs into slots. Call BEFORE renderAt().
 * Resets slotCounter so the next component mount assigns slot 0 first.
 *
 * pin_reset:       stageActions(mockApproveStaffPinReset)
 * manual_payment:  stageActions(mockApproveManualPayment, mockDenyRequest)
 *
 * Slot assignment mirrors the order useAction() is called in each variant:
 *   Slot 0 = approveManualPayment / approveStaffPinReset
 *   Slot 1 = denyRequest
 */
function stageActions(...stubs: Array<ReturnType<typeof vi.fn>>) {
  actionSlots.length = 0;
  actionSlots.push(...stubs);
  slotCounter = 0;
  queryCounter = 0;
}

function renderAt(token = "test-token-abc") {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={[`/approve/${token}`]}>
        <Routes>
          <Route path="/approve/:token" element={<ApproveRouteComponent />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// Imported after mock setup so it picks up the mocked convex/react.
import ApproveRouteComponent from "./index";

// ---------- staff_pin_reset tests --------------------------------------------

describe("Approve route (/approve/:token) — public PIN-reset page", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetForTests();
    actionSlots.length = 0;
    slotCounter = 0;
    queryCounter = 0;
    mockManagersReturn = DEFAULT_MANAGERS;
    mockQueryReturn = undefined;
    mockApproveStaffPinReset = vi.fn().mockResolvedValue({ resolved: true });
    mockApproveManualPayment = vi.fn().mockResolvedValue({ resolved: true });
    mockDenyRequest = vi.fn().mockResolvedValue({ denied: true });
  });

  it("renders a loading spinner while useQuery is pending (undefined)", () => {
    mockQueryReturn = undefined;
    stageActions(mockApproveStaffPinReset);
    const { container } = renderAt();
    expect(container).toBeTruthy();
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("shows expired message when useQuery returns null", () => {
    mockQueryReturn = null;
    stageActions(mockApproveStaffPinReset);
    renderAt();
    expect(screen.getByText(/expired or is invalid/i)).toBeInTheDocument();
  });

  it("shows expired message when status is 'expired'", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Budi",
      subject_staff_code: "STF01",
      status: "expired",
      triggered_at: Date.now() - 70 * 60 * 1000,
      token_expires_at: Date.now() - 10 * 60 * 1000,
    };
    stageActions(mockApproveStaffPinReset);
    renderAt();
    expect(screen.getByText(/expired or is invalid/i)).toBeInTheDocument();
  });

  it("shows already-reset message when status is 'resolved'", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Siti",
      subject_staff_code: "STF02",
      status: "resolved",
      triggered_at: Date.now() - 30 * 60 * 1000,
      token_expires_at: Date.now() + 30 * 60 * 1000,
      resolved_at: Date.now() - 5 * 60 * 1000,
    };
    stageActions(mockApproveStaffPinReset);
    renderAt();
    expect(screen.getByText(/already been reset/i)).toBeInTheDocument();
    expect(screen.getByText(/Siti/)).toBeInTheDocument();
  });

  it("renders the pending form with staff name + form fields when status is 'pending'", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Andi",
      subject_staff_code: "STF03",
      status: "pending",
      triggered_at: Date.now() - 5 * 60 * 1000,
      token_expires_at: Date.now() + 55 * 60 * 1000,
    };
    stageActions(mockApproveStaffPinReset);
    renderAt();

    expect(screen.getByRole("heading", { name: /PIN Reset/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Andi/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/your manager identity/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reset PIN/i })).toBeInTheDocument();
  });

  it("submit button is disabled when fields are incomplete", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Andi",
      subject_staff_code: "STF03",
      status: "pending",
      triggered_at: Date.now(),
      token_expires_at: Date.now() + 60 * 60 * 1000,
    };
    stageActions(mockApproveStaffPinReset);
    renderAt();
    expect(screen.getByRole("button", { name: /Reset PIN/i })).toBeDisabled();
  });
});

// ---------- manual_payment_override tests ------------------------------------

describe("Approve route — manual_payment_override variant", () => {
  const pendingPaymentRequest = {
    kind: "manual_payment_override" as const,
    display: {
      amount_idr: 250_000,
      reason: "Customer paid via e-wallet but app timed out",
      requester_name: "Dewi",
    },
    status: "pending",
    triggered_at: Date.now() - 5 * 60 * 1000,
    token_expires_at: Date.now() + 55 * 60 * 1000,
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetForTests();
    actionSlots.length = 0;
    slotCounter = 0;
    queryCounter = 0;
    mockManagersReturn = DEFAULT_MANAGERS;
    mockQueryReturn = pendingPaymentRequest;
    mockApproveStaffPinReset = vi.fn().mockResolvedValue({ resolved: true });
    mockApproveManualPayment = vi.fn().mockResolvedValue({ resolved: true });
    mockDenyRequest = vi.fn().mockResolvedValue({ denied: true });
  });

  it("renders the heading, IDR-formatted amount, and reason", () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    expect(
      screen.getByRole("heading", { name: /Manager approval needed/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/250/)).toBeInTheDocument();
    expect(
      screen.getByText(/Customer paid via e-wallet but app timed out/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Dewi/i)).toBeInTheDocument();
  });

  it("renders Approve and Deny buttons in the pending form", () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    expect(screen.getByRole("button", { name: /^Approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Deny$/i })).toBeInTheDocument();
  });

  it("Approve button is disabled when staff code or PIN is missing", () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    expect(screen.getByRole("button", { name: /^Approve$/i })).toBeDisabled();
  });

  it("calls approveManualPayment with correct args on Approve click (with code + PIN entered)", async () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt("my-test-token");

    await selectManager("MGR01");

    // Enter 4-digit PIN via keyboard events (NumericKeypad binds to document.keydown)
    fireEvent.keyDown(document, { key: "1" });
    fireEvent.keyDown(document, { key: "2" });
    fireEvent.keyDown(document, { key: "3" });
    fireEvent.keyDown(document, { key: "4" });

    // Wait for idempotency key IDB read
    const approveBtn = screen.getByRole("button", { name: /^Approve$/i });
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(mockApproveManualPayment).toHaveBeenCalledTimes(1);
    });

    const args = mockApproveManualPayment.mock.calls[0][0] as Record<string, unknown>;
    expect(args.token).toBe("my-test-token");
    expect(args.managerStaffCode).toBe("MGR01");
    expect(args.managerPin).toBe("1234");
    expect(typeof args.idempotencyKey).toBe("string");
    expect((args.idempotencyKey as string).length).toBeGreaterThan(0);
  });

  it("shows success screen after approve", async () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    await selectManager("MGR01");
    fireEvent.keyDown(document, { key: "1" });
    fireEvent.keyDown(document, { key: "2" });
    fireEvent.keyDown(document, { key: "3" });
    fireEvent.keyDown(document, { key: "4" });

    const approveBtn = screen.getByRole("button", { name: /^Approve$/i });
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Approved/i)).toBeInTheDocument();
    });
  });

  it("reveals deny-reason input when Deny is clicked", () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    fireEvent.click(screen.getByRole("button", { name: /^Deny$/i }));

    expect(screen.getByLabelText(/Reason for declining/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm Deny/i })).toBeInTheDocument();
  });

  it("Confirm Deny button is disabled when deny reason is empty", () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    fireEvent.click(screen.getByRole("button", { name: /^Deny$/i }));

    expect(screen.getByRole("button", { name: /Confirm Deny/i })).toBeDisabled();
  });

  it("calls denyRequest with correct args on Confirm Deny", async () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt("deny-test-token");

    await selectManager("MGR02");
    fireEvent.keyDown(document, { key: "5" });
    fireEvent.keyDown(document, { key: "6" });
    fireEvent.keyDown(document, { key: "7" });
    fireEvent.keyDown(document, { key: "8" });

    fireEvent.click(screen.getByRole("button", { name: /^Deny$/i }));
    fireEvent.change(screen.getByLabelText(/Reason for declining/i), {
      target: { value: "Already paid via other channel" },
    });

    const confirmBtn = screen.getByRole("button", { name: /Confirm Deny/i });
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockDenyRequest).toHaveBeenCalledTimes(1);
    });

    const args = mockDenyRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(args.token).toBe("deny-test-token");
    expect(args.managerStaffCode).toBe("MGR02");
    expect(args.managerPin).toBe("5678");
    expect(args.denyReason).toBe("Already paid via other channel");
    expect(typeof args.idempotencyKey).toBe("string");
  });

  it("shows declined screen after deny", async () => {
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    await selectManager("MGR01");
    fireEvent.keyDown(document, { key: "1" });
    fireEvent.keyDown(document, { key: "2" });
    fireEvent.keyDown(document, { key: "3" });
    fireEvent.keyDown(document, { key: "4" });

    fireEvent.click(screen.getByRole("button", { name: /^Deny$/i }));
    fireEvent.change(screen.getByLabelText(/Reason for declining/i), {
      target: { value: "Test reason" },
    });

    const confirmBtn = screen.getByRole("button", { name: /Confirm Deny/i });
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/payment request rejected/i)).toBeInTheDocument();
    });
  });

  it("shows inline error on INVALID_PIN", async () => {
    // Override approve stub to reject before staging
    mockApproveManualPayment = vi.fn().mockRejectedValue(new Error("INVALID_PIN"));
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    await selectManager("MGR01");
    fireEvent.keyDown(document, { key: "9" });
    fireEvent.keyDown(document, { key: "9" });
    fireEvent.keyDown(document, { key: "9" });
    fireEvent.keyDown(document, { key: "9" });

    const approveBtn = screen.getByRole("button", { name: /^Approve$/i });
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
    fireEvent.click(approveBtn);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/Wrong manager PIN/i);
    });
  });

  it("shows inline error on NOT_MANAGER", async () => {
    mockApproveManualPayment = vi.fn().mockRejectedValue(new Error("NOT_MANAGER"));
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    // Pre-dropdown UX let the user type any staff code (incl. non-managers); the
    // v0.4 dropdown only lists active managers. The NOT_MANAGER error path now
    // only triggers as a defense-in-depth on the backend — the action stub will
    // throw it regardless of what the UI selected.
    await selectManager("MGR01");
    fireEvent.keyDown(document, { key: "1" });
    fireEvent.keyDown(document, { key: "2" });
    fireEvent.keyDown(document, { key: "3" });
    fireEvent.keyDown(document, { key: "4" });

    const approveBtn = screen.getByRole("button", { name: /^Approve$/i });
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/not a manager/i);
    });
  });

  it("shows already-approved resolved screen when status is resolved", () => {
    mockQueryReturn = {
      ...pendingPaymentRequest,
      status: "resolved",
      resolved_at: Date.now() - 2 * 60 * 1000,
    };
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    expect(screen.getByText(/already approved/i)).toBeInTheDocument();
  });

  it("shows already-denied screen when status is denied (with denier + reason)", () => {
    mockQueryReturn = {
      ...pendingPaymentRequest,
      status: "denied",
      resolved_at: Date.now() - 2 * 60 * 1000,
      deny_reason: "looks fraudulent",
      denied_by_manager_name: "Lucy",
      denied_by_manager_code: "MGR01",
      denied_at: Date.now() - 60_000,
    };
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    // v0.4 enrichment: the already-denied surface names the denier + reason
    expect(screen.getByText(/was declined by/i)).toBeInTheDocument();
    expect(screen.getByText(/Lucy/)).toBeInTheDocument();
    expect(screen.getByText(/looks fraudulent/)).toBeInTheDocument();
  });

  it("shows revoke copy on same-visit REQUEST_REVOKED throw", async () => {
    mockApproveManualPayment = vi.fn().mockRejectedValue(new Error("REQUEST_REVOKED"));
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    await selectManager("MGR01");
    fireEvent.keyDown(document, { key: "1" });
    fireEvent.keyDown(document, { key: "2" });
    fireEvent.keyDown(document, { key: "3" });
    fireEvent.keyDown(document, { key: "4" });

    const approveBtn = screen.getByRole("button", { name: /^Approve$/i });
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
    fireEvent.click(approveBtn);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/Approval revoked/i);
    });
  });

  it("shows revoke copy on next-visit denied-by-system token", () => {
    mockQueryReturn = {
      ...pendingPaymentRequest,
      status: "denied",
      deny_reason: "too_many_pin_attempts",
      denied_by_manager_id: "system",
      denied_at: Date.now() - 60_000,
    };
    stageActions(mockApproveManualPayment, mockDenyRequest);
    renderAt();

    expect(screen.getByText(/Approval revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/too many wrong PIN attempts/i)).toBeInTheDocument();
    // PIN input should not be present — the page is in a terminal state
    expect(screen.queryByRole("button", { name: /^Approve$/i })).not.toBeInTheDocument();
  });
});
