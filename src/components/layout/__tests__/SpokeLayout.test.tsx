import { describe, test, expect, vi } from "vitest";
import { renderWithLocale as render, screen } from "@/test-utils";
import { MemoryRouter } from "react-router";
import { SpokeLayout } from "../SpokeLayout";

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

describe("SpokeLayout", () => {
  test("SpokeLayout renders children below header", () => {
    render(
      <MemoryRouter>
        <SpokeLayout title="X">
          <div>BODY</div>
        </SpokeLayout>
      </MemoryRouter>,
    );
    expect(screen.getByText("X")).toBeInTheDocument();
    expect(screen.getByText("BODY")).toBeInTheDocument();
  });
});
