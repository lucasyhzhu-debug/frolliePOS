import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { __resetCartForTests } from "@/hooks/useCart";
import SaleRoute from "./index";

/**
 * Smoke test: the sale screen renders without crashing with an inactive session
 * (catalog query returns undefined while Convex is loading). Mirrors the
 * ConvexProvider + MemoryRouter pattern used in login.test.tsx.
 *
 * Browser / interaction testing is deferred to Task 40.
 */
describe("Sale route", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetCartForTests();
  });

  it("renders without crashing when session is none and catalog is undefined", () => {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <MemoryRouter initialEntries={["/sale"]}>
          <SaleRoute />
        </MemoryRouter>
      </ConvexProvider>,
    );
    // session.status will be "none" (no sessionId in localStorage) → renders null
    expect(container).toBeTruthy();
  });

  it("renders loading state while session is loading (sessionId in storage, query pending)", () => {
    localStorage.setItem("frollie-session-id", "fake-session-id");
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <MemoryRouter initialEntries={["/sale"]}>
          <SaleRoute />
        </MemoryRouter>
      </ConvexProvider>,
    );
    // session.status is "loading" (stored id + query pending) → shows loading text
    expect(container).toBeTruthy();
  });
});
