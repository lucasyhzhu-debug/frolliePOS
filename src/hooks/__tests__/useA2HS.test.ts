import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useA2HS } from "@/hooks/useA2HS";
import { INSTALL_DISMISSED_KEY } from "@/lib/storage-keys";

const DAY_MS = 24 * 60 * 60 * 1000;

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function setUA(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

/** Dispatch a synthetic beforeinstallprompt with stubbed prompt()/userChoice. */
function fireBeforeInstall(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const ev = new Event("beforeinstallprompt");
  Object.assign(ev, { prompt, userChoice: Promise.resolve({ outcome }), platforms: ["web"] });
  act(() => {
    window.dispatchEvent(ev);
  });
  return prompt;
}

describe("useA2HS", () => {
  beforeEach(() => {
    localStorage.clear();
    mockMatchMedia(false); // not standalone
    setUA("Mozilla/5.0 (Linux; Android 13; Pixel) AppleWebKit/537 Chrome/120 Mobile");
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cannot install before any beforeinstallprompt fires", () => {
    const { result } = renderHook(() => useA2HS());
    expect(result.current.canInstall).toBe(false);
    expect(result.current.showIOSHint).toBe(false);
  });

  it("captures beforeinstallprompt and flips canInstall", () => {
    const { result } = renderHook(() => useA2HS());
    fireBeforeInstall();
    expect(result.current.canInstall).toBe(true);
  });

  it("is suppressed when running standalone, even after a prompt fires", () => {
    mockMatchMedia(true); // installed PWA
    const { result } = renderHook(() => useA2HS());
    fireBeforeInstall();
    expect(result.current.isStandalone).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });

  it("promptInstall calls the native prompt then clears the affordance", async () => {
    const { result } = renderHook(() => useA2HS());
    const prompt = fireBeforeInstall("accepted");
    await act(async () => {
      await result.current.promptInstall();
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(result.current.canInstall).toBe(false);
  });

  it("dismiss persists a timestamp and hides the affordance", () => {
    const { result } = renderHook(() => useA2HS());
    fireBeforeInstall();
    expect(result.current.canInstall).toBe(true);
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.canInstall).toBe(false);
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).not.toBeNull();
  });

  it("stays hidden on mount when dismissed within the cooldown", () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now() - 1 * DAY_MS));
    const { result } = renderHook(() => useA2HS());
    fireBeforeInstall();
    expect(result.current.canInstall).toBe(false);
  });

  it("re-surfaces once the dismissal cooldown has elapsed", () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now() - 8 * DAY_MS));
    const { result } = renderHook(() => useA2HS());
    fireBeforeInstall();
    expect(result.current.canInstall).toBe(true);
  });

  it("shows static iOS instructions on iOS Safari (no programmatic prompt)", () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Safari/604");
    const { result } = renderHook(() => useA2HS());
    expect(result.current.showIOSHint).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });

  it("marks the app standalone on the appinstalled event", () => {
    const { result } = renderHook(() => useA2HS());
    fireBeforeInstall();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(result.current.isStandalone).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });
});
