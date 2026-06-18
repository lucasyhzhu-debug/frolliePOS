import { render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "../dialog";

describe("DialogContent", () => {
  // Regression guard for #8 (v1.2 Phase 0): without a viewport height cap +
  // internal scroll, tall dialogs (PinSheet, PrinterSheet, mgr admin dialogs)
  // clip their header/footer off-screen on the booth tablet. jsdom does no
  // layout, so this only guards the classes against accidental deletion — the
  // load-bearing proof is the emulated-viewport check in the plan.
  test("caps height at the viewport and scrolls internally", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    const content = screen.getByRole("dialog");
    expect(content.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(content.className).toContain("overflow-y-auto");
  });
});
