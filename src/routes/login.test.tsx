/**
 * Tests for LoginRoute.
 *
 * Mock strategy (follows charge.test.tsx / telegram-chats.test.tsx pattern):
 *   - convex/react: useQuery controlled via vi.fn(); useAction returns stub.
 *   - sonner: toast.error stub so we can assert "no toast" in fallback tests.
 *   - ConnDot: stubbed to avoid IDB/deviceId side-effects.
 *   - useBoothState: stubbed to control booth state in navigation tests.
 *
 * The component renders two useQuery calls per tree:
 *   Call 0 = api.auth.public.getActiveStaff   (staff list)
 *   Call 1 = api.approvals.public.getRecentPinResetForStaff  ("skip" while list view)
 *
 * Tests that exercise the pre-stage mount-effect set localStorage before render
 * and reset it in beforeEach via localStorage.clear().
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderWithLocale as render, screen, waitFor, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import LoginRoute from "./login";
import { LAST_STAFF_KEY } from "@/lib/storage-keys";

// ─── module mocks (hoisted by Vite) ──────────────────────────────────────────

const { mockLoginAction, mockRecordResume } = vi.hoisted(() => ({
  mockLoginAction: vi.fn().mockResolvedValue({ sessionId: "kn7ses000000000000000000000" }),
  mockRecordResume: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useAction: vi.fn(() => undefined),
    useMutation: vi.fn(() => undefined),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/layout/ConnDot", () => ({
  ConnDot: () => null,
}));

vi.mock("@/hooks/useBoothState", () => ({
  useBoothState: vi.fn(() => undefined),
}));

vi.mock("@/hooks/useDeviceId", () => ({
  useDeviceId: vi.fn(() => "test-device-id"),
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idem-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
  storeSession: vi.fn(),
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

type StaffRow = { _id: string; name: string; role: "staff" | "manager" };

const LUCAS: StaffRow = {
  _id: "kn7lucas000000000000000000000",
  name: "Lucas",
  role: "manager",
};

const SARI: StaffRow = {
  _id: "kn7sari0000000000000000000000",
  name: "Sari",
  role: "staff",
};

/**
 * Wire useQuery to return the staff list for getActiveStaff and undefined for
 * getRecentPinResetForStaff. Discriminates by ARGS (robust across re-renders),
 * not call-order — a render-count shift would otherwise mis-slot the queries.
 *   getActiveStaff            → args {}            → staff rows
 *   getRecentPinResetForStaff → args { staffId }   → undefined (no denial)
 */
function mockStaff(rows: StaffRow[]) {
  (useQueryMock as Mock).mockImplementation((_api: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    if (args && typeof args === "object" && "staffId" in (args as object)) return undefined;
    return rows; // getActiveStaff (args {})
  });
}

// Grab the mock reference after hoisting resolves.
// We use a lazy accessor so the reference is always fresh.
let useQueryMock: unknown;
beforeEach(async () => {
  const convexReact = await import("convex/react");
  useQueryMock = convexReact.useQuery;
  (useQueryMock as Mock).mockReset();
  localStorage.clear();
  vi.clearAllMocks();
  // Default: useAction returns the login stub, useMutation returns recordResume stub
  (convexReact.useAction as Mock).mockReturnValue(mockLoginAction);
  (convexReact.useMutation as Mock).mockReturnValue(mockRecordResume);
});

function renderLogin() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/" element={<div data-testid="home-page" />} />
          <Route path="/shift/start" element={<div data-testid="shift-start-page" />} />
          <Route path="/shift/handover" element={<div data-testid="shift-handover-page" />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

/** Click the on-screen keypad digits (aria-label "Digit N" in EN locale). */
function typePin(pin: string) {
  for (const d of pin) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`digit ${d}`, "i") }));
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Login route", () => {
  it("renders the staff list heading", async () => {
    // useQuery returns undefined (loading) → list stage, heading shows
    (useQueryMock as Mock).mockReturnValue(undefined);
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );
  });

  it("pre-stages to PIN if last-staff is in active list", async () => {
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id);
    mockStaff([LUCAS, SARI]);
    renderLogin();
    // Should skip "Who's working?" and show Lucas's name as the heading.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: /who's working/i })).toBeNull();
  });

  it("silently falls back to list if last-staff is NOT in active list", async () => {
    localStorage.setItem(LAST_STAFF_KEY, "kn7deactivated00000000000000");
    // Active list does NOT contain the stored id.
    mockStaff([SARI]);
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );
    // No error toast should have fired.
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows list view when no last-staff key", async () => {
    localStorage.removeItem(LAST_STAFF_KEY); // explicit — clear() already ran in beforeEach
    mockStaff([LUCAS, SARI]);
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );
  });
});

// ─── booth-state navigation fork tests ───────────────────────────────────────

