import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetForTests } from "@/hooks/useIdempotency";
import SaleCharge from "./charge";

/**
 * Smoke test: the charge screen renders without crashing in the loading phase.
 *
 * useXenditPayment subscribes to getById + getCurrentInvoice; both are undefined
 * while Convex is connecting, so computePhase returns { kind: "loading" } and the
 * route shows its spinner. We mount through a real Route so useParams() resolves
 * the :txnId path param exactly as in production (src/router.tsx).
 *
 * Browser / interaction testing (method switch, 60s ceiling, override) is
 * deferred to Task 40.
 */
describe("SaleCharge route", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetForTests();
  });

  function renderAt(txnId: string) {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    return render(
      <ConvexProvider client={convex}>
        <MemoryRouter initialEntries={[`/sale/charge/${txnId}`]}>
          <Routes>
            <Route path="/sale/charge/:txnId" element={<SaleCharge />} />
          </Routes>
        </MemoryRouter>
      </ConvexProvider>,
    );
  }

  it("renders without crashing when session is none (RootLayout would redirect)", () => {
    // No sessionId → session.status "none" → component returns null. The
    // assertion is that mounting through the :txnId route does not throw.
    const { container } = renderAt("txn-123");
    expect(container).toBeTruthy();
  });

  it("renders the session-loading spinner while the session query is pending", () => {
    localStorage.setItem("frollie-session-id", "fake-session-id");
    const { container } = renderAt("txn-456");
    // session.status is "loading" (stored id + query pending) → spinner SVG.
    expect(container).toBeTruthy();
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });
});
