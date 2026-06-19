import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Hoist mock spies so vi.mock factories can reference them before initialization.
// ---------------------------------------------------------------------------
const {
  mockLoginWithPin,
  mockCompleteHandoverIn,
  mockNavigate,
  mockStoreSession,
  mockUseIdempotency,
} = vi.hoisted(() => ({
  mockLoginWithPin: vi.fn(),
  mockCompleteHandoverIn: vi.fn(),
  mockNavigate: vi.fn(),
  mockStoreSession: vi.fn(),
  mockUseIdempotency: vi.fn((intent: string) => `idem-key:${intent}`),
}));

// Outgoing staff id — used in both booth state + staff list to test exclusion.
const OUTGOING_STAFF_ID = "staff_outgoing";

// useBoothState returns handover_pending with the outgoing staff.
vi.mock("@/hooks/useBoothState", () => ({
  useBoothState: () => ({
    state: "handover_pending",
    staffId: OUTGOING_STAFF_ID,
    staffName: "Sari (outgoing)",
    staleAutoclose: false,
  }),
}));

// useDeviceId returns a stable device id.
vi.mock("@/hooks/useDeviceId", () => ({
  useDeviceId: () => "device-001",
}));

// useIdempotency returns a stable string immediately (no async IDB in tests).
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: mockUseIdempotency,
  clearIntent: vi.fn(),
}));

// storeSession — spy only. useSession needed by LocaleProvider.
vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
  storeSession: mockStoreSession,
}));

// useNavigate patched before the route is imported.
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// convex/react — useQuery returns 2 staff INCLUDING the outgoing one;
// useAction returns loginWithPin spy; useMutation returns completeHandoverIn spy.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: () => [
      { _id: OUTGOING_STAFF_ID, name: "Sari (outgoing)", role: "staff" },
      { _id: "staff_incoming", name: "Budi (incoming)", role: "staff" },
    ],
    useAction: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("loginWithPin")) return mockLoginWithPin;
      return vi.fn();
    },
    useMutation: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("completeHandoverIn")) return mockCompleteHandoverIn;
      return vi.fn();
    },
  };
});