describe("Login route — booth state navigation fork", () => {
  it("booth closed → after login navigates to /shift/start", async () => {
    const { useBoothState } = await import("@/hooks/useBoothState");
    vi.mocked(useBoothState).mockReturnValue({
      state: "closed",
      staffId: null,
      staffName: null,
      staleAutoclose: false,
    });
    mockStaff([SARI]);
    // Pre-stage SARI so we're at PIN entry immediately
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    // Wait for PIN entry stage
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sari/i })).toBeInTheDocument(),
    );

    // Submit PIN via buttons
    const buttons = screen.getAllByRole("button");
    const oneBtn = buttons.find((b) => b.textContent === "1");
    if (oneBtn) {
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
    }

    await waitFor(() =>
      expect(screen.getByTestId("shift-start-page")).toBeInTheDocument(),
    );
  });

  it("booth locked with matching staffId → pre-stages only that staff, calls recordResume after login, navigates /", async () => {
    const { useBoothState } = await import("@/hooks/useBoothState");
    vi.mocked(useBoothState).mockReturnValue({
      state: "locked",
      staffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      staffName: "Lucas",
      staleAutoclose: false,
    });
    mockStaff([LUCAS, SARI]);
    // Set last staff so the pre-stage effect has something to match against.
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id);

    renderLogin();

    // Pre-stage should fire for LUCAS only (booth.locked and staffId matches)
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );

    // Submit PIN
    const buttons = screen.getAllByRole("button");
    const oneBtn = buttons.find((b) => b.textContent === "1");
    if (oneBtn) {
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
    }

    await waitFor(() => expect(mockRecordResume).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("home-page")).toBeInTheDocument(),
    );
  });

  it("booth handover_pending → immediately redirects to /shift/handover before login", async () => {
    const { useBoothState } = await import("@/hooks/useBoothState");
    vi.mocked(useBoothState).mockReturnValue({
      state: "handover_pending",
      staffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      staffName: "Lucas",
      staleAutoclose: false,
    });
    mockStaff([LUCAS, SARI]);

    renderLogin();

    await waitFor(() =>
      expect(screen.getByTestId("shift-handover-page")).toBeInTheDocument(),
    );
    // Login action must NOT have been called — redirect fires before any PIN entry.
    expect(mockLoginAction).not.toHaveBeenCalled();
  });

  it("booth locked but DIFFERENT staff logs in → recordResume NOT called, navigates /", async () => {
    const { useBoothState } = await import("@/hooks/useBoothState");
    // Booth is locked for LUCAS (staffId=A), but SARI (staffId=B) logs in.
    vi.mocked(useBoothState).mockReturnValue({
      state: "locked",
      staffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      staffName: "Lucas",
      staleAutoclose: false,
    });
    // Only SARI in the active list — LUCAS was deactivated or not pre-staged.
    mockStaff([SARI]);
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    // Pre-stage should NOT fire for SARI because locked.staffId !== SARI._id.
    // The list view shows instead.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );

    // Manually pick SARI from the list.
    fireEvent.click(screen.getByText("Sari"));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sari/i })).toBeInTheDocument(),
    );

    // Submit PIN via numeric keypad
    const buttons = screen.getAllByRole("button");
    const oneBtn = buttons.find((b) => b.textContent === "1");
    if (oneBtn) {
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
    }

    await waitFor(() =>
      expect(screen.getByTestId("home-page")).toBeInTheDocument(),
    );
    // Guard must block recordResume — SARI is not the locked staff.
    expect(mockRecordResume).not.toHaveBeenCalled();
  });

  it("booth open → after login navigates to / (normal)", async () => {
    const { useBoothState } = await import("@/hooks/useBoothState");
    vi.mocked(useBoothState).mockReturnValue({
      state: "open",
      staffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      staffName: "Lucas",
      staleAutoclose: false,
    });
    mockStaff([SARI]);
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sari/i })).toBeInTheDocument(),
    );

    // Submit PIN
    const buttons = screen.getAllByRole("button");
    const oneBtn = buttons.find((b) => b.textContent === "1");
    if (oneBtn) {
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
    }

    await waitFor(() =>
      expect(screen.getByTestId("home-page")).toBeInTheDocument(),
    );
    expect(mockRecordResume).not.toHaveBeenCalled();
  });
});

// ─── PIN-entry feedback (inline messages, no toast) ──────────────────────────

describe("Login PIN feedback", () => {
  it("renders INVALID_PIN inline (role=alert) and fires NO toast", async () => {
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id);
    mockStaff([LUCAS, SARI]);
    const { useAction } = await import("convex/react");
    (useAction as unknown as Mock).mockReturnValue(
      vi.fn().mockRejectedValue(new Error("INVALID_PIN")),
    );
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );
    typePin("1234");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/wrong pin/i));
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("renders LOCKED_OUT as a persistent inline banner", async () => {
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id);
    mockStaff([LUCAS, SARI]);
    const { useAction } = await import("convex/react");
    (useAction as unknown as Mock).mockReturnValue(
      vi.fn().mockRejectedValue(new Error("LOCKED_OUT:60")),
    );
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );
    typePin("1234");
    // Inline banner shows the locked-out copy with the interpolated seconds.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/locked out/i),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/60/);
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows green Welcome (role=status) then navigates home on success", async () => {
    // Default useAction (mockLoginAction) resolves a sessionId; booth undefined → home.
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id);
    mockStaff([LUCAS, SARI]);
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );
    typePin("1234");
    // Green success message appears (FieldMessage tone=success → role=status).
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/welcome/i));
    // …then navigates home after the ~200ms tick (inside waitFor's 1s budget).
    await waitFor(() =>
      expect(screen.getByTestId("home-page")).toBeInTheDocument(),
    );
  });
});
