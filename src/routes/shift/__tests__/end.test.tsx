import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Mocks — defined before any imports of the module under test
// ---------------------------------------------------------------------------

const mockEndOfDay = vi.fn();
const mockHandover = vi.fn();
const mockNavigate = vi.fn();
// clearSession is imported from useSession — we hoist the spy so the factory
// can reference it without a TDZ error (vi.mock factories are hoisted to the
// top of the file by vitest, before const declarations).
const { mockClearSession } = vi.hoisted(() => ({
  mockClearSession: vi.fn(),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "session_abc",
    staff: { _id: "staff_1", name: "Andi", role: "staff", must_change_pin: false },
  }),
  clearSession: mockClearSession,
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "idem-key-test",
  clearIntent: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// convex/react — useMutation dispatches to the right spy by function name.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useMutation: (fn: unknown) => {
      let name = "";
      try {
        name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]);
      } catch {
        name = "";
      }
      if (name.includes("endOfDay")) return mockEndOfDay;
      if (name.includes("handover")) return mockHandover;
      // auth.public.logout (used in close sign-off path)
      if (name.includes("logout")) return vi.fn().mockResolvedValue({});
      return vi.fn().mockResolvedValue({});
    },
    useQuery: () => [{ skuId: "sku1", name: "Dubai Cookie", on_hand: 10 }],
  };
});

