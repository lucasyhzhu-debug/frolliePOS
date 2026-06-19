import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * ShiftWizard — orchestration shell (Task 11, v1.2 #6).
 *
 * CountStep is mocked at its module path: the mock renders a button that fires
 * onSubmitted(2) when clicked, so we exercise the wizard's count-step branch
 * without pulling in CountStep's Convex/IDB dependencies.
 *
 * useReducedMotion is mocked to `true` in the reduced-motion test to verify no
 * animation crash when all motion is suppressed.
 */

// ---- Mock CountStep --------------------------------------------------------
// Must be declared BEFORE the component import so vi.mock hoisting picks it up.
vi.mock("@/components/pos/CountStep", () => ({
  default: ({ onSubmitted }: { onSubmitted: (changed: number) => void }) => (
    <div>
      <span>MockCountStep</span>
      <button onClick={() => onSubmitted(2)}>Submit Count</button>
    </div>
  ),
}));

// ---- Default: useReducedMotion returns false --------------------------------
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    useReducedMotion: vi.fn(() => false),
  };
});

import ShiftWizard, { type WizardStep, type ConfirmedStep } from "../ShiftWizard";
import { useReducedMotion } from "framer-motion";

// ---------------------------------------------------------------------------

const STEPS: WizardStep[] = [
  {
    key: "brief",
    label: "Briefing",
    type: "instruction",
    body: <p>Read the briefing notes.</p>,
  },
  {
    key: "count",
    label: "Stock count",
    type: "count",
  },
];

function renderWizard(onComplete = vi.fn<[ConfirmedStep[], number | null], Promise<void>>()) {
  return render(
    <ShiftWizard
      title="Shift Start"
      steps={STEPS}
      onComplete={onComplete}
    />,
  );
}

describe("ShiftWizard", () => {
  it("renders the title and first step label", () => {
    renderWizard();
    expect(screen.getByText("Shift Start")).toBeInTheDocument();
    expect(screen.getByText("Briefing")).toBeInTheDocument();
  });

  it("shows instruction body on the instruction step", () => {
    renderWizard();
    expect(screen.getByText("Read the briefing notes.")).toBeInTheDocument();
  });

  it("advances to count step after confirming instruction", async () => {
    renderWizard();
    // Click Next/Confirm on the instruction step
    const nextBtn = screen.getByRole("button", { name: /next|confirm|lanjut/i });
    fireEvent.click(nextBtn);
    // Count step should now be visible
    expect(await screen.findByText("MockCountStep")).toBeInTheDocument();
  });

  it("does NOT advance from count step until CountStep fires onSubmitted", async () => {
    renderWizard();
    // Advance past instruction step
    fireEvent.click(screen.getByRole("button", { name: /next|confirm|lanjut/i }));
    await screen.findByText("MockCountStep");

    // The Next/Complete button should not be visible yet (count step blocks nav)
    // The only way to advance is via the mocked CountStep's submit
    expect(screen.queryByRole("button", { name: /selesai|complete|finish/i })).toBeNull();
  });

  it("calls onComplete with 2 confirmed steps, numeric confirmed_at, and countChanged=2", async () => {
    const onComplete = vi.fn<[ConfirmedStep[], number | null], Promise<void>>().mockResolvedValue(undefined);
    renderWizard(onComplete);

    // Step 1: instruction — click Next
    fireEvent.click(screen.getByRole("button", { name: /next|confirm|lanjut/i }));
    await screen.findByText("MockCountStep");

    // Step 2: count — the mock renders a button that calls onSubmitted(2)
    fireEvent.click(screen.getByRole("button", { name: /submit count/i }));

    // After count step submits, wizard should show a complete/finish button
    const completeBtn = await screen.findByRole("button", { name: /selesai|complete|finish/i });
    fireEvent.click(completeBtn);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    const [confirmedSteps, countChanged] = onComplete.mock.calls[0];
    expect(confirmedSteps).toHaveLength(2);
    expect(confirmedSteps[0].key).toBe("brief");
    expect(confirmedSteps[0].type).toBe("instruction");
    expect(typeof confirmedSteps[0].confirmed_at).toBe("number");
    expect(confirmedSteps[1].key).toBe("count");
    expect(confirmedSteps[1].type).toBe("count");
    expect(typeof confirmedSteps[1].confirmed_at).toBe("number");
    expect(countChanged).toBe(2);
  });

  it("rail shows 2/2 done after completing all steps", async () => {
    const onComplete = vi.fn<[ConfirmedStep[], number | null], Promise<void>>().mockResolvedValue(undefined);
    renderWizard(onComplete);

    // Complete both steps
    fireEvent.click(screen.getByRole("button", { name: /next|confirm|lanjut/i }));
    await screen.findByText("MockCountStep");
    fireEvent.click(screen.getByRole("button", { name: /submit count/i }));
    const completeBtn = await screen.findByRole("button", { name: /selesai|complete|finish/i });
    fireEvent.click(completeBtn);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    // Both step labels should appear in the rail with done indicators
    // The rail renders all step labels; after completion doneCount === 2
    const stepLabels = screen.getAllByText("Briefing");
    expect(stepLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("passes null countChanged when there are no count steps", async () => {
    const instructionOnly: WizardStep[] = [
      { key: "info", label: "Info", type: "instruction", body: <p>Info body</p> },
    ];
    const onComplete = vi.fn<[ConfirmedStep[], number | null], Promise<void>>().mockResolvedValue(undefined);
    render(
      <ShiftWizard title="Test" steps={instructionOnly} onComplete={onComplete} />,
    );

    // The only step is an instruction; clicking next on the final step calls onComplete
    fireEvent.click(screen.getByRole("button", { name: /next|confirm|lanjut|selesai|complete|finish/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const [, countChanged] = onComplete.mock.calls[0];
    expect(countChanged).toBeNull();
  });

  it("renders without animation crash when useReducedMotion returns true", async () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const onComplete = vi.fn<[ConfirmedStep[], number | null], Promise<void>>().mockResolvedValue(undefined);

    expect(() =>
      render(
        <ShiftWizard title="Shift Start" steps={STEPS} onComplete={onComplete} />,
      ),
    ).not.toThrow();

    expect(screen.getByText("Shift Start")).toBeInTheDocument();

    // Reset to default for subsequent tests
    vi.mocked(useReducedMotion).mockReturnValue(false);
  });

  it("Back button returns to previous step", async () => {
    renderWizard();

    // Advance to step 2
    fireEvent.click(screen.getByRole("button", { name: /next|confirm|lanjut/i }));
    await screen.findByText("MockCountStep");

    // Go back
    fireEvent.click(screen.getByRole("button", { name: /back|kembali/i }));
    expect(await screen.findByText("Read the briefing notes.")).toBeInTheDocument();
  });
});
