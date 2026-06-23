/**
 * Tests for CockpitHomeRoute (v2.0 owner-auth, ADR-052) — the post-login landing
 * stub. It exists so a successful cockpit login has a real navigation target (its
 * absence bounce-loops via the `*` catch-all → `/` → cross-plane guard). Verifies
 * the owner greeting renders and sign-out ends the session + returns to login.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderWithLocale as render, screen, waitFor, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import CockpitHomeRoute from "../index";

const { mockLogout, mockClearSession } = vi.hoisted(() => ({
  mockLogout: vi.fn().mockResolvedValue(null),
  mockClearSession: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useMutation: vi.fn(() => mockLogout) };
});

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idem-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({
    status: "active",
    sessionId: "kn7ses000000000000000000000",
    kind: "cockpit",
    staff: { _id: "kn7own", name: "Lucas", role: "owner" },
  })),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockLogout.mockResolvedValue(null);
});

function renderHome() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/cockpit"]}>
        <Routes>
          <Route path="/cockpit" element={<CockpitHomeRoute />} />
          <Route path="/cockpit/login" element={<div data-testid="cockpit-login-page" />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("Cockpit home", () => {
  it("renders the owner greeting", async () => {
    renderHome();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /you're signed in/i })).toBeInTheDocument(),
    );
    expect(screen.getByText("Lucas")).toBeInTheDocument();
  });

  it("sign-out ends the cockpit session, clears the local session, and returns to login", async () => {
    renderHome();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(mockLogout).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "kn7ses000000000000000000000" }),
    );
    expect(mockClearSession).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-login-page")).toBeInTheDocument(),
    );
  });

  it("still clears the local session and returns to login if the backend logout throws", async () => {
    mockLogout.mockRejectedValueOnce(new Error("NETWORK"));
    renderHome();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    // Best-effort: local session cleared + redirected regardless of the throw.
    await waitFor(() => expect(mockClearSession).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("cockpit-login-page")).toBeInTheDocument(),
    );
  });
});
