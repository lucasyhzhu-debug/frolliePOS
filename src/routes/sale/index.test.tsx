import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetCartForTests } from "@/hooks/useCart";
import SaleRoute from "./index";

/**
 * Sale route tests — two tiers:
 *
 * Tier 1 (smoke): renders without crashing in loading / no-session states.
 *
 * Tier 2 (blocker): verifies that the AbandonCartDialog appears when the
 *   blocker fires (state === "blocked"), and that a cancel call resets it.
 *
 * useBlocker requires a data router. We mock it from react-router so the
 * existing MemoryRouter-based render pattern continues to work. The mock
 * exposes a controllable state object so tests can drive the dialog lifecycle.
 */

// ─── module mocks ────────────────────────────────────────────────────────────

// Controllable blocker state — tests push new state via setBlockerState().
let blockerState: "unblocked" | "blocked" | "proceeding" = "unblocked";
const blockerReset = vi.fn();
const blockerProceed = vi.fn();
function setBlockerState(s: typeof blockerState) {
  blockerState = s;
}

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useBlocker: vi.fn(() => ({
      state: blockerState,
      reset: blockerReset,
      proceed: blockerProceed,
    })),
  };
});

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useMutation: vi.fn(() => vi.fn().mockResolvedValue({})),
  };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
}));

vi.mock("@/hooks/useCatalogCache", () => ({
  useCatalogCache: vi.fn(() => ({ snapshot: null })),
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idempotency-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/components/layout/ConnDot", () => ({
  ConnDot: () => null,
}));

// ─── imported mocks ──────────────────────────────────────────────────────────

import * as useSessionModule from "@/hooks/useSession";
import * as useCartModule from "@/hooks/useCart";

// ─── helpers ─────────────────────────────────────────────────────────────────

const ACTIVE_SESSION = {
  status: "active" as const,
  sessionId: "session-1" as import("../../convex/_generated/dataModel").Id<"staff_sessions">,
  staff: {
    _id: "staff-1" as import("../../convex/_generated/dataModel").Id<"staff">,
    name: "Staff 1",
    role: "staff" as const,
  },
};

function renderSale() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/sale"]}>
        <Routes>
          <Route path="/sale" element={<SaleRoute />} />
          <Route path="/other" element={<div data-testid="other-page" />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// ─── Tier 1: smoke ───────────────────────────────────────────────────────────

describe("Sale route — smoke", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetCartForTests();
    vi.clearAllMocks();
    blockerState = "unblocked";
    vi.mocked(useSessionModule.useSession).mockReturnValue({
      status: "none",
      sessionId: null,
      staff: null,
    });
  });

  it("renders without crashing when session is none and catalog is undefined", () => {
    const { container } = renderSale();
    expect(container).toBeTruthy();
  });

  it("renders loading state while session is loading (sessionId in storage, query pending)", () => {
    localStorage.setItem("frollie-session-id", "fake-session-id");
    vi.mocked(useSessionModule.useSession).mockReturnValue({
      status: "loading",
      sessionId: null,
      staff: null,
    });
    const { container } = renderSale();
    expect(container).toBeTruthy();
  });
});

// ─── Tier 2: useBlocker ───────────────────────────────────────────────────────

describe("Sale route — useBlocker navigation guard", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetCartForTests();
    vi.clearAllMocks();
    blockerState = "unblocked";
    blockerReset.mockReset();
    blockerProceed.mockReset();
    vi.mocked(useSessionModule.useSession).mockReturnValue(ACTIVE_SESSION);
  });

  it("empty cart: blocker is unblocked, AbandonCartDialog is not rendered", async () => {
    // With empty cart, the blocker should stay "unblocked" and the dialog
    // should not appear.
    renderSale();
    await waitFor(() => {
      expect(screen.queryByText("Leave this sale?")).toBeNull();
    });
  });

  it("non-empty cart + blocker blocked: AbandonCartDialog appears", async () => {
    // Inject a non-empty cart and set blocker state to "blocked"
    const cartSpy = vi.spyOn(useCartModule, "useCart").mockReturnValue({
      lines: [{ productId: "p1" as never, qty: 1, unitPrice: 10000 }],
      subtotal: 10000,
      voucherCode: null,
      addLine: vi.fn(),
      setQty: vi.fn(),
      clear: vi.fn(),
      loadFromDraft: vi.fn(),
      setVoucher: vi.fn(),
      clearVoucher: vi.fn(),
    });

    setBlockerState("blocked");
    renderSale();

    await waitFor(() => {
      expect(screen.getByText("Leave this sale?")).toBeTruthy();
    });

    cartSpy.mockRestore();
  });

  it("dialog Cancel calls blocker.reset()", async () => {
    const cartSpy = vi.spyOn(useCartModule, "useCart").mockReturnValue({
      lines: [{ productId: "p1" as never, qty: 1, unitPrice: 10000 }],
      subtotal: 10000,
      voucherCode: null,
      addLine: vi.fn(),
      setQty: vi.fn(),
      clear: vi.fn(),
      loadFromDraft: vi.fn(),
      setVoucher: vi.fn(),
      clearVoucher: vi.fn(),
    });

    setBlockerState("blocked");
    renderSale();

    await waitFor(() => {
      expect(screen.getByText("Leave this sale?")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(blockerReset).toHaveBeenCalledOnce();

    cartSpy.mockRestore();
  });
});
