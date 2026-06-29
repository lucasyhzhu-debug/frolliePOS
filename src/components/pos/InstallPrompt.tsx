import { useA2HS } from "@/hooks/useA2HS";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, X } from "lucide-react";

/**
 * Dismissible "add Frollie to your home screen" affordance, mounted in the home
 * banner stack (src/routes/home.tsx). Renders nothing unless the platform can
 * actually be prompted: an Android Chrome tab with a captured `beforeinstallprompt`
 * (→ native Install button) or iOS Safari (→ static Share-sheet steps, since iOS
 * fires no programmatic prompt). Suppressed entirely when already installed
 * (display-mode: standalone) or recently dismissed — see useA2HS.
 *
 * Deliberately quiet: it reuses the home-tile card idiom and the citrus accent
 * for a single signature chip rather than inventing a new visual language for a
 * one-off nudge. Static (no Framer Motion) to match the sibling recount/recovery
 * banners. Semantic tokens only, so it re-tints under the cockpit theme.
 */
export function InstallPrompt() {
  const t = useT();
  const { canInstall, showIOSHint, promptInstall, dismiss } = useA2HS();

  if (!canInstall && !showIOSHint) return null;

  return (
    <Card
      role="region"
      aria-label={t("install.title")}
      className="relative flex items-start gap-3 p-3"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-citrus/15 text-citrus">
        <Download className="size-5" aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight">{t("install.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {canInstall ? t("install.body") : t("install.iosBody")}
        </p>
        {canInstall && (
          <Button size="sm" className="mt-2" onClick={() => void promptInstall()}>
            {t("install.cta")}
          </Button>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="-mr-1 -mt-1 size-7 shrink-0"
        aria-label={t("install.dismiss")}
        onClick={dismiss}
      >
        <X className="size-4" aria-hidden />
      </Button>
    </Card>
  );
}
