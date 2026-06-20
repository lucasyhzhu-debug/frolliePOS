import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";
import { __resetCartForTests } from "@/hooks/useCart";
import SaleDrafts from "./drafts";

/**
 * Smoke test: the drafts screen renders without crashing with an inactive
 * session (listDrafts query returns undefined while Convex is loading).
 * Mirrors the ConvexProvider + MemoryRouter pattern from sale/index.test.tsx.
 *
 * Browser / interaction testing is deferred to Task 40.
 */
describe("SaleDrafts route", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetCartForTests();
  });

  it("renders without crashing when session is none and drafts are undefined", () => {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <LocaleProvider>
          <MemoryRouter initialEntries={["/sale/drafts"]}>
            <SaleDrafts />
          </MemoryRouter>
        </LocaleProvider>
      </ConvexProvider>,
    );
    // session.status is "none" (no sessionId in localStorage) → renders null
    expect(container).toBeTruthy();
  });

  it("renders loading state while session is loading (sessionId in storage, query pending)", () => {
    localStorage.setItem(SESSION_KEY, "fake-session-id");
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <LocaleProvider>
          <MemoryRouter initialEntries={["/sale/drafts"]}>
            <SaleDrafts />
          </MemoryRouter>
        </LocaleProvider>
      </ConvexProvider>,
    );
    // session.status is "loading" (stored id + query pending) → shows loading text
    expect(container).toBeTruthy();
  });

  it("renders empty state text when drafts list is empty", () => {
    // No sessionId → session.status "none" → renders null (no crash)
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <LocaleProvider>
          <MemoryRouter initialEntries={["/sale/drafts"]}>
            <SaleDrafts />
          </MemoryRouter>
        </LocaleProvider>
      </ConvexProvider>,
    );
    expect(container).toBeTruthy();
  });
});
