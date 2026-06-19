import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import SaleChargeSuccess from "./charge-success";

/**
 * Smoke test: the charge-success screen renders without crashing.
 *
 * useQuery(getById, ...) returns undefined while Convex is connecting, so
 * the route shows its loading spinner. We mount through a real Route so
 * useParams() resolves the :txnId path param exactly as in src/router.tsx.
 *
 * Full receipt / paid-state rendering is deferred to Task 40 interaction
 * tests.
 */
describe("SaleChargeSuccess route", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  function renderAt(txnId: string) {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    return render(
      <ConvexProvider client={convex}>
        <LocaleProvider>
          <MemoryRouter initialEntries={[`/sale/charge/${txnId}/success`]}>
            <Routes>
              <Route
                path="/sale/charge/:txnId/success"
                element={<SaleChargeSuccess />}
              />
            </Routes>
          </MemoryRouter>
        </LocaleProvider>
      </ConvexProvider>,
    );
  }

  it("renders without crashing when getById is undefined (Convex loading)", () => {
    // getById returns undefined (query in-flight) → loading spinner rendered.
    const { container } = renderAt("txn-123");
    expect(container).toBeTruthy();
  });

  it("shows a loading spinner while the query is pending", () => {
    const { container } = renderAt("txn-456");
    // Loading branch: spinner + "Loading receipt…"
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });
});
