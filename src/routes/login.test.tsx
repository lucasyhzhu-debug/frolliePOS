/**
 * Tests for LoginRoute.
 *
 * Mock strategy (follows charge.test.tsx / telegram-chats.test.tsx pattern):
 *   - convex/react: useQuery controlled via vi.fn(); useAction returns stub.
 *   - sonner: toast.error stub so we can assert "no toast" in fallback tests.
 *   - ConnDot: stubbed to avoid IDB/deviceId side-effects.
 *   - useLoginContext: stubbed to control outlet/holder state in navigation tests.
 *
 * The component renders two useQuery calls per tree:
 *   Call 0 = api.auth.public.listStaffForDevice  (staff list, keyed by deviceId)
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

const { mockLoginAction } = vi.hoisted(() => ({
  mockLoginAction: vi.fn().mockResolvedValue({ sessionId: "kn7ses000000000000000000000" }),
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

vi.mock("@/hooks/useLoginContext", () => ({
  useLoginContext: vi.fn(() => undefined),
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
 * Wire useQuery to return the staff list for listStaffForDevice and undefined for
 * getRecentPinResetForStaff. Discriminates by ARGS (robust across re-renders),
 * not call-order — a render-count shift would otherwise mis-slot the queries.
 *   listStaffForDevice         → args { deviceId }  → staff rows
 *   getRecentPinResetForStaff  → args { staffId }   → undefined (no denial)
 */
function mockStaff(rows: StaffRow[]) {
  (useQueryMock as Mock).mockImplementation((_api: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    if (args && typeof args === "object" && "staffId" in (args as object)) return undefined;
    return rows; // listStaffForDevice (args { deviceId })
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
  // Default: useAction returns the login stub (covers both loginWithPin + managerOverride slots)
  (convexReact.useAction as Mock).mockReturnValue(mockLoginAction);
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
          <Route path="/shift/begin" element={<div data-testid="shift-begin-page" />} />
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

// ─── loginContext navigation fork tests ───────────────────────────────────────

describe("Login route — outlet state navigation fork", () => {
  it("outlet closed → after login navigates to /shift/start", async () => {
    const { useLoginContext } = await import("@/hooks/useLoginContext");
    vi.mocked(useLoginContext).mockReturnValue({
      outletOpen: false,
      holderStaffId: null,
      holderName: null,
    });
    mockStaff([SARI]);
    // Pre-stage SARI so we're at PIN entry immediately
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    // Wait for PIN entry stage
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sari/i })).toBeInTheDocument(),
    );

    typePin("1111");

    await waitFor(() =>
      expect(screen.getByTestId("shift-start-page")).toBeInTheDocument(),
    );
  });

  it("outlet open, holder === me → after login navigates to /", async () => {
    const { useLoginContext } = await import("@/hooks/useLoginContext");
    vi.mocked(useLoginContext).mockReturnValue({
      outletOpen: true,
      holderStaffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      holderName: "Lucas",
    });
    mockStaff([LUCAS, SARI]);
    // LUCAS is the holder and the last staff — pre-stages normally.
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id);

    renderLogin();

    // Pre-stage fires because holderStaffId === LUCAS._id === lastId
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );

    typePin("1111");

    await waitFor(() =>
      expect(screen.getByTestId("home-page")).toBeInTheDocument(),
    );
  });

  it("outlet open, no holder → after login navigates to /shift/begin", async () => {
    const { useLoginContext } = await import("@/hooks/useLoginContext");
    vi.mocked(useLoginContext).mockReturnValue({
      outletOpen: true,
      holderStaffId: null,
      holderName: null,
    });
    mockStaff([SARI]);
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sari/i })).toBeInTheDocument(),
    );

    typePin("1111");

    await waitFor(() =>
      expect(screen.getByTestId("shift-begin-page")).toBeInTheDocument(),
    );
  });

  it("outlet open, holder is different staffer → block UI shown, login NOT called", async () => {
    const { useLoginContext } = await import("@/hooks/useLoginContext");
    // LUCAS holds the shift; SARI tries to log in.
    vi.mocked(useLoginContext).mockReturnValue({
      outletOpen: true,
      holderStaffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      holderName: "Lucas",
    });
    // Only SARI in the staff list.
    mockStaff([SARI]);
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    // Pre-stage guard fires: outletOpen=true, holderStaffId=LUCAS._id !== SARI._id
    // → falls back to list view.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );

    // SARI taps her name → blocked.
    fireEvent.click(screen.getByText("Sari"));

    // Block message referencing the holder appears.
    await waitFor(() =>
      expect(screen.getByText(/lucas/i)).toBeInTheDocument(),
    );
    // Manager override button is present.
    expect(screen.getByRole("button", { name: /manager override/i })).toBeInTheDocument();
    // Login action must NOT have been called.
    expect(mockLoginAction).not.toHaveBeenCalled();
  });

  it("outlet open, holder is different staffer → pre-stage skipped, list shown first", async () => {
    const { useLoginContext } = await import("@/hooks/useLoginContext");
    vi.mocked(useLoginContext).mockReturnValue({
      outletOpen: true,
      holderStaffId: LUCAS._id as import("../../convex/_generated/dataModel").Id<"staff">,
      holderName: "Lucas",
    });
    // Only SARI in the active list, stored as last staff.
    mockStaff([SARI]);
    localStorage.setItem(LAST_STAFF_KEY, SARI._id);

    renderLogin();

    // Pre-stage guard fires — SARI is NOT the holder, so list is shown instead
    // of jumping straight to PIN.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: /sari/i })).toBeNull();
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
    // Default useAction (mockLoginAction) resolves a sessionId; ctx undefined → /shift/begin
    // (outletOpen===undefined → holderStaffId===null branch), but LUCAS has default ctx undefined
    // so both branches are falsy → target stays "/".
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

// ─── PIN-reset denial toast: remount dedup (#11) ─────────────────────────────

describe("PIN reset denial toast (remount dedup)", () => {
  // Discriminate queries by ARGS (robust across re-renders), not call-order:
  //   listStaffForDevice         → args { deviceId }  → staff list
  //   getRecentPinResetForStaff  → args { staffId }   → denied object
  function wireDenied() {
    (useQueryMock as Mock).mockImplementation((_api: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      if (args && typeof args === "object" && "staffId" in (args as object)) {
        return {
          requestId: "reset-req-1",
          status: "denied",
          denied_by_manager_name: "Sari",
          denied_by_manager_code: "S-02",
          deny_reason: "not you",
        };
      }
      return [LUCAS, SARI]; // listStaffForDevice
    });
  }

  it("fires exactly once across a remount", async () => {
    localStorage.setItem(LAST_STAFF_KEY, LUCAS._id); // pre-stage into PIN view
    wireDenied();
    const { toast } = await import("sonner");

    const first = renderLogin();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    first.unmount();

    // Remount within the window (no localStorage.clear between — beforeEach
    // cleared once at test start). The denial query returns denied again.
    renderLogin();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /lucas/i })).toBeInTheDocument(),
    );
    expect(toast.error).toHaveBeenCalledTimes(1); // still once — not twice
  });
});
