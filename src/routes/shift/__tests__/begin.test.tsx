import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Mocks — defined before any imports of the module under test
// ---------------------------------------------------------------------------

const mockStartShift = vi.fn();
const mockNavigate = vi.fn();
const mockClearSession = vi.fn();
const mockToastError = vi.fn();

vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }));

// Mutable login context so each test can set the desired guard state.
let mockLoginCtx: { outletOpen: boolean; holderStaffId: string | null; holderName: string | null } | undefined = {
  outletOpen: true,
  holderStaffId: null,
  holderName: null,
};

vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "session_abc",
    staff: { _id: "staff_1", name: "Budi", role: "staff", must_change_pin: false },
  }),
  clearSession: () => mockClearSession(),
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "idem-key-begin",
  clearIntent: vi.fn(),
}));

vi.mock("@/hooks/useLoginContext", () => ({
  useLoginContext: () => mockLoginCtx,
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// convex/react — useMutation dispatches to startShift.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useMutation: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("startShift")) return mockStartShift;
      return vi.fn().mockResolvedValue({});
    },
    useQuery: () => [{ skuId: "sku1", name: "Dubai Cookie", on_hand: 10 }],
  };
});

// Stub CountStep: calls onSubmitted(5) when the user taps its submit button.
vi.mock("@/components/pos/CountStep", () => ({
  default: ({ onSubmitted }: { onSubmitted: (n: number) => void }) => (
    <div>
      <span data-testid="count-step-stub">CountStep</span>
      <button data-testid="count-step-submit" onClick={() => onSubmitted(5)}>
        Save count
      </button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import ShiftBegin from "../begin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/shift/begin"]}>
      <ShiftBegin />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShiftBegin route (/shift/begin)", () => {
  beforeEach(() => {
    mockStartShift.mockReset();
    mockStartShift.mockResolvedValue({ ok: true });
    mockNavigate.mockReset();
    mockLoginCtx = { outletOpen: true, holderStaffId: null, holderName: null };
  });

  it("renders the wizard title when outletOpen and no holder", () => {
    renderRoute();
    expect(screen.getByRole("heading", { name: /begin shift/i })).toBeInTheDocument();
  });

  it("renders the count step", () => {
    renderRoute();
    expect(screen.getByTestId("count-step-stub")).toBeInTheDocument();
  });

  it("happy path: completing the count step calls startShift with expected args and navigates home", async () => {
    renderRoute();

    // Click count-step-submit to trigger onSubmitted(5) inside CountStep stub.
    fireEvent.click(screen.getByTestId("count-step-submit"));

    // After count is ready, wait for the terminal "Start shift" button.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /start shift/i }),
      ).toBeInTheDocument();
    });

    // Click the terminal button to fire onComplete.
    fireEvent.click(screen.getByRole("button", { name: /start shift/i }));

    await waitFor(() => {
      expect(mockStartShift).toHaveBeenCalledTimes(1);
    });

    const call = mockStartShift.mock.calls[0][0] as {
      idempotencyKey: string;
      sessionId: string;
      steps: Array<{ key: string; label: string; type: string; confirmed_at: number }>;
      openCount?: number;
    };
    expect(call.idempotencyKey).toBe("idem-key-begin");
    expect(call.sessionId).toBe("session_abc");
    expect(call.steps).toHaveLength(1);
    expect(call.steps[0].type).toBe("count");
    // openCount comes from CountStep stub's onSubmitted(5)
    expect(call.openCount).toBe(5);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  it("stray-visit guard A: outletOpen=false → does not render wizard and does not call startShift", () => {
    mockLoginCtx = { outletOpen: false, holderStaffId: null, holderName: null };
    renderRoute();
    // Navigate renders, wizard does not.
    expect(screen.queryByTestId("count-step-stub")).toBeNull();
    expect(mockStartShift).not.toHaveBeenCalled();
  });

  it("stray-visit guard B: holderStaffId!=null → does not render wizard and does not call startShift", () => {
    mockLoginCtx = { outletOpen: true, holderStaffId: "staff_holder", holderName: "Holder" };
    renderRoute();
    expect(screen.queryByTestId("count-step-stub")).toBeNull();
    expect(mockStartShift).not.toHaveBeenCalled();
  });

  // Helper: drive the wizard to the terminal "Start shift" tap.
  async function submitWizard() {
    fireEvent.click(screen.getByTestId("count-step-submit"));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /start shift/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /start shift/i }));
  }

  it("self-handover rejection: shows the Resume/Logout prompt — does NOT auto-logout or navigate home", async () => {
    mockStartShift.mockRejectedValueOnce(new Error("SELF_HANDOVER_NOT_ALLOWED"));
    renderRoute();
    await submitWizard();

    // The resume prompt appears; no automatic logout / navigation.
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /resume/i })).toBeInTheDocument();
    });
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("self-handover → Resume: re-submits startShift with allowSelfResume + navigates home", async () => {
    mockStartShift
      .mockRejectedValueOnce(new Error("SELF_HANDOVER_NOT_ALLOWED"))
      .mockResolvedValueOnce({ ok: true });
    renderRoute();
    await submitWizard();

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /resume/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /resume shift/i }));

    await waitFor(() => {
      expect(mockStartShift).toHaveBeenCalledTimes(2);
    });
    // The retry carries the opt-in flag; the first attempt did not.
    expect(mockStartShift.mock.calls[0][0].allowSelfResume).toBeUndefined();
    expect(mockStartShift.mock.calls[1][0].allowSelfResume).toBe(true);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it("self-handover → Logout: ends the session and returns to /login (no home nav)", async () => {
    mockStartShift.mockRejectedValueOnce(new Error("SELF_HANDOVER_NOT_ALLOWED"));
    renderRoute();
    await submitWizard();

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /resume/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /log out for the next person/i }));

    await waitFor(() => {
      expect(mockClearSession).toHaveBeenCalledTimes(1);
    });
    expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true });
    expect(mockNavigate).not.toHaveBeenCalledWith("/", { replace: true });
  });
});