// Stub CountStep: calls onSubmitted(5) when the submit button is tapped.
vi.mock("@/components/pos/CountStep", () => ({
  default: ({
    onSubmitted,
    submitLabel,
  }: {
    onSubmitted: (n: number) => void;
    submitLabel?: string;
  }) => (
    <div>
      <span data-testid="count-step-stub">CountStep</span>
      <button data-testid="count-step-submit" onClick={() => onSubmitted(5)}>
        {submitLabel ?? "Simpan hitungan"}
      </button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import ShiftEnd from "../end";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderRoute(entry = "/shift/end") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ShiftEnd />
    </MemoryRouter>,
  );
}

/** Advance one wizard step. For a count step, submit the count first. */
async function advanceStep(isCount: boolean, terminalName?: RegExp) {
  if (isCount) {
    fireEvent.click(screen.getByTestId("count-step-submit"));
    // Wait for ShiftWizard to set countReady=true.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: terminalName ?? /next/i }),
      ).toBeInTheDocument();
    });
  }
  if (terminalName) {
    fireEvent.click(screen.getByRole("button", { name: terminalName }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShiftEnd route (/shift/end)", () => {
  beforeEach(() => {
    mockEndOfDay.mockReset();
    mockEndOfDay.mockResolvedValue({ ok: true, durationMs: 7200000 }); // 2h
    mockHandover.mockReset();
    mockHandover.mockResolvedValue({ ok: true, durationMs: 3600000 }); // 1h
    mockNavigate.mockReset();
    mockClearSession.mockReset();
  });

  // -------------------------------------------------------------------------
  // Choice screen
  // -------------------------------------------------------------------------

  describe("choice screen", () => {
    it("renders both choice cards", () => {
      renderRoute();
      expect(screen.getByText(/close booth/i)).toBeInTheDocument();
      expect(screen.getByText(/handover/i)).toBeInTheDocument();
    });

    it("does not show a wizard initially", () => {
      renderRoute();
      // No "Back" button (wizard nav) should be present on choice screen.
      expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Deep-link via ?mode= (home's big shift-end buttons)
  // -------------------------------------------------------------------------

  describe("deep-link ?mode=", () => {
    it("?mode=handover enters the handover wizard directly (no choice screen)", () => {
      renderRoute("/shift/end?mode=handover");
      expect(screen.getByRole("heading", { name: /handover/i })).toBeInTheDocument();
      expect(screen.queryByText(/choose the type of shift close/i)).toBeNull();
    });

    it("?mode=close enters the close wizard directly (no choice screen)", () => {
      renderRoute("/shift/end?mode=close");
      expect(screen.getByRole("heading", { name: /close booth/i })).toBeInTheDocument();
      expect(screen.queryByText(/choose the type of shift close/i)).toBeNull();
    });

    it("an unknown mode falls back to the choice screen", () => {
      renderRoute("/shift/end?mode=bogus");
      expect(screen.getByText(/choose the type of shift close/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Close path (Tutup booth)
  // -------------------------------------------------------------------------

  describe("Tutup booth path", () => {
    async function enterCloseMode() {
      renderRoute();
      fireEvent.click(screen.getByRole("button", { name: /close booth/i }));
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /close booth/i })).toBeInTheDocument();
      });
    }

    it("enters close wizard on 'Close booth' click", async () => {
      await enterCloseMode();
      expect(screen.getByRole("button", { name: /^back$/i })).toBeInTheDocument();
    });

    it("shows 5 step labels in the rail", async () => {
      await enterCloseMode();
      expect(screen.getByText(/reminder/i)).toBeInTheDocument();
      expect(screen.getByText(/count stock/i)).toBeInTheDocument();
      expect(screen.getByText(/check supplies/i)).toBeInTheDocument();
      expect(screen.getByText(/tidy devices/i)).toBeInTheDocument();
      expect(screen.getAllByText(/lock lockers/i).length).toBeGreaterThanOrEqual(1);
    });

    it("walks all 5 close steps, calls endOfDay with closeCount, shows summary, then sign-off clears session + navigates /login", async () => {
      await enterCloseMode();

      // Step 1: instruction (Pengingat)
      await advanceStep(false);
      // Step 2: count step (Hitung stok)
      await waitFor(() =>
        expect(screen.getByTestId("count-step-stub")).toBeInTheDocument(),
      );
      await advanceStep(true, /next/i);
      // Step 3: instruction (Check supplies)
      await waitFor(() =>
        expect(screen.queryByTestId("count-step-stub")).toBeNull(),
      );
      await advanceStep(false);
      // Step 4: instruction (Rapikan perangkat)
      await advanceStep(false);
      // Step 5: last instruction → terminal button "Sign off — done for today"
      await advanceStep(false, /sign off/i);

      // endOfDay called once
      await waitFor(() => {
        expect(mockEndOfDay).toHaveBeenCalledTimes(1);
      });

      const call = mockEndOfDay.mock.calls[0][0] as {
        idempotencyKey: string;
        sessionId: string;
        steps: Array<{ key: string; type: string }>;
        closeCount?: number;
      };
      expect(call.idempotencyKey).toBe("idem-key-test");
      expect(call.sessionId).toBe("session_abc");
      expect(call.steps).toHaveLength(5);
      // closeCount from the count step (stub returns 5)
      expect(call.closeCount).toBe(5);

      // Summary screen appears with hours (exact 2h → "2j", fmtShiftDuration output)
      await waitFor(() => {
        expect(screen.getByText("2j")).toBeInTheDocument();
      });

      // Sign off button (final logout)
      const signOffBtn = screen.getByRole("button", { name: /done.*sign out|sign out/i });
      expect(signOffBtn).toBeInTheDocument();

      // Verify NO financial info appears
      expect(screen.queryByText(/rp/i)).not.toBeInTheDocument();

      fireEvent.click(signOffBtn);

      await waitFor(() => {
        expect(mockClearSession).toHaveBeenCalledTimes(1);
        expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Handover path (Serah terima)
  // -------------------------------------------------------------------------

  describe("Serah terima path", () => {
    async function enterHandoverMode() {
      renderRoute();
      fireEvent.click(screen.getByRole("button", { name: /handover/i }));
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /handover/i })).toBeInTheDocument();
      });
    }

    it("enters handover wizard on 'Handover' click", async () => {
      await enterHandoverMode();
      expect(screen.getByRole("button", { name: /^back$/i })).toBeInTheDocument();
    });

    it("shows 2 step labels in the handover rail", async () => {
      await enterHandoverMode();
      expect(screen.getByText(/count stock/i)).toBeInTheDocument();
      expect(screen.getByText(/check supplies/i)).toBeInTheDocument();
    });

    it("walks 2 handover steps, calls handover with closeCount, clears session, navigates /login", async () => {
      await enterHandoverMode();

      // Step 1: count (Count stock)
      await waitFor(() =>
        expect(screen.getByTestId("count-step-stub")).toBeInTheDocument(),
      );
      await advanceStep(true, /next/i);
      // Step 2: instruction → terminal "Handover"
      await waitFor(() =>
        expect(screen.queryByTestId("count-step-stub")).toBeNull(),
      );
      await advanceStep(false, /handover/i);

      await waitFor(() => {
        expect(mockHandover).toHaveBeenCalledTimes(1);
      });

      const call = mockHandover.mock.calls[0][0] as {
        idempotencyKey: string;
        sessionId: string;
        steps: Array<{ key: string; type: string }>;
        closeCount?: number;
      };
      expect(call.idempotencyKey).toBe("idem-key-test");
      expect(call.sessionId).toBe("session_abc");
      expect(call.steps).toHaveLength(2);
      expect(call.closeCount).toBe(5);

      // clearSession is called; incoming staffer logs in fresh at /login
      await waitFor(() => {
        expect(mockClearSession).toHaveBeenCalledTimes(1);
        expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true });
      });
    });
  });
});
