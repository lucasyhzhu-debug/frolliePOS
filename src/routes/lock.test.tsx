import { describe, test, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import Lock from "./lock";
import { LAST_STAFF_KEY } from "@/lib/storage-keys";

// ─── module mocks ─────────────────────────────────────────────────────────────

// vi.hoisted so these refs are available inside the hoisted vi.mock factories.
const { mockLogout, mockClearSession, mockLockShift, mockManagerTakeover, mockStoreSession } = vi.hoisted(() => ({
  mockLogout: vi.fn().mockResolvedValue(undefined),
  mockClearSession: vi.fn(),
  mockLockShift: vi.fn().mockResolvedValue({ ok: true }),
  mockManagerTakeover: vi.fn().mockResolvedValue({ sessionId: "kn7ses_mgr_000000000000000" }),
  mockStoreSession: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useMutation: vi.fn(() => mockLogout),
    useAction: vi.fn(() => mockManagerTakeover),
  };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
  clearSession: mockClearSession,
  storeSession: mockStoreSession,
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idem-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/layout/ConnDot", () => ({
  ConnDot: () => null,
}));

// ─── imported mocks ───────────────────────────────────────────────────────────

import * as useSessionModule from "@/hooks/useSession";

// ─── helpers ──────────────────────────────────────────────────────────────────

const ACTIVE_SESSION = {
  status: "active" as const,
  sessionId:
    "kn7ses000000000000000000000" as import("../convex/_generated/dataModel").Id<"staff_sessions">,
  staff: {
    _id: "kn7lucas000000000000000000000" as import("../convex/_generated/dataModel").Id<"staff">,
    name: "Lucas",
    role: "staff" as const,
  },
};

function renderLock() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/lock"]}>
        <Routes>
          <Route path="/lock" element={<Lock />} />
          <Route path="/" element={<div data-testid="home-page" />} />
          <Route path="/login" element={<div data-testid="login-page" />} />
          <Route path="/shift/handover" element={<div data-testid="shift-handover-page" />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Lock route", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Reset to no session by default; tests that need active session set it themselves.
    vi.mocked(useSessionModule.useSession).mockReturnValue({
      status: "none",
      sessionId: null,
      staff: null,
    });
  });

  test("renders nothing when there is no active session", () => {
    const { container } = renderLock();
    // null short-circuit — no card rendered
    expect(container.querySelector("[data-testid='lock-card']")).toBeNull();
    expect(screen.queryByRole("button", { name: /lock/i })).toBeNull();
  });

  test("Lock button calls logout with sessionId + idempotencyKey, then navigates to /login", async () => {
    localStorage.setItem(LAST_STAFF_KEY, "kn7lucas000000000000000000000");
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();

    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(mockLogout).toHaveBeenCalledOnce());
    expect(mockLogout).toHaveBeenCalledWith({
      sessionId: ACTIVE_SESSION.sessionId,
      idempotencyKey: "test-idem-key",
    });
  });

  test("Lock button clears session after logout", async () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(mockClearSession).toHaveBeenCalledOnce());
  });

  test("Lock button navigates to /login after logout", async () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(screen.getByTestId("login-page")).toBeInTheDocument());
  });

  test(`${LAST_STAFF_KEY} key is preserved after lock`, async () => {
    localStorage.setItem(LAST_STAFF_KEY, "kn7lucas000000000000000000000");
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(mockLogout).toHaveBeenCalledOnce());
    expect(localStorage.getItem(LAST_STAFF_KEY)).toBe("kn7lucas000000000000000000000");
  });

  test("Cancel button navigates back to /", async () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.getByTestId("home-page")).toBeInTheDocument());
  });

  test("Lock button is no-op when idempotency key is not yet resolved", async () => {
    const { useIdempotency } = await import("@/hooks/useIdempotency");
    vi.mocked(useIdempotency).mockReturnValueOnce(undefined);
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    // logout should NOT be called because idemKey is undefined
    expect(mockLogout).not.toHaveBeenCalled();
  });

  test("shows staff name in the confirm dialog", () => {
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/Lucas/);
  });
});

// ─── lockShift + manager-unlock tests ─────────────────────────────────────────

describe("Lock route — lockShift + manager-unlock", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
  });

  test("Lock button calls lockShift (not bare logout) with sessionId + idempotencyKey", async () => {
    // Wire useMutation to return lockShift for the lockShift call
    const convexReact = await import("convex/react");
    (convexReact.useMutation as Mock).mockReturnValue(mockLockShift);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(mockLockShift).toHaveBeenCalledOnce());
    expect(mockLockShift).toHaveBeenCalledWith({
      sessionId: ACTIVE_SESSION.sessionId,
      idempotencyKey: "test-idem-key",
    });
    // bare logout should NOT be called
    expect(mockLogout).not.toHaveBeenCalled();
  });

  test("Lock button clears session and navigates to /login after lockShift", async () => {
    const convexReact = await import("convex/react");
    (convexReact.useMutation as Mock).mockReturnValue(mockLockShift);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(mockClearSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("login-page")).toBeInTheDocument());
  });

  test("'Manajer buka kunci' button is visible when session is active", () => {
    renderLock();
    expect(
      screen.getByRole("button", { name: /manajer buka kunci/i }),
    ).toBeInTheDocument();
  });

  test("'Manajer buka kunci' opens PinSheet", async () => {
    // Need a manager in the query result for the picker
    const convexReact = await import("convex/react");
    (convexReact.useQuery as Mock).mockReturnValue([{ _id: "kn7lucas000000000000000000000", name: "Lucas", role: "manager" }]);
    (convexReact.useMutation as Mock).mockReturnValue(mockLockShift);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /manajer buka kunci/i }));

    // PinSheet dialog title should appear
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeInTheDocument(),
    );
  });

  test("managerTakeover is called with correct args and navigates to /shift/handover", async () => {
    const convexReact = await import("convex/react");
    // First useQuery call = getActiveStaff with managers
    (convexReact.useQuery as Mock).mockReturnValue([
      { _id: "kn7lucas000000000000000000000", name: "Lucas", role: "manager" },
    ]);
    (convexReact.useMutation as Mock).mockReturnValue(mockLockShift);
    (convexReact.useAction as Mock).mockReturnValue(mockManagerTakeover);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /manajer buka kunci/i }));

    // Wait for dialog to open
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    // Click Lucas in the picker (there may be multiple "Lucas" elements — the
    // picker button is the one inside the dialog/PinSheet extraField).
    const lucasButtons = screen.getAllByText("Lucas");
    // The picker button is a <button> element
    const lucasPickerBtn = lucasButtons.find((el) => el.tagName === "BUTTON");
    fireEvent.click(lucasPickerBtn!);

    // Enter PIN via numeric keypad buttons (4 digits)
    const buttons = screen.getAllByRole("button");
    const oneBtn = buttons.find((b) => b.textContent === "1");
    if (oneBtn) {
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
      fireEvent.click(oneBtn);
    }

    await waitFor(() => expect(mockManagerTakeover).toHaveBeenCalledOnce());
    const callArgs = mockManagerTakeover.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      managerStaffId: "kn7lucas000000000000000000000",
      managerPin: "1111",
    });

    await waitFor(() =>
      expect(screen.getByTestId("shift-handover-page")).toBeInTheDocument(),
    );
    expect(mockStoreSession).toHaveBeenCalled();
  });
});
