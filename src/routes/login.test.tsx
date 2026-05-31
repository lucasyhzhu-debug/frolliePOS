/**
 * Tests for LoginRoute.
 *
 * Mock strategy (follows charge.test.tsx / telegram-chats.test.tsx pattern):
 *   - convex/react: useQuery controlled via vi.fn(); useAction returns stub.
 *   - sonner: toast.error stub so we can assert "no toast" in fallback tests.
 *   - ConnDot: stubbed to avoid IDB/deviceId side-effects.
 *
 * The component renders two useQuery calls per tree:
 *   Call 0 = api.auth.public.getActiveStaff   (staff list)
 *   Call 1 = api.approvals.public.getRecentPinResetForStaff  ("skip" while list view)
 *
 * Tests that exercise the pre-stage mount-effect set localStorage before render
 * and reset it in beforeEach via localStorage.clear().
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import LoginRoute from "./login";
import { LAST_STAFF_KEY } from "@/lib/storage-keys";

// ─── module mocks (hoisted by Vite) ──────────────────────────────────────────

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useAction: vi.fn(() => vi.fn()),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/layout/ConnDot", () => ({
  ConnDot: () => null,
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

/** Wire useQuery call-0 (getActiveStaff) to return the given rows. */
function mockStaff(rows: StaffRow[]) {
  let callCount = 0;
  (useQueryMock as Mock).mockImplementation((_api: unknown, args: unknown) => {
    // "skip" sentinel → always undefined
    if (args === "skip") return undefined;
    const slot = callCount++;
    // Call 0 = getActiveStaff
    if (slot === 0) return rows;
    // Call 1 = getRecentPinResetForStaff (skip while list stage, or pending)
    return undefined;
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
});

function renderLogin() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/login"]}>
        <LoginRoute />
      </MemoryRouter>
    </ConvexProvider>,
  );
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
