import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

// ---------------------------------------------------------------------------
// Hoist mock factories — must reference these before module init.
// ---------------------------------------------------------------------------
const { mockUseSession, mockUseDeviceId, mockUseQuery, mockUseLoginContext } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockUseDeviceId: vi.fn(() => "dev-001"),
  // useQuery is called for multiple queries: isDeviceRegistered + isDeviceOutlet.
  // Default: deviceRegistered=true, isDeviceOutlet=true (outlet device by default).
  mockUseQuery: vi.fn((query: unknown) => {
    // Distinguish by the function reference name. Convex generated functions
    // are objects; their toString() includes the path.
    const q = String(query);
    if (q.includes("isDeviceOutlet")) return true;
    return true; // isDeviceRegistered default
  }),
  mockUseLoginContext: vi.fn(() => undefined), // undefined = loading by default
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: mockUseSession,
}));
vi.mock("@/hooks/useDeviceId", () => ({
  useDeviceId: mockUseDeviceId,
}));
vi.mock("@/hooks/useStartupReconciliation", () => ({
  useStartupReconciliation: vi.fn(),
}));
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useQuery: mockUseQuery };
});
vi.mock("@/hooks/useLoginContext", () => ({
  useLoginContext: mockUseLoginContext,
}));
vi.mock("@/components/pos/PrinterProvider", () => ({
  PrinterProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// RouteFallback (rendered by the loading-hold branch) calls useT — stub it so the
// test tree doesn't need a LocaleProvider wrapper.
vi.mock("@/lib/i18n", () => ({
  useT: () => (key: string) => key,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { RootLayout } from "../RootLayout";

// ---------------------------------------------------------------------------
// Shared session states
// ---------------------------------------------------------------------------

const ACTIVE_SESSION = {
  status: "active" as const,
  sessionId: "ses_test_001" as import("../../../../convex/_generated/dataModel").Id<"staff_sessions">,
  staff: {
    _id: "stf_test_001" as import("../../../../convex/_generated/dataModel").Id<"staff">,
    name: "Budi",
    role: "staff" as const,
    must_change_pin: false,
    locale: "en" as const,
    outlet_id: undefined,
    outlet_label: undefined,
  },
};

const NO_SESSION = { status: "none" as const, sessionId: null, staff: null };

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RootLayout />}>
          <Route path="/" element={<div data-testid="home-page">Home</div>} />
          <Route path="/shift/start" element={<div data-testid="shift-start-page">ShiftStart</div>} />
          <Route path="/shift/begin" element={<div data-testid="shift-begin-page">ShiftBegin</div>} />
          <Route path="/account" element={<div data-testid="account-page">Account</div>} />
          <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        </Route>
        <Route path="/activate" element={<div data-testid="activate-page">Activate</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RootLayout — two-level SOP gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDeviceId.mockReturnValue("dev-001");
    // Default: deviceRegistered=true, isDeviceOutlet=true.
    mockUseQuery.mockReturnValue(true);
    mockUseSession.mockReturnValue(ACTIVE_SESSION);
    mockUseLoginContext.mockReturnValue(undefined); // loading by default
  });

  it("renders children normally when loginContext is undefined (still loading)", () => {
    mockUseLoginContext.mockReturnValue(undefined);
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("renders children normally when outletOpen is true", () => {
    mockUseLoginContext.mockReturnValue({ outletOpen: true, holderStaffId: null, holderName: null });
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("renders children normally when outletOpen is true and there is a holder", () => {
    mockUseLoginContext.mockReturnValue({ outletOpen: true, holderStaffId: "stf_test_001", holderName: "Budi" });
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("redirects to /shift/start when outletOpen is false and path is '/'", () => {
    mockUseLoginContext.mockReturnValue({ outletOpen: false, holderStaffId: null, holderName: null });
    renderAt("/");
    expect(screen.getByTestId("shift-start-page")).toBeInTheDocument();
    expect(screen.queryByTestId("home-page")).toBeNull();
  });

  it("does NOT force /shift/start on a VIEWER (non-outlet) device even when outletOpen is false", () => {
    // A manager opens the POS on their PC (a viewer device): isDeviceOutlet=false.
    // The SOP gate must skip so they land on the menu / transactions, not the SOP.
    // Both queries go through mockUseQuery; return false only for isDeviceOutlet.
    // We use a call-count approach: isDeviceRegistered is called first (returns true),
    // isDeviceOutlet is called second (returns false for this test).
    let callCount = 0;
    mockUseQuery.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? true : false; // 1st call = registered, 2nd = not outlet
    });
    mockUseLoginContext.mockReturnValue({ outletOpen: false, holderStaffId: null, holderName: null });
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-start-page")).toBeNull();
  });

  it("does NOT force /shift/start while isDeviceOutlet is still loading (undefined ⇒ don't trap a viewer)", () => {
    // isDeviceOutlet undefined → defaults to false in RootLayout (safe default).
    let callCount = 0;
    mockUseQuery.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? true : undefined; // registered=true, outlet=undefined
    });
    mockUseLoginContext.mockReturnValue({ outletOpen: false, holderStaffId: null, holderName: null });
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-start-page")).toBeNull();
  });

  it("does NOT redirect when already on /shift/start and outletOpen is false (loop-safety)", () => {
    mockUseLoginContext.mockReturnValue({ outletOpen: false, holderStaffId: null, holderName: null });
    renderAt("/shift/start");
    expect(screen.getByTestId("shift-start-page")).toBeInTheDocument();
  });

  it("does NOT apply booth-state redirect when there is no active session", () => {
    mockUseSession.mockReturnValue(NO_SESSION);
    mockUseLoginContext.mockReturnValue({ outletOpen: false, holderStaffId: null, holderName: null });
    // No active session → session gate redirects to /login before SOP gate fires
    renderAt("/");
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-start-page")).toBeNull();
  });

  it("no-session → /login redirect (no handover exemption needed anymore)", () => {
    mockUseSession.mockReturnValue(NO_SESSION);
    mockUseLoginContext.mockReturnValue({ outletOpen: true, holderStaffId: null, holderName: null });
    renderAt("/");
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
  });

  it("renders /shift/begin normally for an active session (session-FULL incoming-count route)", () => {
    mockUseLoginContext.mockReturnValue({ outletOpen: true, holderStaffId: null, holderName: null });
    renderAt("/shift/begin");
    expect(screen.getByTestId("shift-begin-page")).toBeInTheDocument();
  });
});
