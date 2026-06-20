import { describe, it, expect, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { PinEntry } from "./PinEntry";

vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "none" }),
}));

describe("PinEntry", () => {
  it("calls onSubmit on the 4th digit", () => {
    const onSubmit = vi.fn();
    render(<PinEntry onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /digit 1/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 2/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 3/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /digit 4/i }));
    expect(onSubmit).toHaveBeenCalledWith("1234");
  });

  it("Clear resets the buffer", () => {
    const onSubmit = vi.fn();
    render(<PinEntry onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /digit 1/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 2/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 9/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 9/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 9/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 9/i }));
    expect(onSubmit).toHaveBeenCalledWith("9999");
  });

  it("shows the spinner and hides the dots while pending, and disables input", () => {
    const onSubmit = vi.fn();
    render(<PinEntry onSubmit={onSubmit} pending />);
    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
    expect(screen.queryByTestId("pin-buffer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /digit 1/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders an error message via FieldMessage (role=alert)", () => {
    render(<PinEntry onSubmit={vi.fn()} phase="error" message="Wrong PIN" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Wrong PIN");
  });

  it("hides a non-persistent error once the staffer types again", () => {
    render(<PinEntry onSubmit={vi.fn()} phase="error" message="Wrong PIN" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /digit 1/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a persistent (locked-out) message even after typing", () => {
    render(<PinEntry onSubmit={vi.fn()} phase="error" message="Locked out — wait 60s." persist />);
    fireEvent.click(screen.getByRole("button", { name: /digit 1/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Locked out");
  });

  it("renders a success message via FieldMessage (role=status) and locks input", () => {
    render(<PinEntry onSubmit={vi.fn()} phase="success" message="Welcome" />);
    expect(screen.getByRole("status")).toHaveTextContent("Welcome");
    expect(screen.getByRole("button", { name: /digit 1/i })).toBeDisabled();
  });
});
