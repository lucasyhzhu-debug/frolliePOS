import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PinEntry } from "./PinEntry";

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
});
