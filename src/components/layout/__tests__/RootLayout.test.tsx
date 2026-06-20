import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

// ---------------------------------------------------------------------------
// Hoist mock factories — must reference these before module init.
// ---------------------------------------------------------------------------
const { mockUseSession, mockUseDeviceId, mockUseQuery, mockUseBoothState } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockUseDeviceId: vi.fn(() => "dev-001"),
  mockUseQuery: vi.fn(() => true), // deviceRegistered = true by default
  mockUseBoothState: vi.fn(() => undefined), // undefined = loading by default
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
vi.mock("@/hooks/useBoothState", () => ({
  useBoothState: mockUseBoothState,
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
          <Route path="/shift/handover" element={<div data-testid="shift-handover-page">ShiftHandover</div>} />
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

describe("RootLayout — booth-state gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDeviceId.mockReturnValue("dev-001");
    mockUseQuery.mockReturnValue(true); // deviceRegistered = true
    mockUseSession.mockReturnValue(ACTIVE_SESSION);
    mockUseBoothState.mockReturnValue(undefined); // loading by default
  });

  it("renders children normally when boothState is undefined (still loading)", () => {
    mockUseBoothState.mockReturnValue(undefined);
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("renders children normally when boothState.state is 'open'", () => {
    mockUseBoothState.mockReturnValue({ state: "open", staffId: "stf_test_001", staffName: "Budi", staleAutoclose: false });
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("renders children normally when boothState.state is 'locked'", () => {
    mockUseBoothState.mockReturnValue({ state: "locked", staffId: null, staffName: null, staleAutoclose: false });
    renderAt("/");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });

  it("redirects to /shift/start when boothState.state is 'closed' and path is '/'", () => {
    mockUseBoothState.mockReturnValue({ state: "closed", staffId: null, staffName: null, staleAutoclose: false });
    renderAt("/");
    expect(screen.getByTestId("shift-start-page")).toBeInTheDocument();
    expect(screen.queryByTestId("home-page")).toBeNull();
  });

  it("does NOT redirect when already on /shift/start and boothState.state is 'closed' (loop-safety)", () => {
    mockUseBoothState.mockReturnValue({ state: "closed", staffId: null, staffName: null, staleAutoclose: false });
    renderAt("/shift/start");
    expect(screen.getByTestId("shift-start-page")).toBeInTheDocument();
  });

  it("redirects to /shift/handover when boothState.state is 'handover_pending' and path is '/'", () => {
    mockUseBoothState.mockReturnValue({ state: "handover_pending", staffId: "stf_test_001", staffName: "Budi", staleAutoclose: false });
    renderAt("/");
    expect(screen.getByTestId("shift-handover-page")).toBeInTheDocument();
    expect(screen.queryByTestId("home-page")).toBeNull();
  });

  it("does NOT redirect when already on /shift/handover and boothState.state is 'handover_pending' (loop-safety)", () => {
    mockUseBoothState.mockReturnValue({ state: "handover_pending", staffId: "stf_test_001", staffName: "Budi", staleAutoclose: false });
    renderAt("/shift/handover");
    expect(screen.getByTestId("shift-handover-page")).toBeInTheDocument();
  });

  it("does NOT apply booth-state redirect when there is no active session", () => {
    mockUseSession.mockReturnValue(NO_SESSION);
    mockUseBoothState.mockReturnValue({ state: "closed", staffId: null, staffName: null, staleAutoclose: false });
    // No active session → session gate redirects to /login before booth gate fires
    renderAt("/");
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-start-page")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Handover-in no-session exemption (prod deadlock fix 2026-06-20).
  //
  // handoverOut ENDS the outgoing session, so during handover_pending the device
  // has NO active session. The incoming staff authenticates INSIDE /shift/handover
  // (loginWithPin). If the session gate redirects /shift/handover → /login, and
  // /login redirects handover_pending → /shift/handover, the two bounce forever
  // (getActiveStaff re-fires on every remount). /shift/handover must therefore be
  // reachable session-less WHEN the booth is genuinely handover_pending.
  // ---------------------------------------------------------------------------

  it("renders /shift/handover session-less when boothState is 'handover_pending' (incoming-staff login lives inside this screen)", () => {
    mockUseSession.mockReturnValue(NO_SESSION);
    mockUseBoothState.mockReturnValue({ state: "handover_pending", staffId: "stf_test_001", staffName: "Budi", staleAutoclose: false });
    renderAt("/shift/handover");
    expect(screen.getByTestId("shift-handover-page")).toBeInTheDocument();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  it("still redirects /shift/handover → /login session-less when booth is NOT handover_pending (stale/manual visit)", () => {
    mockUseSession.mockReturnValue(NO_SESSION);
    mockUseBoothState.mockReturnValue({ state: "open", staffId: "stf_test_001", staffName: "Budi", staleAutoclose: false });
    renderAt("/shift/handover");
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-handover-page")).toBeNull();
  });

  it("holds loading (no /login bounce) on session-less /shift/handover while boothState is undefined", () => {
    // Cold PWA relaunch: boothState not yet resolved. We must NOT redirect to
    // /login (which re-fires getActiveStaff and bounces) before we know whether
    // the booth is genuinely handover_pending — render the fallback instead (I-1).
    mockUseSession.mockReturnValue(NO_SESSION);
    mockUseBoothState.mockReturnValue(undefined);
    renderAt("/shift/handover");
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(screen.queryByTestId("shift-handover-page")).toBeNull();
  });
});
