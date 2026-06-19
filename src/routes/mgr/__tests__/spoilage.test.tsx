import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * S6 — /mgr/spoilage surface smoke tests.
 *
 * Mocking mirrors /mgr/vouchers: useQuery is dispatched by FunctionReference
 * name. The route makes two queries:
 *   - useSession's getSession             → mockSessionReturn
 *   - catalog.public.catalog              → mockCatalogReturn
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
const mockCatalogReturn: unknown = {
  skus: [
    {
      _id: "sku_1",
      _creationTime: 0,
      sku: "dubai",
      name: "Dubai Chocolate",
      unit: "piece",
      low_threshold: 0,
      active: true,
      created_at: 1_700_000_000_000,
    },
  ],
  products: [],
  components: [],
  stockLevels: [],
  vouchers: [],
};

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
      if (name.includes("catalog.public.catalog")) return mockCatalogReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

import MgrSpoilage from "../spoilage";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/spoilage"]}>
        <Routes>
          <Route path="/mgr/spoilage" element={<MgrSpoilage />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrSpoilage route (/mgr/spoilage)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders both CTAs for manager", () => {
    renderRoute();
    expect(
      screen.getByRole("button", { name: /Log spoilage now/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Request via Telegram/i }),
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
