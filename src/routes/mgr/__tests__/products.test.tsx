import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * /mgr/products inline-behavior smoke test.
 *
 * Mocking pattern mirrors /mgr/vouchers: useQuery is dispatched by
 * FunctionReference name. The route makes two queries:
 *   - useSession's getSession             → mockSessionReturn
 *   - catalog.public.listAllProducts      → mockListReturn
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
let mockListReturn: unknown = { products: [], skus: [], components: [] };

// useIdempotency is IDB-backed and returns `undefined` until it resolves a key,
// which never happens synchronously in jsdom — leaving PIN/submit buttons
// `disabled`. Mock it to a stable key (mirrors home.test.tsx) so the Add-product
// "Continue" button is enabled and the validation path runs. clearIntent is also
// imported by the route, so stub it too.
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "key1",
  clearIntent: vi.fn(),
}));

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
      if (name.includes("listAllProducts")) return mockListReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

import MgrProducts from "../products";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/products"]}>
        <Routes>
          <Route path="/mgr/products" element={<MgrProducts />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrProducts route (/mgr/products)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    mockListReturn = { products: [], skus: [], components: [] };
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders the empty state for a manager when no products exist", () => {
    renderRoute();
    expect(screen.getByText(/No products yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Add product/i }),
    ).toBeInTheDocument();
  });

  it("shows an inline FieldMessage (not a toast) for an invalid price on submit", () => {
    mockListReturn = { products: [], skus: [], components: [] };
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /add product/i }));
    // fill the required text fields so only price is invalid
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText(/Pack label/i), { target: { value: "1pc" } });
    fireEvent.change(screen.getByLabelText(/SKU family/i), { target: { value: "test" } });
    // leave price empty → invalid
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    const msg = screen.getByText(/Price must be a non-negative integer/i);
    expect(msg).toBeInTheDocument();
    expect(msg.closest("[role='alert']")).not.toBeNull();
    expect(screen.getByLabelText(/^Price/i)).toHaveAttribute("aria-invalid", "true");
  });
});
