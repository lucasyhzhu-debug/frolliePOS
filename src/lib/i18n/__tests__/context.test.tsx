// src/lib/i18n/__tests__/context.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LocaleProvider, useLocale, useT } from "../context";

// useSession is the seed source; default to no active session (English default).
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "none", sessionId: null, staff: null }),
}));

function Probe() {
  const t = useT();
  const [locale, setLocale] = useLocale();
  return (
    <div>
      <span data-testid="label">{t("home.newSale")}</span>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale("id")}>switch</button>
    </div>
  );
}

describe("LocaleProvider", () => {
  it("defaults to English and switches on setLocale", () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId("locale").textContent).toBe("en");
    expect(screen.getByTestId("label").textContent).toBe("New sale");
    act(() => { screen.getByText("switch").click(); });
    expect(screen.getByTestId("locale").textContent).toBe("id");
    expect(screen.getByTestId("label").textContent).toBe("Penjualan baru");
  });
});
