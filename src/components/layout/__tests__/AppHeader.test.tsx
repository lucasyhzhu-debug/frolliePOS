import { describe, test, expect, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppHeader } from "../AppHeader";

vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "active",
    sessionId: "kn7s0" as any,
    staff: { _id: "kn7" as any, name: "Lucas", role: "manager" as const },
  }),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({
    connectionState: () => ({ isWebSocketConnected: true }),
    onStateChange: (cb: () => void) => {
      cb();
      return () => {};
    },
  }),
}));

describe("AppHeader", () => {
  test("renders title and staff name", () => {
    render(
      <MemoryRouter>
        <AppHeader title="New sale" />
      </MemoryRouter>,
    );
    expect(screen.getByText("New sale")).toBeInTheDocument();
    expect(screen.getByText("Lucas")).toBeInTheDocument();
  });

  test("back button navigates to /", async () => {
    render(
      <MemoryRouter initialEntries={["/sale"]}>
        <Routes>
          <Route path="/sale" element={<AppHeader title="New sale" />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /home/i }));
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  test("calls onBack override instead of default navigation when provided", () => {
    const onBack = vi.fn();
    render(
      <MemoryRouter>
        <AppHeader title="X" onBack={onBack} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /home/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
