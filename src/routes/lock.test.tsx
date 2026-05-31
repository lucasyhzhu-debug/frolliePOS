import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import Lock from "./lock";

// ─── module mocks ─────────────────────────────────────────────────────────────

// vi.hoisted so these refs are available inside the hoisted vi.mock factories.
const { mockLogout, mockClearSession } = vi.hoisted(() => ({
  mockLogout: vi.fn().mockResolvedValue(undefined),
  mockClearSession: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useMutation: vi.fn(() => mockLogout),
  };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
  clearSession: mockClearSession,
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
    localStorage.setItem("frollie-last-staff", "kn7lucas000000000000000000000");
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

  test("frollie-last-staff key is preserved after lock", async () => {
    localStorage.setItem("frollie-last-staff", "kn7lucas000000000000000000000");
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);

    renderLock();
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));

    await waitFor(() => expect(mockLogout).toHaveBeenCalledOnce());
    expect(localStorage.getItem("frollie-last-staff")).toBe("kn7lucas000000000000000000000");
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
