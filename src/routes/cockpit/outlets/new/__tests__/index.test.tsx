/**
 * Tests for CockpitOutletNew (v1.3.0 Task 11) — multi-step new-outlet wizard.
 *
 * Covers:
 *   1. Blank vs clone fork — step 4 (settings) prefill behaviour differs.
 *   2. Code uniqueness blocks "Next" on a dup code (FieldMessage shown, button disabled).
 *   3. "Create" calls createOutlet with assembled payload + idempotencyKey.
 *   4. On success: setCurrentOutlet(newId) called + navigate to /cockpit/outlets.
 *
 * Mock strategy mirrors src/routes/cockpit/__tests__/index.test.tsx:
 *   - convex/react: useAction → mockCreateOutlet; useQuery tracks call parity to
 *     alternate between listOutlets (even calls) and listAssignableStaff (odd calls).
 *   - useSession, useIdempotency, useOutletContext, sonner, framer-motion all stubbed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, waitFor, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import CockpitOutletNew from "../index";

// ── Hoisted mock factories ─────────────────────────────────────────────────────

const { mockCreateOutlet, mockSetCurrentOutlet, mockUseQuery } = vi.hoisted(() => ({
  mockCreateOutlet: vi.fn().mockResolvedValue({ outlet_id: "new-outlet-001" }),
  mockSetCurrentOutlet: vi.fn(),
  mockUseQuery: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useAction: vi.fn(() => mockCreateOutlet),
    useQuery: mockUseQuery,
  };
});

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});

vi.mock("@/contexts/OutletContext", () => ({
  useOutletContext: () => ({
    outlets: MOCK_OUTLETS,
    currentOutletId: "all",
    setCurrentOutlet: mockSetCurrentOutlet,
  }),
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idem-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({
    status: "active",
    sessionId: "kn7ses000000000000000000000",
    kind: "cockpit",
    staff: { _id: "kn7own", name: "Lucas", role: "owner" },
  })),
  clearSession: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

const MOCK_OUTLETS = [
  {
    _id: "outlets_pkw" as never,
    code: "PKW",
    name: "Pakuwon",
    address: "Level 2",
    timezone: "Asia/Jakarta",
    active: true,
    created_at: 0,
  },
];

const MOCK_STAFF = [
  { _id: "staff_s1" as never, name: "Sari", code: "S-0001", role: "staff" as const },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Configure useQuery to alternate between outlets (even calls) and staff (odd).
 * This mirrors the hook call order in the wizard: listOutlets then listAssignableStaff.
 */
function setupDefaultQueries(
  outlets = MOCK_OUTLETS,
  staff = MOCK_STAFF,
) {
  mockUseQuery.mockImplementation((_fn: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const idx = mockUseQuery.mock.calls.length - 1;
    return idx % 2 === 0 ? outlets : staff;
  });
}

function renderWizard() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/cockpit/outlets/new"]}>
        <Routes>
          <Route path="/cockpit/outlets/new" element={<CockpitOutletNew />} />
          <Route
            path="/cockpit/outlets"
            element={<div data-testid="outlets-page" />}
          />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

/** Click "Next" and wait for the next step to appear. */
async function clickNext() {
  fireEvent.click(screen.getByTestId("btn-next"));
  // Let React flush any AnimatePresence transitions.
  await waitFor(() => {});
}

