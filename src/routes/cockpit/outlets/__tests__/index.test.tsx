/**
 * Tests for CockpitOutlets (v1.3.0 Task 10) — outlet list page.
 *
 * Mock strategy (mirrors src/routes/cockpit/__tests__/index.test.tsx):
 *   - useSession stubbed directly → always returns an active cockpit session.
 *   - convex/react: useQuery stubbed to return mock outlet data.
 * This avoids any IDB / Convex-client side-effects in the test environment.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import CockpitOutlets from "../index";

// ─── module mocks (hoisted by Vite) ──────────────────────────────────────────

let mockOutlets: unknown = undefined;

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({
    status: "active",
    sessionId: "kn7ses000000000000000000000",
    kind: "cockpit",
    staff: {
      _id: "kn7own",
      name: "Lucas",
      role: "owner",
      must_change_pin: false,
      locale: "en",
      outlet_id: undefined,
      outlet_label: undefined,
    },
  })),
  clearSession: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => mockOutlets),
  };
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/cockpit/outlets"]}>
        <Routes>
          <Route path="/cockpit/outlets" element={<CockpitOutlets />} />
          <Route
            path="/cockpit/outlets/new"
            element={<div data-testid="new-outlet-page" />}
          />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// ─── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockOutlets = undefined;
});

describe("CockpitOutlets", () => {
  it("renders a row per outlet with name and code", () => {
    mockOutlets = [
      {
        _id: "outlets_1",
        code: "PKW",
        name: "Pakuwon",
        address: "Mall level 2",
        timezone: "Asia/Jakarta",
        active: true,
        created_at: 1_700_000_000_000,
      },
      {
        _id: "outlets_2",
        code: "CBS",
        name: "Cibubur",
        address: undefined,
        timezone: "Asia/Jakarta",
        active: false,
        created_at: 1_700_000_001_000,
      },
    ];
    renderRoute();

    // Names appear.
    expect(screen.getByText("Pakuwon")).toBeInTheDocument();
    expect(screen.getByText("Cibubur")).toBeInTheDocument();

    // Codes appear.
    expect(screen.getByText("PKW")).toBeInTheDocument();
    expect(screen.getByText("CBS")).toBeInTheDocument();

    // Address appears when present.
    expect(screen.getByText("Mall level 2")).toBeInTheDocument();

    // Active/inactive badges.
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("renders the New outlet CTA linking to /cockpit/outlets/new", () => {
    mockOutlets = [];
    renderRoute();

    const link = screen.getByRole("link", { name: /new outlet/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/cockpit/outlets/new");
  });

  it("shows an empty state when the list is empty", () => {
    mockOutlets = [];
    renderRoute();
    expect(screen.getByText(/no outlets yet/i)).toBeInTheDocument();
  });
});
