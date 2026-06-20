import { describe, it, expect, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { NumericKeypad } from "./NumericKeypad";

// LocaleProvider reads the session locale via useSession → useQuery; stub it so
// the component tree doesn't require a live ConvexProvider (mirrors PinEntry.test).
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "none" }),
}));

describe("NumericKeypad", () => {
  it("fires onPress on click when enabled", () => {
    const onPress = vi.fn();
    render(<NumericKeypad onPress={onPress} />);
    fireEvent.click(screen.getByRole("button", { name: /digit 5/i }));
    expect(onPress).toHaveBeenCalledWith("5");
  });

  it("does not fire onPress when disabled (click)", () => {
    const onPress = vi.fn();
    render(<NumericKeypad onPress={onPress} disabled />);
    const five = screen.getByRole("button", { name: /digit 5/i });
    expect(five).toBeDisabled();
    fireEvent.click(five);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("ignores hardware keydown when disabled", () => {
    const onPress = vi.fn();
    render(<NumericKeypad onPress={onPress} disabled />);
    fireEvent.keyDown(document, { key: "7" });
    expect(onPress).not.toHaveBeenCalled();
  });

  it("still handles hardware keydown when enabled", () => {
    const onPress = vi.fn();
    render(<NumericKeypad onPress={onPress} />);
    fireEvent.keyDown(document, { key: "7" });
    expect(onPress).toHaveBeenCalledWith("7");
  });

  it("digit keys carry the active:bg-accent pressed cue", () => {
    render(<NumericKeypad onPress={vi.fn()} />);
    expect(screen.getByRole("button", { name: /digit 5/i }).className).toContain("active:bg-accent");
  });
});
