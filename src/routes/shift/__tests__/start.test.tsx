import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Mocks — defined before any imports of the module under test
// ---------------------------------------------------------------------------

const mockOpenBooth = vi.fn();
const mockManagerSkipOpen = vi.fn();
const mockNavigate = vi.fn();

// Mutable role so a test can render the route as a manager (skip-SOD path).
let mockRole: "staff" | "manager" = "staff";

// useSession returns an active session by default.
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "session_abc",
    staff: { _id: "staff_1", name: "Andi", role: mockRole, must_change_pin: false },
  }),
}));

// useIdempotency returns a stable string immediately (no async IDB in tests).
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "idem-key-test",
  clearIntent: vi.fn(),
}));

// useNavigate is patched before the route is imported.
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// convex/react — useMutation dispatches to openBooth; useAction to managerSkipOpen.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useMutation: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("openBooth")) return mockOpenBooth;
      return vi.fn().mockResolvedValue({});
    },
    useAction: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("managerSkipOpen")) return mockManagerSkipOpen;
      return vi.fn().mockResolvedValue({});
    },
    useQuery: () => [{ skuId: "sku1", name: "Dubai Cookie", on_hand: 10 }],
  };
});

// Stub CountStep: calls onSubmitted(3) when the user taps its submit button.
vi.mock("@/components/pos/CountStep", () => ({
  default: ({ onSubmitted, submitLabel }: { onSubmitted: (n: number) => void; submitLabel?: string }) => (
    <div>
      <span data-testid="count-step-stub">CountStep</span>
      <button
        data-testid="count-step-submit"
        onClick={() => onSubmitted(3)}
      >
        {submitLabel ?? "Simpan hitungan"}
      </button>
    </div>
  ),
}));

// Stub PinSheet: renders a simple form so skip tests don't need full keypad interaction.
vi.mock("@/components/pos/PinSheet", () => ({
  PinSheet: ({
    open,
    onSubmit,
    onCancel,
  }: {
    open: boolean;
    onSubmit: (pin: string) => void;
    onCancel: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="pin-sheet-stub">
        <button data-testid="pin-sheet-submit" onClick={() => onSubmit("1234")}>
          Submit PIN
        </button>
        <button data-testid="pin-sheet-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import ShiftStart from "../start";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/shift/start"]}>
      <ShiftStart />
    </MemoryRouter>,
  );
}

/**
 * Walk one wizard step forward:
 * - Count step: first click count-step-submit (unlocks the Next/terminal btn),
 *   then click Next or the terminal button.
 * - Instruction step: click Next (or the terminal button if last).
 */
async function advanceStep(isCount: boolean, isLast: boolean) {
  if (isCount) {
    fireEvent.click(screen.getByTestId("count-step-submit"));
    // Wait for ShiftWizard to set countReady=true → Next becomes visible.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /next|start of day/i }),
      ).toBeInTheDocument();
    });
  }
  if (isLast) {
    fireEvent.click(screen.getByRole("button", { name: /start of day/i }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShiftStart route (/shift/start)", () => {
  beforeEach(() => {
    mockOpenBooth.mockReset();
    mockOpenBooth.mockResolvedValue({ ok: true, shiftId: "shift_1" });
    mockManagerSkipOpen.mockReset();
    mockManagerSkipOpen.mockResolvedValue({ ok: true, shiftId: "shift_1" });
    mockNavigate.mockReset();
    mockRole = "staff";
  });

  it("renders the wizard title", () => {
    renderRoute();
    expect(screen.getByRole("heading", { name: /start of day/i })).toBeInTheDocument();
  });

  it("renders the 4 step labels in the rail", () => {
    renderRoute();
    expect(screen.getByText(/count stock/i)).toBeInTheDocument();
    expect(screen.getByText(/power on devices/i)).toBeInTheDocument();
    expect(screen.getByText(/fill display/i)).toBeInTheDocument();
    const railItems = screen.getAllByText(/start of day/i);
    expect(railItems.length).toBeGreaterThanOrEqual(1);
  });

  it("step 1 shows the count step UI", () => {
    renderRoute();
    expect(screen.getByTestId("count-step-stub")).toBeInTheDocument();
  });

  it("step 2 shows instruction body after advancing from step 1 (count step hidden)", async () => {
    renderRoute();
    await advanceStep(true, false);
    await waitFor(() => {
      expect(screen.queryByTestId("count-step-stub")).toBeNull();
    });
  });

  it("walks all 4 steps, calls openBooth with 4 confirmed steps + openCount, then navigates home", async () => {
    renderRoute();

    // Step 1 — count step
    await advanceStep(true, false);
    // Step 2 — instruction
    await waitFor(() => expect(screen.queryByTestId("count-step-stub")).toBeNull());
    await advanceStep(false, false);
    // Step 3 — instruction
    await advanceStep(false, false);
    // Step 4 — last instruction → terminal button "Start of day"
    await advanceStep(false, true);

    await waitFor(() => {
      expect(mockOpenBooth).toHaveBeenCalledTimes(1);
    });

    const call = mockOpenBooth.mock.calls[0][0] as {
      idempotencyKey: string;
      sessionId: string;
      steps: Array<{ key: string; label: string; type: string; confirmed_at: number }>;
      openCount?: number;
    };
    expect(call.idempotencyKey).toBe("idem-key-test");
    expect(call.sessionId).toBe("session_abc");
    expect(call.steps).toHaveLength(4);
    expect(call.steps[0].type).toBe("count");
    expect(call.steps[1].type).toBe("instruction");
    expect(call.steps[2].type).toBe("instruction");
    expect(call.steps[3].type).toBe("instruction");
    // openCount from CountStep stub's onSubmitted(3)
    expect(call.openCount).toBe(3);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  it("does NOT show the manager skip button for normal staff", () => {
    mockRole = "staff";
    renderRoute();
    expect(
      screen.queryByRole("button", { name: /skip start-of-day/i }),
    ).toBeNull();
  });

  it("manager skip: opens PinSheet when skip button is clicked", () => {
    mockRole = "manager";
    renderRoute();
    expect(screen.queryByTestId("pin-sheet-stub")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /skip start-of-day/i }));
    expect(screen.getByTestId("pin-sheet-stub")).toBeInTheDocument();
  });

  it("manager skip: calls managerSkipOpen with the entered PIN and navigates home", async () => {
    mockRole = "manager";
    renderRoute();

    fireEvent.click(screen.getByRole("button", { name: /skip start-of-day/i }));
    // Stub PinSheet auto-submits PIN "1234" when submit is clicked
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(mockManagerSkipOpen).toHaveBeenCalledTimes(1);
    });
    const call = mockManagerSkipOpen.mock.calls[0][0] as {
      idempotencyKey: string;
      sessionId: string;
      managerPin: string;
    };
    expect(call.sessionId).toBe("session_abc");
    expect(call.managerPin).toBe("1234");

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  it("Back button is disabled on the first step", () => {
    renderRoute();
    const backBtn = screen.getByRole("button", { name: /^back$/i });
    expect(backBtn).toBeDisabled();
  });

  it("Back button enabled on step 2 and returns to step 1 (count step visible)", async () => {
    renderRoute();
    await advanceStep(true, false);
    await waitFor(() => expect(screen.queryByTestId("count-step-stub")).toBeNull());
    const backBtn = screen.getByRole("button", { name: /^back$/i });
    expect(backBtn).not.toBeDisabled();
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(screen.getByTestId("count-step-stub")).toBeInTheDocument();
    });
  });
});
