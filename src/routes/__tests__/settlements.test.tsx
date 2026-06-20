// src/routes/__tests__/settlements.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

let mockSessionReturn: unknown = { sessionId: "s1", staff: { _id: "m1", name: "Lucy", role: "manager" } };
let mockRows: unknown = [];

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/hooks/useIdempotency", () => ({ useIdempotency: () => "key1", clearIntent: vi.fn() }));
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (q: unknown) => {
      const n = getFunctionName(q as never);
      if (n.includes("getSession")) return mockSessionReturn;
      if (n.includes("listSettlements")) return mockRows;
      return undefined;
    },
    useMutation: () => vi.fn(),
    useAction: () => vi.fn(),
  };
});

import Settlements from "@/routes/settlements";
const client = new ConvexReactClient("https://x.convex.cloud");
function renderRoute() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId: "s1" }));
  return render(
    <ConvexProvider client={client}>
      <MemoryRouter initialEntries={["/settlements"]}>
        <Routes><Route path="/settlements" element={<Settlements />} /></Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

beforeEach(() => { toastError.mockClear(); mockRows = []; });

describe("settlements inline validation", () => {
  it("shows inline field errors and fires no toast on invalid submit", () => {
    renderRoute();
    fireEvent.click(screen.getByText("Record settlement"));  // settlements.recordButton
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // settlements.next — enabled after gate-loosening (Step 4b)
    expect(screen.getByText("Invalid date.")).toBeInTheDocument(); // settlements.errorDateInvalid
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("net<0 surfaces under the fee field", () => {
    renderRoute();
    fireEvent.click(screen.getByText("Record settlement"));
    fireEvent.change(screen.getByLabelText("Settlement date"), { target: { value: "2026-06-20" } });
    fireEvent.change(screen.getByLabelText("Gross (Rp)"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Xendit fee (Rp)"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("Transaction count"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("BCA account last 4 digits"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const feeMsg = document.getElementById("entry.mdr-error"); // key stays entry.mdr; field is the fee input
    expect(feeMsg?.textContent).toContain("Fee can't exceed gross");
  });
});
