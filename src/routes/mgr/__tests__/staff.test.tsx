// src/routes/mgr/__tests__/staff.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * /mgr/staff inline-validation smoke test.
 *
 * Mocking pattern mirrors settlements.test.tsx: hoisted toastError spy,
 * useIdempotency → "key1", useQuery dispatched by function name.
 */

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};
let mockStaffReturn: unknown = [];

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "key1",
  clearIntent: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(
          query as Parameters<typeof getFunctionName>[0],
        );
      } catch {
        name = "";
      }
      if (name.includes("listStaff")) return mockStaffReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: () => vi.fn().mockResolvedValue({}),
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

import MgrStaff from "../staff";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/staff"]}>
        <Routes>
          <Route path="/mgr/staff" element={<MgrStaff />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrStaff route (/mgr/staff)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    toastError.mockClear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    mockStaffReturn = [];
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("add-staff invalid shows inline errors, no toast", () => {
    renderRoute();
    fireEvent.click(screen.getByText("Add staff")); // mgrStaff.addStaff
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // mgrStaff.continue, now enabled
    expect(screen.getByText("Name must be 1–60 characters.")).toBeInTheDocument();
    expect(screen.getByText("PIN must be 4 digits.")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});
