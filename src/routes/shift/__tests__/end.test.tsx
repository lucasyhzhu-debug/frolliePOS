import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Mocks — defined before any imports of the module under test
// ---------------------------------------------------------------------------

const mockEndOfDaySignOff = vi.fn();
const mockHandoverOut = vi.fn();
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
      if (name.includes("endOfDaySignOff")) return mockEndOfDaySignOff;
      if (name.includes("handoverOut")) return mockHandoverOut;
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

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/shift/end"]}>
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
        screen.queryByRole("button", { name: terminalName ?? /lanjut/i }),
      ).toBeInTheDocument();
    });
  }
  if (terminalName) {
    fireEvent.click(screen.getByRole("button", { name: terminalName }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: /lanjut/i }));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShiftEnd route (/shift/end)", () => {
  beforeEach(() => {
    mockEndOfDaySignOff.mockReset();
    mockEndOfDaySignOff.mockResolvedValue({ ok: true, durationMs: 7200000 }); // 2h
    mockHandoverOut.mockReset();
    mockHandoverOut.mockResolvedValue({ ok: true, durationMs: 3600000 }); // 1h
    mockNavigate.mockReset();
    mockClearSession.mockReset();
  });

  // -------------------------------------------------------------------------
  // Choice screen
  // -------------------------------------------------------------------------

  describe("choice screen", () => {
    it("renders both choice cards", () => {
      renderRoute();
      expect(screen.getByText(/tutup booth/i)).toBeInTheDocument();
      expect(screen.getByText(/serah terima/i)).toBeInTheDocument();
    });

    it("does not show a wizard initially", () => {
      renderRoute();
      // No "Kembali" button (wizard nav) should be present on choice screen.
      expect(screen.queryByRole("button", { name: /kembali/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Close path (Tutup booth)
  // -------------------------------------------------------------------------

  describe("Tutup booth path", () => {
    async function enterCloseMode() {
      renderRoute();
      fireEvent.click(screen.getByRole("button", { name: /tutup booth/i }));
      // The wizard should now be rendered.
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /tutup booth/i })).toBeInTheDocument();
      });
    }

    it("enters close wizard on 'Tutup booth' click", async () => {
      await enterCloseMode();
      // Back button present (wizard rendered)
      expect(screen.getByRole("button", { name: /kembali/i })).toBeInTheDocument();
    });

    it("shows 5 step labels in the rail", async () => {
      await enterCloseMode();
      // Steps: pengingat (reminder), hitung stok, cek perlengkapan, rapikan perangkat, kunci loker
      // (label substrings from the spec §3B)
      expect(screen.getByText(/pengingat/i)).toBeInTheDocument();
      expect(screen.getByText(/hitung stok/i)).toBeInTheDocument();
      expect(screen.getByText(/cek perlengkapan/i)).toBeInTheDocument();
      expect(screen.getByText(/rapikan perangkat/i)).toBeInTheDocument();
      // "Kunci loker" appears in both the rail AND in body copy ("kunci loker" mentioned
      // in step 1 reminder text) — use getAllByText to allow multiple matches.
      expect(screen.getAllByText(/kunci loker/i).length).toBeGreaterThanOrEqual(1);
    });

    it("walks all 5 close steps, calls endOfDaySignOff, shows summary, then sign-off clears session + navigates /login", async () => {
      await enterCloseMode();

      // Step 1: instruction (Pengingat)
      await advanceStep(false);
      // Step 2: count step (Hitung stok)
      await waitFor(() =>
        expect(screen.getByTestId("count-step-stub")).toBeInTheDocument(),
      );
      await advanceStep(true, /lanjut/i);
      // Step 3: instruction (Cek perlengkapan)
      await waitFor(() =>
        expect(screen.queryByTestId("count-step-stub")).toBeNull(),
      );
      await advanceStep(false);
      // Step 4: instruction (Rapikan perangkat)
      await advanceStep(false);
      // Step 5: last instruction → terminal button "Sign off — selesai hari ini"
      await advanceStep(false, /sign off/i);

      // endOfDaySignOff called once
      await waitFor(() => {
        expect(mockEndOfDaySignOff).toHaveBeenCalledTimes(1);
      });

      const call = mockEndOfDaySignOff.mock.calls[0][0] as {
        idempotencyKey: string;
        sessionId: string;
        steps: Array<{ key: string; type: string }>;
        countChanged?: number;
      };
      expect(call.idempotencyKey).toBe("idem-key-test");
      expect(call.sessionId).toBe("session_abc");
      expect(call.steps).toHaveLength(5);
      // countChanged from the count step (stub returns 5)
      expect(call.countChanged).toBe(5);

      // Summary screen appears with hours (2h exact -> "2j", canonical 3-branch logic)
      await waitFor(() => {
        // exact 2h -> no minutes part: "2j" (canonical: hours>0 && minutes==0 -> "Xj")
        expect(screen.getByText("2j")).toBeInTheDocument();
      });

      // Sign off button (final logout)
      const signOffBtn = screen.getByRole("button", { name: /selesai/i });
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
      fireEvent.click(screen.getByRole("button", { name: /serah terima/i }));
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /serah terima/i })).toBeInTheDocument();
      });
    }

    it("enters handover wizard on 'Serah terima' click", async () => {
      await enterHandoverMode();
      expect(screen.getByRole("button", { name: /kembali/i })).toBeInTheDocument();
    });

    it("shows 2 step labels in the handover rail", async () => {
      await enterHandoverMode();
      expect(screen.getByText(/hitung stok/i)).toBeInTheDocument();
      expect(screen.getByText(/cek perlengkapan/i)).toBeInTheDocument();
    });

    it("walks 2 handover steps, calls handoverOut, navigates /shift/handover", async () => {
      await enterHandoverMode();

      // Step 1: count (Hitung stok)
      await waitFor(() =>
        expect(screen.getByTestId("count-step-stub")).toBeInTheDocument(),
      );
      await advanceStep(true, /lanjut/i);
      // Step 2: instruction → terminal "Serah terima"
      await waitFor(() =>
        expect(screen.queryByTestId("count-step-stub")).toBeNull(),
      );
      await advanceStep(false, /serah terima/i);

      await waitFor(() => {
        expect(mockHandoverOut).toHaveBeenCalledTimes(1);
      });

      const call = mockHandoverOut.mock.calls[0][0] as {
        idempotencyKey: string;
        sessionId: string;
        steps: Array<{ key: string; type: string }>;
        countChanged?: number;
      };
      expect(call.idempotencyKey).toBe("idem-key-test");
      expect(call.sessionId).toBe("session_abc");
      expect(call.steps).toHaveLength(2);
      expect(call.countChanged).toBe(5);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith("/shift/handover");
      });
    });
  });
});
