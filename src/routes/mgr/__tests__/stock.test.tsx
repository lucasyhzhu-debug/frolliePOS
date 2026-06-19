import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * R9 — /mgr/stock drift log surface smoke tests.
 *
 * Mock pattern mirrors /mgr/spoilage (S6): useQuery dispatched by
 * FunctionReference name so we can fake getSession + listStockDrift
 * independently.
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
const mockDriftRows: unknown = [
  {
    _id: "d1",
    _creationTime: 0,
    inventory_sku_id: "sku1",
    sku_code: "dubai",
    cached_on_hand: 10,
    reconstructed_on_hand: 7,
    delta: 3,
    detected_at: 1_700_000_000_000,
  },
];

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(
          query as Parameters<typeof getFunctionName>[0],
        );
      } catch {
        name = "";
      }
      // Convex emits names with `/` (module path) and `:` (export), e.g.
      // `inventory/public:listStockDrift`. Match on the export name to
      // stay resilient to module-path renames.
      if (name.includes("listStockDrift")) return mockDriftRows;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({ ok: true }),
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

import MgrStock from "../stock";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/stock"]}>
        <Routes>
          <Route path="/mgr/stock" element={<MgrStock />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrStock drift tab (/mgr/stock)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders drift rows for manager with delta + resolve button", () => {
    renderRoute();
    expect(screen.getByText(/Stock drift/i)).toBeInTheDocument();
    expect(screen.getByText(/dubai/)).toBeInTheDocument();
    expect(screen.getByText(/Δ \+3|delta.*3|Δ 3/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mark resolved/i }),
    ).toBeInTheDocument();
  });

  it("non-manager session redirects to /", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    renderRoute();
    expect(screen.getByText("HOME_PAGE")).toBeInTheDocument();
  });
});