// PinSheet stub — renders a simple form that calls onSubmit with a test PIN.
vi.mock("@/components/pos/PinSheet", () => ({
  PinSheet: ({
    open,
    title,
    pending,
    error,
    onSubmit,
    onCancel,
  }: {
    open: boolean;
    title: string;
    pending?: boolean;
    error?: string;
    onSubmit: (pin: string) => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div data-testid="pin-sheet">
        <span data-testid="pin-sheet-title">{title}</span>
        {error && <span data-testid="pin-sheet-error">{error}</span>}
        {pending && <span data-testid="pin-sheet-pending">pending</span>}
        <button data-testid="pin-sheet-submit" onClick={() => onSubmit("1234")}>
          Submit PIN
        </button>
        <button data-testid="pin-sheet-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

// CountStep stub — calls onSubmitted(5) when tapped.
vi.mock("@/components/pos/CountStep", () => ({
  default: ({ onSubmitted }: { onSubmitted: (n: number) => void; submitLabel?: string }) => (
    <div>
      <span data-testid="count-step-stub">CountStep</span>
      <button data-testid="count-step-submit" onClick={() => onSubmitted(5)}>
        Simpan hitungan
      </button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import ShiftHandover from "../handover";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/shift/handover"]}>
      <ShiftHandover />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShiftHandover route (/shift/handover)", () => {
  beforeEach(() => {
    mockLoginWithPin.mockReset();
    mockLoginWithPin.mockResolvedValue({ sessionId: "session_new_123", role: "staff" });
    mockCompleteHandoverIn.mockReset();
    mockCompleteHandoverIn.mockResolvedValue({ ok: true, eventId: "evt_handover_1" });
    mockNavigate.mockReset();
    mockStoreSession.mockReset();
    mockUseIdempotency.mockReset();
    mockUseIdempotency.mockImplementation((intent: string) => `idem-key:${intent}`);
  });

  // -------------------------------------------------------------------------
  // pick stage
  // -------------------------------------------------------------------------

  it("renders the staff picker heading", () => {
    renderRoute();
    expect(screen.getByRole("heading")).toBeInTheDocument();
  });

  it("EXCLUDES the outgoing staff from the picker (key exclusion assertion)", () => {
    renderRoute();
    // The outgoing staff's name must NOT appear as a selectable button.
    expect(screen.queryByRole("button", { name: /sari \(outgoing\)/i })).toBeNull();
  });

  it("shows only the incoming-eligible staff in the picker", () => {
    renderRoute();
    // Budi should appear; Sari should not.
    expect(screen.getByRole("button", { name: /budi \(incoming\)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sari \(outgoing\)/i })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // pick → pin transition
  // -------------------------------------------------------------------------

  it("opens PinSheet when an incoming staff is selected", () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    expect(screen.getByTestId("pin-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("pin-sheet-title")).toHaveTextContent(/budi/i);
  });

  it("cancelling PinSheet returns to pick stage", () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    expect(screen.getByTestId("pin-sheet")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pin-sheet-cancel"));
    expect(screen.queryByTestId("pin-sheet")).toBeNull();
    expect(screen.getByRole("button", { name: /budi \(incoming\)/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // pin → loginWithPin → storeSession → count stage
  // -------------------------------------------------------------------------

  it("calls loginWithPin with correct args on PIN submit", async () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(mockLoginWithPin).toHaveBeenCalledWith({
        staffId: "staff_incoming",
        pin: "1234",
        deviceId: "device-001",
        idempotencyKey: "idem-key:shift:handover:in:login",
      });
    });
  });

  it("calls storeSession with new sessionId + incoming staffId after login", async () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(mockStoreSession).toHaveBeenCalledWith("session_new_123", "staff_incoming");
    });
  });

  it("advances to CountStep after successful login", async () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("count-step-stub")).toBeInTheDocument();
    });
    // PinSheet should be gone
    expect(screen.queryByTestId("pin-sheet")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // count → completeHandoverIn → navigate("/")
  // -------------------------------------------------------------------------

  it("calls completeHandoverIn with countChanged and navigates home after count submit", async () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("count-step-submit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("count-step-submit"));

    await waitFor(() => {
      expect(mockCompleteHandoverIn).toHaveBeenCalledTimes(1);
    });

    const call = mockCompleteHandoverIn.mock.calls[0][0] as {
      idempotencyKey: string;
      sessionId: string;
      steps: Array<{ key: string; label: string; type: string; confirmed_at: number }>;
      countChanged: number;
    };
    expect(call.idempotencyKey).toBe("idem-key:shift:handover:in:complete");
    expect(call.sessionId).toBe("session_new_123");
    expect(call.steps).toHaveLength(1);
    expect(call.steps[0].key).toBe("count");
    expect(call.steps[0].type).toBe("count");
    expect(call.countChanged).toBe(5); // from CountStep stub's onSubmitted(5)

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("shows error in PinSheet on failed login", async () => {
    mockLoginWithPin.mockRejectedValueOnce(new Error("INVALID_PIN"));
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("pin-sheet-error")).toBeInTheDocument();
    });
    // PinSheet should still be visible after error
    expect(screen.getByTestId("pin-sheet")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Idempotency key isolation — regression guard
  // -------------------------------------------------------------------------

  it("passes DIFFERENT idempotency keys to loginWithPin vs completeHandoverIn (collision guard)", async () => {
    renderRoute();
    // pick → pin
    fireEvent.click(screen.getByRole("button", { name: /budi \(incoming\)/i }));
    // submit PIN → triggers loginWithPin
    fireEvent.click(screen.getByTestId("pin-sheet-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("count-step-stub")).toBeInTheDocument();
    });

    // submit count → triggers completeHandoverIn
    fireEvent.click(screen.getByTestId("count-step-submit"));

    await waitFor(() => {
      expect(mockLoginWithPin).toHaveBeenCalledOnce();
      expect(mockCompleteHandoverIn).toHaveBeenCalledOnce();
    });

    const loginCallKey = mockLoginWithPin.mock.calls[0][0].idempotencyKey as string;
    const completeCallKey = mockCompleteHandoverIn.mock.calls[0][0].idempotencyKey as string;

    // Keys must be distinct — same key would replay the wrong cached result.
    expect(loginCallKey).not.toBe(completeCallKey);

    // Verify both are non-empty strings (not undefined / null).
    expect(loginCallKey).toBeTruthy();
    expect(completeCallKey).toBeTruthy();
  });
});
