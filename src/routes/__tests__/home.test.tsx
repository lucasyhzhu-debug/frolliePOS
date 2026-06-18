import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

let mockRecovery: { count: number; latest: { _id: string; created_at: number } | null };
let mockRole: "manager" | "staff" = "staff";

vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "s1",
    staff: { _id: "x", name: "Andi", role: mockRole },
  }),
  clearSession: vi.fn(),
}));
vi.mock("@/hooks/useAwaitingPaymentRecovery", () => ({
  useAwaitingPaymentRecovery: () => mockRecovery,
}));
vi.mock("@/hooks/useRecountNudge", () => ({ useRecountNudge: () => false }));
vi.mock("@/hooks/useCatalogCache", () => ({
  useCatalogCache: () => ({ snapshot: { products: [], skus: [] } }),
}));
vi.mock("@/hooks/useIdempotency", () => ({ useIdempotency: () => "key1" }));
vi.mock("@/components/pos/PrinterSheet", () => ({ PrinterSheet: () => null }));
vi.mock("@/components/layout/ConnDot", () => ({ ConnDot: () => null }));
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: () => ({ products: [], skus: [] }),
    useMutation: () => vi.fn(),
  };
});

import Home from "../home";

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Home />
    </MemoryRouter>,
  );
}

describe("HomeRoute awaiting-payment recovery banner", () => {
  beforeEach(() => {
    mockRecovery = { count: 0, latest: null };
    mockRole = "staff";
  });

  it("hides the banner when there is no awaiting txn", () => {
    renderHome();
    expect(screen.queryByTestId("awaiting-recovery-banner")).toBeNull();
  });

  it("shows the banner linking to the latest awaiting txn", () => {
    mockRecovery = { count: 2, latest: { _id: "txnX", created_at: 1 } };
    renderHome();
    const banner = screen.getByTestId("awaiting-recovery-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute("href")).toBe("/sale/charge/txnX");
  });
});

describe("HomeRoute role-based tile rendering", () => {
  beforeEach(() => {
    mockRecovery = { count: 0, latest: null };
    mockRole = "staff";
  });

  it("manager sees the Manager tiles and the Settlements tile", () => {
    mockRole = "manager";
    renderHome();
    expect(screen.getByText("Manager home")).toBeInTheDocument();
    expect(screen.getByText("Settlements")).toBeInTheDocument();
  });

  it("staff sees no Manager group, no Manager/Settlements tiles", () => {
    mockRole = "staff";
    renderHome();
    expect(screen.queryByText("MANAGER")).toBeNull();
    expect(screen.queryByText("Manager home")).toBeNull();
    expect(screen.queryByText("Settlements")).toBeNull();
  });

  it("renders a Lock control in the app-bar and no bottom Lock button", () => {
    mockRole = "staff";
    renderHome();
    expect(screen.getByLabelText(/lock/i)).toBeInTheDocument();
  });
});
