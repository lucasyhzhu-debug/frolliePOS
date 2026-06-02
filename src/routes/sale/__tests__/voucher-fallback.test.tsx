import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, it, expect, vi } from "vitest";
import SaleVoucher from "../voucher";

vi.mock("@/hooks/useCart", () => ({
  useCart: () => ({
    subtotal: 100000,
    voucherCode: undefined,
    setVoucher: vi.fn(),
    clearVoucher: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCatalogCache", () => ({
  useCatalogCache: () => ({
    hydrated: true,
    snapshot: {
      products: [],
      skus: [],
      components: [],
      stockLevels: [],
      vouchers: [
        {
          _id: "v1",
          code: "OFFLINE",
          type: "amount",
          value: 5000,
          active: true,
          used_count: 0,
          created_at: Date.now(),
        },
      ],
    },
  }),
}));

// useQuery returns undefined to simulate offline / WS disconnect.
// useConvex is consumed by SpokeLayout > ConnDot — stub a minimal client.
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useConvex: () => ({
    connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false }),
  }),
}));

describe("sale/voucher cached fallback", () => {
  it("enables Apply using cached snapshot when live query is undefined", () => {
    render(
      <MemoryRouter>
        <SaleVoucher />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText(/Enter voucher code/i), {
      target: { value: "OFFLINE" },
    });
    expect(screen.getByText(/Valid/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply/ })).not.toBeDisabled();
    expect(screen.getByText(/cached/i)).toBeInTheDocument();
  });
});
