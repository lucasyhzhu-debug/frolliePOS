// src/components/layout/__tests__/DeviceActivation.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/hooks/useDeviceId", () => ({ useDeviceId: () => "dev1" }));
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "key1",
  clearIntent: vi.fn(),
}));
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useAction: () => vi.fn(),
  };
});

import { DeviceActivation } from "@/components/layout/DeviceActivation";

const client = new ConvexReactClient("https://x.convex.cloud");
function renderComp() {
  return render(
    <ConvexProvider client={client}>
      <MemoryRouter>
        <DeviceActivation />
      </MemoryRouter>
    </ConvexProvider>,
  );
}

beforeEach(() => { toastError.mockClear(); });

describe("DeviceActivation inline validation", () => {
  it("shows inline code-digits error and fires no toast on empty submit", () => {
    renderComp();
    // deviceId is mocked → button is enabled; code is empty → should show inline error
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(screen.getByText("Code must be 6 digits")).toBeInTheDocument();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows inline label error when code is valid but label is empty", () => {
    renderComp();
    const codeInput = screen.getByLabelText(/setup code/i);
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(screen.getByText("Enter a device label")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("clears code error on code input change", () => {
    renderComp();
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(screen.getByText("Code must be 6 digits")).toBeInTheDocument();
    // Changing the input should clear the inline error
    const codeInput = screen.getByLabelText(/setup code/i);
    fireEvent.change(codeInput, { target: { value: "1" } });
    expect(screen.queryByText("Code must be 6 digits")).not.toBeInTheDocument();
  });
});
