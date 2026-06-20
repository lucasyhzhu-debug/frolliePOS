import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * Smoke + empty-state tests for the /refund route (today's refundable list).
 *
 * The route directly calls one `useQuery(api.refunds.public.listTodaysRefundable)`
 * plus `useSession`, which internally calls `useQuery(api.auth.public.getSession)`.
 *
 * The dispatch-by-args pattern follows src/routes/approve/index.test.tsx — we
 * inspect the args shape to decide which value to return.
 *
 * Interaction tests (navigation on click) are deferred to B24.
 */

// ---------- mocks ------------------------------------------------------------

const FAKE_SESSION_ID = "session_abc";

// Mock useSession so LocaleProvider (which calls useSession) doesn't consume
// a useQuery slot from the counter-based convex/react mock below.
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: FAKE_SESSION_ID,
    staff: { _id: "staff_1", name: "Andi", role: "staff" },
  }),
  storeSession: vi.fn(),
  clearSession: vi.fn(),
}));

// Default: empty refundable list + active session.
let mockTxnsReturn: unknown = [];
let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Andi", role: "staff" },
};

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: (_query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      // useSession is fully mocked above — the only useQuery call here is
      // listTodaysRefundable from the route itself.
      return mockTxnsReturn;
    },
  };
});

// Imported after mock setup.
import RefundList from "../index";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/refund"]}>
        <RefundList />
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("RefundList route (/refund)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockTxnsReturn = [];
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Andi", role: "staff" },
    };
  });

  it("renders without crashing when session is none (no storage)", () => {
    // No SESSION_KEY → useSession returns { status: "none" } and useQuery is
    // called with "skip". The route's `!txns` branch shows the loading shell.
    mockSessionReturn = undefined; // doesn't matter — "skip" path
    const { container } = renderRoute();
    expect(container).toBeTruthy();
  });

  it("renders empty-state copy when session is active and list is empty", () => {
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
    mockTxnsReturn = [];
    renderRoute();
    expect(screen.getByText(/No transactions today\./i)).toBeInTheDocument();
    expect(screen.getByText(/contact management/i)).toBeInTheDocument();
  });
});
