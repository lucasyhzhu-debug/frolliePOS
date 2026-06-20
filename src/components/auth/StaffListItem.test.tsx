import { describe, it, expect, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { StaffListItem } from "./StaffListItem";

// LocaleProvider reads the session locale via useSession → useQuery; stub it so
// the component tree doesn't require a live ConvexProvider.
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "none" }),
}));

describe("StaffListItem", () => {
  it("has a touch pressed-state (active bg + motion-safe scale)", () => {
    render(<StaffListItem name="Lucas" role="manager" onClick={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /lucas/i });
    expect(btn.className).toContain("active:bg-accent");
    expect(btn.className).toContain("motion-safe:active:scale-[.98]");
  });
});
