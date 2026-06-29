import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";
import type { A2HSState } from "@/hooks/useA2HS";

let mockState: A2HSState;

vi.mock("@/hooks/useA2HS", () => ({
  useA2HS: () => mockState,
}));

// LocaleProvider reads the session via useQuery; stub Convex so the provider
// mounts (unauthenticated → English) without a real client.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useQuery: () => undefined, useMutation: () => vi.fn() };
});

import { InstallPrompt } from "@/components/pos/InstallPrompt";

function baseState(overrides: Partial<A2HSState> = {}): A2HSState {
  return {
    canInstall: false,
    showIOSHint: false,
    isStandalone: false,
    promptInstall: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    ...overrides,
  };
}

function renderPrompt() {
  return render(
    <LocaleProvider>
      <InstallPrompt />
    </LocaleProvider>,
  );
}

describe("InstallPrompt", () => {
  beforeEach(() => {
    mockState = baseState();
  });

  it("renders nothing when neither install nor iOS hint applies", () => {
    const { container } = renderPrompt();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the Install button when canInstall and fires promptInstall", () => {
    const promptInstall = vi.fn().mockResolvedValue(undefined);
    mockState = baseState({ canInstall: true, promptInstall });
    renderPrompt();
    const btn = screen.getByRole("button", { name: "Install" });
    fireEvent.click(btn);
    expect(promptInstall).toHaveBeenCalledOnce();
  });

  it("shows static iOS instructions without an Install button", () => {
    mockState = baseState({ showIOSHint: true });
    renderPrompt();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument();
  });

  it("fires dismiss when the close button is tapped", () => {
    const dismiss = vi.fn();
    mockState = baseState({ canInstall: true, dismiss });
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
