import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Mocks — defined before any imports of the module under test
// ---------------------------------------------------------------------------

const mockCompleteStartOfDay = vi.fn();
const mockNavigate = vi.fn();

// useSession returns an active session by default.
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "session_abc",
    staff: { _id: "staff_1", name: "Andi", role: "staff", must_change_pin: false },
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

// convex/react — useMutation returns our spy.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useMutation: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("completeStartOfDay")) return mockCompleteStartOfDay;
      return vi.fn().mockResolvedValue({ changed: 2 });
    },
    useQuery: () => [{ skuId: "sku1", name: "Dubai Cookie", on_hand: 10 }],
  };
});

// Stub CountStep: calls onSubmitted(3) when the user taps its submit button.
// This avoids IDB + Convex deps inside CountStep under jsdom.
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
    mockCompleteStartOfDay.mockReset();
    mockCompleteStartOfDay.mockResolvedValue({ ok: true, eventId: "evt_1" });
    mockNavigate.mockReset();
  });

  it("renders the wizard title", () => {
    renderRoute();
    expect(screen.getByRole("heading", { name: /start of day/i })).toBeInTheDocument();
  });

  it("renders the 4 step labels in the rail", () => {
    renderRoute();
    // Step 1
    expect(screen.getByText(/count stock/i)).toBeInTheDocument();
    // Step 2
    expect(screen.getByText(/power on devices/i)).toBeInTheDocument();
    // Step 3
    expect(screen.getByText(/fill display/i)).toBeInTheDocument();
    // Step 4 — label is "Start of day" (doubles as terminal button text per ShiftWizard)
    // There will be at least one: the rail span.
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
    // After advancing, AnimatePresence exits the count step and enters step 2.
    await waitFor(() => {
      expect(screen.queryByTestId("count-step-stub")).toBeNull();
    });
  });

  it("walks all 4 steps, calls completeStartOfDay with 4 confirmed steps + countChanged, then navigates home", async () => {
    renderRoute();

    // Step 1 — count step
    await advanceStep(true, false);
    // Step 2 — instruction
    await waitFor(() => expect(screen.queryByTestId("count-step-stub")).toBeNull());
    await advanceStep(false, false);
    // Step 3 — instruction
    await advanceStep(false, false);
    // Step 4 — last instruction → terminal button "Mulai hari"
    await advanceStep(false, true);

    await waitFor(() => {
      expect(mockCompleteStartOfDay).toHaveBeenCalledTimes(1);
    });

    const call = mockCompleteStartOfDay.mock.calls[0][0] as {
      idempotencyKey: string;
      sessionId: string;
      steps: Array<{ key: string; label: string; type: string; confirmed_at: number }>;
      countChanged?: number;
    };
    expect(call.idempotencyKey).toBe("idem-key-test");
    expect(call.sessionId).toBe("session_abc");
    expect(call.steps).toHaveLength(4);
    expect(call.steps[0].type).toBe("count");
    expect(call.steps[1].type).toBe("instruction");
    expect(call.steps[2].type).toBe("instruction");
    expect(call.steps[3].type).toBe("instruction");
    // countChanged from CountStep stub's onSubmitted(3)
    expect(call.countChanged).toBe(3);

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
