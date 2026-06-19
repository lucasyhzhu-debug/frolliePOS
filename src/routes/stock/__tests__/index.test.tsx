import { describe, expect, it, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useQuery: vi.fn() };
});
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "session-1",
    staff: { name: "Bayu", role: "staff" },
  }),
}));

import { useQuery } from "convex/react";
import StockScreen from "@/routes/stock/index";

function renderStock() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter>
        <StockScreen />
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("StockScreen", () => {
  it("shows a friendly empty state when no SKUs exist", () => {
    vi.mocked(useQuery).mockReturnValue([]);
    renderStock();
    expect(screen.getByText(/no skus yet/i)).toBeInTheDocument();
  });

  it("renders rows when SKUs exist", () => {
    vi.mocked(useQuery).mockReturnValue([
      { skuId: "sku1", name: "Dubai", on_hand: 12, status: "ok" },
    ]);
    renderStock();
    expect(screen.getByText("Dubai")).toBeInTheDocument();
    expect(screen.getByText("12 pcs")).toBeInTheDocument();
  });
});
