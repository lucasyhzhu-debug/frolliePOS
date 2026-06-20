import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { ConvexProvider, ConvexReactClient } from "convex/react";

/**
 * CountStep — shared SKU-recount UI (Task 10, v1.2 #6).
 *
 * Trap: useIdempotency returns undefined for a render cycle under jsdom (IDB
 * not available). Mock it to a stable string so the submit button is not
 * permanently disabled by the `!key` guard.
 */

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(),
    useMutation: vi.fn(),
  };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({
    status: "active",
    sessionId: "session-test-1",
    staff: { _id: "staff_1", name: "Bayu", role: "staff" },
  })),
}));

// CRITICAL: mock useIdempotency to a STABLE string so the submit button is
// enabled on first render (the real IDB hook resolves undefined for one cycle,
// which permanently disables submit in jsdom — the #12 exec trap).
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "recount:session-test-1:stub-key"),
  clearIntent: vi.fn(),
  __resetForTests: vi.fn(),
}));

import { useQuery, useMutation } from "convex/react";
import CountStep from "../CountStep";

const FAKE_SKUS = [
  { skuId: "sku1", name: "Dubai 1pc", on_hand: 10, status: "ok" },
  { skuId: "sku2", name: "Dubai 8pc", on_hand: 5, status: "ok" },
];

const mockRecordRecount = vi.fn();

function renderCountStep(onSubmitted = vi.fn(), submitLabel?: string) {
  vi.mocked(useQuery).mockReturnValue(FAKE_SKUS);
  vi.mocked(useMutation).mockReturnValue(mockRecordRecount);

  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <CountStep onSubmitted={onSubmitted} submitLabel={submitLabel} />
    </ConvexProvider>,
  );
}

describe("CountStep", () => {
  beforeEach(() => {
    mockRecordRecount.mockReset();
    mockRecordRecount.mockResolvedValue({ changed: 1 });
  });

  it("renders both SKU rows with system on_hand", () => {
    renderCountStep();
    expect(screen.getByText("Dubai 1pc")).toBeInTheDocument();
    expect(screen.getByText("System: 10")).toBeInTheDocument();
    expect(screen.getByText("Dubai 8pc")).toBeInTheDocument();
    expect(screen.getByText("System: 5")).toBeInTheDocument();
  });

  it("uses custom submitLabel when provided", () => {
    renderCountStep(vi.fn(), "Simpan hitungan");
    expect(
      screen.getByRole("button", { name: /simpan hitungan/i }),
    ).toBeInTheDocument();
  });

  it("shows live delta when count differs from on_hand", () => {
    renderCountStep();
    // Input uses inputMode="numeric" (not type="number") so role is textbox.
    // First input corresponds to Dubai 1pc (on_hand=10); type 12 → delta = +2.
    const [firstInput] = screen.getAllByDisplayValue("");
    fireEvent.change(firstInput, { target: { value: "12" } });
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("calls recordRecount with entered counts and fires onSubmitted with changed", async () => {
    const onSubmitted = vi.fn();
    renderCountStep(onSubmitted);

    // Type a count for the first SKU (Dubai 1pc)
    const [firstInput] = screen.getAllByDisplayValue("");
    fireEvent.change(firstInput, { target: { value: "8" } });

    const btn = screen.getByRole("button", { name: /save count|submit/i });
    fireEvent.click(btn);

    await waitFor(() => expect(mockRecordRecount).toHaveBeenCalledTimes(1));
    const call = mockRecordRecount.mock.calls[0][0];
    expect(call.idempotencyKey).toBe("recount:session-test-1:stub-key");
    expect(call.sessionId).toBe("session-test-1");
    expect(call.counts).toEqual(
      expect.arrayContaining([{ skuId: "sku1", entered: 8 }]),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(1));
  });

  it("shows error message (FieldMessage) when payload is empty", async () => {
    renderCountStep();
    // Click submit without entering any counts
    const btn = screen.getByRole("button", { name: /save count|submit/i });
    fireEvent.click(btn);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mockRecordRecount).not.toHaveBeenCalled();
  });

  it("shows error message on DUPLICATE_SKU server error", async () => {
    mockRecordRecount.mockRejectedValue(new Error("DUPLICATE_SKU"));
    const onSubmitted = vi.fn();
    renderCountStep(onSubmitted);

    const [firstInput] = screen.getAllByDisplayValue("");
    fireEvent.change(firstInput, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /save count|submit/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("strips non-numeric characters from input", () => {
    renderCountStep();
    const [firstInput] = screen.getAllByDisplayValue("");
    fireEvent.change(firstInput, { target: { value: "12abc" } });
    expect(firstInput).toHaveValue("12");
  });
});
