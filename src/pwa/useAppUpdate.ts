import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

// How often an always-open booth PWA polls for a freshly-deployed build. The
// browser only checks for a new service worker on a full (re)load and roughly
// every 24h — a kiosk that stays open all day never hits either, which is why
// devices got stuck on an old version. Polling `registration.update()` makes the
// `needRefresh` flag actually fire within ~a minute of a deploy.
const UPDATE_POLL_MS = 60_000;

// Safety-net delay: `updateServiceWorker(true)` reloads via a `controllerchange`
// listener, but that event is occasionally flaky across browsers. If the page
// hasn't navigated away by now, we force a reload ourselves so the update button
// is never a dead end.
const FORCE_RELOAD_FALLBACK_MS = 2_500;

export interface AppUpdateState {
  /** True once a newer build's service worker is installed and waiting. */
  needRefresh: boolean;
  /**
   * Activate the waiting worker (skipWaiting) and reload onto the new build.
   * Always reloads — even if `controllerchange` doesn't fire — so a tap reliably
   * lands the user on the latest version.
   */
  forceUpdate: () => void;
}

/**
 * Drives the new-build update banner (src/pwa/AppUpdateBanner). With the PWA in
 * `prompt` mode, a deploy installs a *waiting* service worker and flips
 * `needRefresh`; we surface a banner and let the user tap to apply it (no silent
 * reload mid-sale). The periodic poll + focus/online checks are what make
 * detection fire on an always-open device.
 */
export function useAppUpdate(): AppUpdateState {
  const [registration, setRegistration] = useState<
    ServiceWorkerRegistration | undefined
  >(undefined);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      setRegistration(reg ?? undefined);
    },
  });

  useEffect(() => {
    if (!registration) return;

    const poll = () => {
      void registration.update();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };

    const intervalId = window.setInterval(poll, UPDATE_POLL_MS);
    window.addEventListener("online", poll);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("online", poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [registration]);

  const forceUpdate = () => {
    // skipWaiting + reload-on-controllerchange (handled inside the plugin helper).
    void updateServiceWorker(true);
    // Guaranteed-reload fallback if controllerchange never fires.
    window.setTimeout(() => {
      window.location.reload();
    }, FORCE_RELOAD_FALLBACK_MS);
  };

  return { needRefresh, forceUpdate };
}
