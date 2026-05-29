import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetForTests } from "@/hooks/useIdempotency";

/**
 * Smoke tests for the /approve/:token public PIN-reset route.
 *
 * The component uses useQuery (getByToken) and useAction (approveStaffPinReset).
 * convex/react is mocked below so we control the return value of useQuery for
 * each state under test: loading (undefined), expired/null, resolved, and pending.
 *
 * PINs are never logged — the test never reads pin-value state directly.
 */

// ---------- mock convex/react -----------------------------------------------
// We need fine-grained control over useQuery's return per test.

let mockQueryReturn: unknown = undefined; // undefined = loading

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: () => mockQueryReturn,
    useAction: () => vi.fn().mockResolvedValue({ resolved: true }),
  };
});

// ---------- helpers ----------------------------------------------------------

function renderAt(token = "test-token-abc") {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={[`/approve/${token}`]}>
        <Routes>
          <Route
            path="/approve/:token"
            element={
              // Dynamic import resolved at module evaluation; use lazy below or
              // import statically. Import at top is fine since module is already
              // loaded by the test runner before mocks run.
              <ApproveRouteComponent />
            }
          />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// Imported after mock setup so it picks up the mocked convex/react.
import ApproveRouteComponent from "./index";

// ---------- tests ------------------------------------------------------------

describe("Approve route (/approve/:token) — public PIN-reset page", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetForTests();
    mockQueryReturn = undefined; // reset to loading state
  });

  it("renders a loading spinner while useQuery is pending (undefined)", () => {
    mockQueryReturn = undefined;
    const { container } = renderAt();
    expect(container).toBeTruthy();
    // Spinner SVG should be present
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("shows expired message when useQuery returns null", () => {
    mockQueryReturn = null;
    renderAt();
    expect(
      screen.getByText(/expired or is invalid/i),
    ).toBeInTheDocument();
  });

  it("shows expired message when status is 'expired'", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Budi",
      subject_staff_code: "STF01",
      status: "expired",
      triggered_at: Date.now() - 70 * 60 * 1000,
      token_expires_at: Date.now() - 10 * 60 * 1000,
    };
    renderAt();
    expect(
      screen.getByText(/expired or is invalid/i),
    ).toBeInTheDocument();
  });

  it("shows already-reset message when status is 'resolved'", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Siti",
      subject_staff_code: "STF02",
      status: "resolved",
      triggered_at: Date.now() - 30 * 60 * 1000,
      token_expires_at: Date.now() + 30 * 60 * 1000,
      resolved_at: Date.now() - 5 * 60 * 1000,
    };
    renderAt();
    expect(
      screen.getByText(/already been reset/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Siti/)).toBeInTheDocument();
  });

  it("renders the pending form with staff name + form fields when status is 'pending'", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Andi",
      subject_staff_code: "STF03",
      status: "pending",
      triggered_at: Date.now() - 5 * 60 * 1000,
      token_expires_at: Date.now() + 55 * 60 * 1000,
    };
    renderAt();

    // Heading
    expect(screen.getByRole("heading", { name: /PIN Reset/i })).toBeInTheDocument();

    // Locked-out staff name appears in description (also in "New PIN for Andi" label)
    expect(screen.getAllByText(/Andi/).length).toBeGreaterThan(0);

    // Staff-code input
    expect(
      screen.getByLabelText(/your manager staff code/i),
    ).toBeInTheDocument();

    // Submit button
    expect(
      screen.getByRole("button", { name: /Reset PIN/i }),
    ).toBeInTheDocument();
  });

  it("submit button is disabled when fields are incomplete", () => {
    mockQueryReturn = {
      kind: "staff_pin_reset",
      subject_staff_name: "Andi",
      subject_staff_code: "STF03",
      status: "pending",
      triggered_at: Date.now(),
      token_expires_at: Date.now() + 60 * 60 * 1000,
    };
    renderAt();
    const btn = screen.getByRole("button", { name: /Reset PIN/i });
    // No staff code, no PIN → should be disabled
    expect(btn).toBeDisabled();
  });
});
