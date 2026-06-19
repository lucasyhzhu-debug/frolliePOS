import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

const setOwnLocale = vi.fn().mockResolvedValue({ ok: true });
vi.mock("convex/react", () => ({ useMutation: () => setOwnLocale }));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "active", sessionId: "s1", staff: { _id: "st1", name: "A", role: "staff", must_change_pin: false, locale: "en" } }),
}));

import { LocaleProvider } from "@/lib/i18n";
import { LocaleToggle } from "../LocaleToggle";

describe("LocaleToggle", () => {
  it("shows the active language and flips + persists on tap", async () => {
    render(<LocaleProvider><LocaleToggle /></LocaleProvider>);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false"); // en
    await act(async () => { sw.click(); });
    expect(sw).toHaveAttribute("aria-checked", "true"); // optimistic → id
    expect(setOwnLocale).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", locale: "id" }),
    );
  });
});
