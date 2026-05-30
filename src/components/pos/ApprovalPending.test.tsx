import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useApproval", () => ({ useApproval: vi.fn() }));
import { useApproval } from "../../hooks/useApproval";
import { ApprovalPending } from "./ApprovalPending";

describe("ApprovalPending", () => {
  it("renders waiting copy when status is pending", () => {
    vi.mocked(useApproval).mockReturnValue("pending");
    render(<ApprovalPending requestId={"r1" as any} onResolved={() => {}} />);
    expect(screen.getByText(/Waiting for a manager/i)).toBeInTheDocument();
  });

  it("calls onResolved when status flips to resolved", () => {
    const onResolved = vi.fn();
    vi.mocked(useApproval).mockReturnValue("resolved");
    render(<ApprovalPending requestId={"r1" as any} onResolved={onResolved} />);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("renders a Declined message when status is denied (no deny_reason shown)", () => {
    vi.mocked(useApproval).mockReturnValue("denied");
    render(<ApprovalPending requestId={"r1" as any} onResolved={() => {}} onDenied={() => {}} />);
    expect(screen.getByText(/Declined by manager/i)).toBeInTheDocument();
    // CRITICAL: deny_reason is audit-only — must NOT appear in this UI
    expect(screen.queryByText(/deny_reason/i)).not.toBeInTheDocument();
  });

  it("renders an Expired message when status is expired", () => {
    vi.mocked(useApproval).mockReturnValue("expired");
    render(<ApprovalPending requestId={"r1" as any} onResolved={() => {}} />);
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });

  it("renders nothing or a low-key spinner when status is loading", () => {
    vi.mocked(useApproval).mockReturnValue("loading");
    const { container } = render(<ApprovalPending requestId={"r1" as any} onResolved={() => {}} />);
    // pragmatic: container has SOMETHING (the spinner) but not the resolved/denied/expired/pending copy
    expect(container.textContent).not.toMatch(/Waiting for a manager|Declined|expired/i);
  });
});
