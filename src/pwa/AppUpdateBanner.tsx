import { useState } from "react";
import { useAppUpdate } from "@/pwa/useAppUpdate";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

/**
 * Global new-build banner. Mounted once at the app root (src/main.tsx), so it is
 * present on every route — booth and cockpit — regardless of RootLayout's gating
 * early-returns. Renders nothing until a freshly-deployed service worker is
 * waiting (`needRefresh`); then it pins a thin bar to the bottom of the screen.
 *
 * Deliberately static (no Framer Motion) — a non-modal bottom bar that doesn't
 * cover the primary controls, and no dismiss button: the whole point is that
 * staff cannot keep operating an out-of-date build indefinitely. They tap when
 * between sales. Uses semantic tokens, so it re-tints under the cockpit theme.
 */
export function AppUpdateBanner() {
  const { needRefresh, forceUpdate } = useAppUpdate();
  const t = useT();
  const [updating, setUpdating] = useState(false);

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg"
    >
      <span className="text-sm font-medium text-foreground">
        {t("update.available")}
      </span>
      <Button
        size="sm"
        disabled={updating}
        onClick={() => {
          setUpdating(true);
          forceUpdate();
        }}
        className="shrink-0"
      >
        {updating ? t("update.updating") : t("update.refresh")}
      </Button>
    </div>
  );
}
