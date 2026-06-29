import { useCallback, useEffect, useState } from "react";
import { INSTALL_DISMISSED_KEY } from "@/lib/storage-keys";

/**
 * The non-standard `beforeinstallprompt` event (Chromium / Android only — the
 * booth's actual platform). We capture it, call `preventDefault()` to suppress
 * Chrome's own mini-infobar, and stash it so our in-app affordance can drive the
 * native install dialog on demand. iOS Safari never fires this.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Re-surface the install nudge this long after a staffer dismisses it. A
// one-time dismiss would bury the affordance forever, but staff turn over and a
// freshly-onboarded operator should still be prompted to install. (Roadmap
// decision: re-show after 7 days, not never.)
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  // iOS Safari predates display-mode media queries; it exposes navigator.standalone.
  const iosStandalone =
    "standalone" in window.navigator &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || iosStandalone;
}

function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports a desktop-Safari UA, so fall back to touch-point sniffing.
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function dismissedWithinCooldown(): boolean {
  try {
    const raw = window.localStorage.getItem(INSTALL_DISMISSED_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < DISMISS_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export interface A2HSState {
  /** Android/Chromium: a native prompt is captured and the affordance should show. */
  canInstall: boolean;
  /** iOS Safari (no programmatic prompt): show static Add-to-Home-Screen steps. */
  showIOSHint: boolean;
  /** True when already running as an installed PWA — every affordance is suppressed. */
  isStandalone: boolean;
  /** Fire the native install dialog (Chromium). Resolves once the user chooses; no-op elsewhere. */
  promptInstall: () => Promise<void>;
  /** Hide the affordance and start the re-show cooldown (persisted). */
  dismiss: () => void;
}

/**
 * Drives the in-app install affordance (src/components/pos/InstallPrompt). Captures
 * the deferred `beforeinstallprompt` on Android Chrome, detects an
 * already-installed standalone launch (so the affordance never nags an installed
 * app), branches to static instructions on iOS, and persists dismissal with a
 * cooldown. See ADR-025 (PWA) + the roadmap A2HS spec.
 */
export function useA2HS(): A2HSState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(detectStandalone);
  const [dismissed, setDismissed] = useState<boolean>(dismissedWithinCooldown);
  const isIOS = detectIOS();

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // suppress Chrome's mini-infobar; we own the prompt timing
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setIsStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // Reflect a live display-mode flip (rare, but cheap to keep honest).
    const mq = window.matchMedia?.("(display-mode: standalone)");
    const onDisplayChange = () => setIsStandalone(detectStandalone());
    mq?.addEventListener?.("change", onDisplayChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mq?.removeEventListener?.("change", onDisplayChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // The captured event is single-use — drop it so the affordance hides.
    setDeferred(null);
  }, [deferred]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
    } catch {
      // localStorage can throw in private mode — dismissal just won't persist.
    }
    setDismissed(true);
  }, []);

  const suppressed = isStandalone || dismissed;
  return {
    canInstall: !suppressed && deferred !== null,
    showIOSHint: !suppressed && isIOS && deferred === null,
    isStandalone,
    promptInstall,
    dismiss,
  };
}
