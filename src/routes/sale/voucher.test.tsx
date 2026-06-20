import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";
import { __resetCartForTests } from "@/hooks/useCart";
import SaleVoucher from "./voucher";

/**
 * Smoke test: the voucher screen renders without crashing with an inactive
 * session and an empty cart (validateVoucher query is skipped when code is
 * empty). Mirrors the ConvexProvider + MemoryRouter pattern from
 * sale/index.test.tsx.
 *
 * Browser / interaction testing is deferred to Task 40.
 */
describe("SaleVoucher route", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetCartForTests();
  });

  it("renders without crashing when cart is empty and code is blank", () => {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <LocaleProvider>
          <MemoryRouter initialEntries={["/sale/voucher"]}>
            <SaleVoucher />
          </MemoryRouter>
        </LocaleProvider>
      </ConvexProvider>,
    );
    expect(container).toBeTruthy();
  });

  it("renders with sessionId in storage (loading state) without crashing", () => {
    localStorage.setItem(SESSION_KEY, "fake-session-id");
    const convex = new ConvexReactClient("https://example.convex.cloud");
    const { container } = render(
      <ConvexProvider client={convex}>
        <LocaleProvider>
          <MemoryRouter initialEntries={["/sale/voucher"]}>
            <SaleVoucher />
          </MemoryRouter>
        </LocaleProvider>
      </ConvexProvider>,
    );
    expect(container).toBeTruthy();
  });
});
