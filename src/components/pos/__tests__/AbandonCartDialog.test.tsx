import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AbandonCartDialog } from "../AbandonCartDialog";

describe("AbandonCartDialog", () => {
  // --- cart variant ---

  test("cart variant: Save as draft calls onSaveDraft and proceeds", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    const onProceed = vi.fn();
    render(
      <AbandonCartDialog
        variant="cart"
        open
        onCancel={vi.fn()}
        onProceed={onProceed}
        onSaveDraft={onSaveDraft}
        onDiscard={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onProceed).toHaveBeenCalled();
  });

  test("cart variant: Discard calls onDiscard and proceeds", async () => {
    const onDiscard = vi.fn();
    const onProceed = vi.fn();
    render(
      <AbandonCartDialog
        variant="cart"
        open
        onCancel={vi.fn()}
        onProceed={onProceed}
        onSaveDraft={vi.fn().mockResolvedValue(undefined)}
        onDiscard={onDiscard}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalled());
    expect(onProceed).toHaveBeenCalled();
  });

  test("cart variant: Cancel calls onCancel, no proceed", async () => {
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    render(
      <AbandonCartDialog
        variant="cart"
        open
        onCancel={onCancel}
        onProceed={onProceed}
        onSaveDraft={vi.fn().mockResolvedValue(undefined)}
        onDiscard={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(onProceed).not.toHaveBeenCalled();
  });

  // --- payment variant ---

  test("payment variant: Cancel payment calls onCancelPayment and proceeds", async () => {
    const onCancelPayment = vi.fn().mockResolvedValue(undefined);
    const onProceed = vi.fn();
    render(
      <AbandonCartDialog
        variant="payment"
        open
        onCancel={vi.fn()}
        onProceed={onProceed}
        onCancelPayment={onCancelPayment}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel payment/i }));
    await waitFor(() => expect(onCancelPayment).toHaveBeenCalled());
    expect(onProceed).toHaveBeenCalled();
  });

  test("payment variant: Keep waiting calls onCancel, no proceed", async () => {
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    render(
      <AbandonCartDialog
        variant="payment"
        open
        onCancel={onCancel}
        onProceed={onProceed}
        onCancelPayment={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /keep waiting/i }));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(onProceed).not.toHaveBeenCalled();
  });
});