/** Navigate from step 0 to step N by clicking Next N times (filling required fields). */
async function navigateToStep(
  n: number,
  opts: { outletName?: string; outletCode?: string } = {},
) {
  const name = opts.outletName ?? "Test Outlet";
  const code = opts.outletCode ?? "TST";

  for (let s = 0; s < n; s++) {
    if (s === 1) {
      // Step 1 (Name+Code) requires filling in name + code before Next.
      const nameInput = await waitFor(() => screen.getByLabelText(/outlet name/i));
      fireEvent.change(nameInput, { target: { value: name } });
      const codeInput = screen.getByLabelText(/^code$/i);
      fireEvent.change(codeInput, { target: { value: code } });
    }
    await clickNext();
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateOutlet.mockResolvedValue({ outlet_id: "new-outlet-001" });
  setupDefaultQueries();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("CockpitOutletNew wizard", () => {
  // ── Step 0 + prefill ──────────────────────────────────────────────────────────

  it("blank mode: step 4 receipt_business_name starts empty", async () => {
    renderWizard();
    // Default mode is blank — just navigate to step 4.
    await navigateToStep(4);
    await waitFor(() =>
      expect(screen.getByLabelText(/receipt business name/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/receipt business name/i)).toHaveValue("");
  });

  it("clone mode: step 4 receipt_business_name pre-filled with source outlet name", async () => {
    renderWizard();

    // Step 0: select clone mode then select the source outlet.
    const cloneBtn = await waitFor(() => screen.getByTestId("mode-clone"));
    fireEvent.click(cloneBtn);
    const sourceBtn = await waitFor(() => screen.getByTestId("source-PKW"));
    fireEvent.click(sourceBtn);

    // Now navigate from step 0 to step 4 (click Next 4 times, filling step 1).
    await navigateToStep(4);

    await waitFor(() =>
      expect(screen.getByLabelText(/receipt business name/i)).toBeInTheDocument(),
    );
    // Prefill from source outlet name "Pakuwon".
    expect(screen.getByLabelText(/receipt business name/i)).toHaveValue("Pakuwon");
  });

  // ── Code uniqueness ───────────────────────────────────────────────────────────

  it("step 1: blocks Next when code matches an existing outlet code", async () => {
    renderWizard();
    // Advance to step 1.
    await clickNext();
    await waitFor(() => screen.getByLabelText(/outlet name/i));

    // Fill in name + a code that already exists.
    fireEvent.change(screen.getByLabelText(/outlet name/i), {
      target: { value: "Another Outlet" },
    });
    fireEvent.change(screen.getByLabelText(/^code$/i), {
      target: { value: "pkw" }, // lowercase — wizard auto-uppercases to "PKW"
    });

    // Error message visible.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/already taken/i);

    // Next button disabled.
    expect(screen.getByTestId("btn-next")).toBeDisabled();
  });

  it("step 1: Next is enabled when a non-dup code is entered", async () => {
    renderWizard();
    await clickNext();
    await waitFor(() => screen.getByLabelText(/outlet name/i));

    fireEvent.change(screen.getByLabelText(/outlet name/i), {
      target: { value: "New Branch" },
    });
    fireEvent.change(screen.getByLabelText(/^code$/i), {
      target: { value: "NEW" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("btn-next")).not.toBeDisabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // ── Create action ─────────────────────────────────────────────────────────────

  it("Create calls createOutlet with assembled payload + idempotencyKey", async () => {
    renderWizard();
    // Navigate through all 7 steps then click Create on step 7.
    await navigateToStep(7, { outletName: "My Outlet", outletCode: "MYO" });

    await waitFor(() =>
      expect(screen.getByTestId("btn-create")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("btn-create"));

    await waitFor(() => expect(mockCreateOutlet).toHaveBeenCalledTimes(1));
    expect(mockCreateOutlet).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "test-idem-key",
        sessionId: "kn7ses000000000000000000000",
        mode: "blank",
        name: "My Outlet",
        code: "MYO",
        timezone: "Asia/Jakarta",
        provision_managers_chat: false,
      }),
    );
  });

  it("on success: setCurrentOutlet called with new id + navigates to /cockpit/outlets", async () => {
    renderWizard();
    await navigateToStep(7);

    await waitFor(() =>
      expect(screen.getByTestId("btn-create")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("btn-create"));

    await waitFor(() => expect(mockSetCurrentOutlet).toHaveBeenCalledWith("new-outlet-001"));
    await waitFor(() =>
      expect(screen.getByTestId("outlets-page")).toBeInTheDocument(),
    );
  });

  it("on createOutlet failure: shows error toast and stays on review step", async () => {
    const { toast } = await import("sonner");
    mockCreateOutlet.mockRejectedValueOnce(new Error("OUTLET_CODE_TAKEN"));

    renderWizard();
    await navigateToStep(7);

    await waitFor(() => screen.getByTestId("btn-create"));
    fireEvent.click(screen.getByTestId("btn-create"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // Still on review step (Create button still visible).
    expect(screen.queryByTestId("btn-create")).toBeInTheDocument();
    expect(screen.queryByTestId("outlets-page")).not.toBeInTheDocument();
  });
});
