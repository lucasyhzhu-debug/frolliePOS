import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VoucherRejectBanner } from "../voucher-reject-banner";

describe("VoucherRejectBanner", () => {
  it("renders EXPIRED humanization", () => {
    render(<VoucherRejectBanner rejected={{ code: "OLD", reason: "EXPIRED" }} onPickAnother={() => {}} />);
    expect(screen.getByText(/OLD/)).toBeInTheDocument();
    expect(screen.getByText(/expired between cart-build and payment/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pick a different voucher/i })).toBeInTheDocument();
  });

  it("renders MIN_CART_VALUE humanization", () => {
    render(<VoucherRejectBanner rejected={{ code: "BIG", reason: "MIN_CART_VALUE" }} onPickAnother={() => {}} />);
    expect(screen.getByText(/needs a higher cart total/i)).toBeInTheDocument();
  });

  it("renders INACTIVE humanization", () => {
    render(<VoucherRejectBanner rejected={{ code: "X", reason: "INACTIVE" }} onPickAnother={() => {}} />);
    expect(screen.getByText(/is no longer active/i)).toBeInTheDocument();
  });

  it("renders NOT_FOUND humanization", () => {
    render(<VoucherRejectBanner rejected={{ code: "GHOST", reason: "NOT_FOUND" }} onPickAnother={() => {}} />);
    expect(screen.getByText(/was removed by the manager/i)).toBeInTheDocument();
  });

  it("invokes onPickAnother when the button is clicked", () => {
    const fn = vi.fn();
    render(<VoucherRejectBanner rejected={{ code: "Q", reason: "EXPIRED" }} onPickAnother={fn} />);
    screen.getByRole("button", { name: /Pick a different voucher/i }).click();
    expect(fn).toHaveBeenCalledOnce();
  });
});
