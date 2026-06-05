import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, test, expect, vi, beforeEach } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ApprovalPending } from "../ApprovalPending";
import type { ApprovalStatus } from "@/hooks/useApproval";

// ---- mock useApproval so we can flip status between renders ----
let mockStatus: ApprovalStatus = "loading";

vi.mock("@/hooks/useApproval", () => ({
  useApproval: () => mockStatus,
}));

const FAKE_ID = "fake-request-id" as any;

beforeEach(() => {
  mockStatus = "loading";
});

describe("ApprovalPending — terminal callbacks", () => {
  test("fires onResolved when status flips to resolved", async () => {
    const onResolved = vi.fn();
    mockStatus = "pending";
    const { rerender } = render(
      <ApprovalPending requestId={FAKE_ID} onResolved={onResolved} />,
    );

    // Flip to resolved
    mockStatus = "resolved";
    rerender(<ApprovalPending requestId={FAKE_ID} onResolved={onResolved} />);

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  test("fires onDenied when status flips to denied", async () => {
    const onDenied = vi.fn();
    mockStatus = "pending";
    const { rerender } = render(
      <ApprovalPending requestId={FAKE_ID} onDenied={onDenied} />,
    );

    // Flip to denied
    mockStatus = "denied";
    rerender(<ApprovalPending requestId={FAKE_ID} onDenied={onDenied} />);

    await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
  });

  test("fires onExpired when status flips to expired", async () => {
    const onExpired = vi.fn();
    mockStatus = "pending";
    const { rerender } = render(
      <ApprovalPending requestId={FAKE_ID} onExpired={onExpired} />,
    );

    // Flip to expired
    mockStatus = "expired";
    rerender(<ApprovalPending requestId={FAKE_ID} onExpired={onExpired} />);

    await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
  });

  test("fires each terminal callback exactly once (idempotent ref guard)", async () => {
    const onDenied = vi.fn();
    mockStatus = "denied";
    const { rerender } = render(
      <ApprovalPending requestId={FAKE_ID} onDenied={onDenied} />,
    );

    // Re-render several times with the same terminal status
    rerender(<ApprovalPending requestId={FAKE_ID} onDenied={onDenied} />);
    rerender(<ApprovalPending requestId={FAKE_ID} onDenied={onDenied} />);

    await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
  });

  test("does not fire any callback while status is loading", () => {
    const onResolved = vi.fn();
    const onDenied = vi.fn();
    const onExpired = vi.fn();
    mockStatus = "loading";

    render(
      <ApprovalPending
        requestId={FAKE_ID}
        onResolved={onResolved}
        onDenied={onDenied}
        onExpired={onExpired}
      />,
    );

    expect(onResolved).not.toHaveBeenCalled();
    expect(onDenied).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
  });

  test("does not fire any callback while status is pending", () => {
    const onResolved = vi.fn();
    const onDenied = vi.fn();
    const onExpired = vi.fn();
    mockStatus = "pending";

    render(
      <ApprovalPending
        requestId={FAKE_ID}
        onResolved={onResolved}
        onDenied={onDenied}
        onExpired={onExpired}
      />,
    );

    expect(onResolved).not.toHaveBeenCalled();
    expect(onDenied).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
  });
});

const REQ = "req_1" as Id<"pos_approval_requests">;

describe("ApprovalPending cancel button (Part C)", () => {
  beforeEach(() => {
    mockStatus = "pending";
  });

  it("shows the cancel button in pending when onCancel is provided and calls it", () => {
    const onCancel = vi.fn();
    render(<ApprovalPending requestId={REQ} onCancel={onCancel} />);
    const btn = screen.getByTestId("approval-cancel");
    fireEvent.click(btn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("hides the cancel button when onCancel is not provided", () => {
    render(<ApprovalPending requestId={REQ} />);
    expect(screen.queryByTestId("approval-cancel")).toBeNull();
  });

  it("hides the cancel button when status is not pending", () => {
    mockStatus = "resolved";
    const onCancel = vi.fn();
    render(<ApprovalPending requestId={REQ} onCancel={onCancel} />);
    expect(screen.queryByTestId("approval-cancel")).toBeNull();
  });
});
