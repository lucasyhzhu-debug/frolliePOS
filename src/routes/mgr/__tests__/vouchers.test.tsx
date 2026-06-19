import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * V9 — /mgr/vouchers surface smoke tests.
 *
 * Mocking pattern mirrors /mgr/dashboard + /mgr/refunds-pending: useQuery is
 * dispatched by FunctionReference name. The route makes up to three queries:
 *   - useSession's getSession             → mockSessionReturn
 *   - vouchers.public.listAllVouchers     → mockListReturn
 *   - vouchers.public.getVoucherRedemptions (only when a row is expanded; skipped here)
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
let mockListReturn: unknown = [];

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
      if (name.includes("listAllVouchers")) return mockListReturn;
      if (name.includes("getVoucherRedemptions")) return undefined;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "key1",
  clearIntent: vi.fn(),
}));

import MgrVouchers from "../vouchers";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/vouchers"]}>
        <Routes>
          <Route path="/mgr/vouchers" element={<MgrVouchers />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

const VOUCHER_FIXTURE_1 = {
  _id: "v_1",
  _creationTime: 0,
  code: "WELCOME10",
  type: "percentage",
  value: 10,
  used_count: 3,
  active: true,
  created_at: 1_700_000_000_000,
};

const VOUCHER_FIXTURE_2 = {
  _id: "v_2",
  _creationTime: 0,
  code: "FLAT5K",
  type: "amount",
  value: 5_000,
  used_count: 0,
  max_redemptions: 100,
  active: true,
  created_at: 1_700_000_001_000,
};

describe("MgrVouchers route (/mgr/vouchers)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    mockListReturn = [];
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders the empty state for a manager when no vouchers exist", () => {
    mockListReturn = [];
    renderRoute();
    expect(screen.getByText(/No vouchers yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Add voucher/i }),
    ).toBeInTheDocument();
  });

  it("renders voucher rows including code, value, and used count", () => {
    mockListReturn = [VOUCHER_FIXTURE_1, VOUCHER_FIXTURE_2];
    renderRoute();
    expect(screen.getByText("WELCOME10")).toBeInTheDocument();
    expect(screen.getByText("FLAT5K")).toBeInTheDocument();
  });

  it("non-manager session redirects to /", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
    renderRoute();
    expect(screen.getByText("HOME_PAGE")).toBeInTheDocument();
  });

  it("shows an inline FieldMessage for an invalid value on submit", () => {
    // beforeEach already sets a manager mockSessionReturn + empty mockListReturn.
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /add voucher/i }));
    fireEvent.change(screen.getByLabelText(/Code/i), { target: { value: "SAVE10" } });
    // leave value empty → invalid
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    const msg = screen.getByText(/Value must be a positive integer/i);
    expect(msg).toBeInTheDocument();
    expect(msg.closest("[role='alert']")).not.toBeNull();
  });
});
