import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PinSheet } from "./PinSheet";

describe("PinSheet", () => {
  it("renders title + label + keypad", () => {
    render(
      <PinSheet
        open
        title="Manager override"
        label="Enter your manager PIN"
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText("Manager override")).toBeInTheDocument();
    expect(screen.getByText("Enter your manager PIN")).toBeInTheDocument();
  });

  it("calls onSubmit with the 4-digit PIN when complete", () => {
    const onSubmit = vi.fn();
    render(
      <PinSheet open title="t" label="l" onSubmit={onSubmit} onCancel={() => {}} />
    );
    // NumericKeypad renders digit buttons with aria-label="Digit N"
    fireEvent.click(screen.getByRole("button", { name: /digit 1/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 2/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 3/i }));
    fireEvent.click(screen.getByRole("button", { name: /digit 4/i }));
    expect(onSubmit).toHaveBeenCalledWith("1234");
  });

  it("shows a verifying indicator while pending", () => {
    render(
      <PinSheet
        open
        title="t"
        label="l"
        pending
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText(/verifying|loading/i)).toBeInTheDocument();
  });
});
