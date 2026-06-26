import { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/**
 * Sub-page chrome for the owner cockpit plane (v1.3.0 UAT fix — booth-chrome leak).
 *
 * The booth `SpokeLayout`/`AppHeader` render a thermal-printer control + a "live"
 * connection chip + staff name — booth concerns that have no place in the owner
 * cockpit. Cockpit sub-routes (outlet list, new-outlet wizard) sit under
 * `CockpitShell` (which already renders the brand + outlet switcher), so they only
 * need a lightweight title + back affordance here — never the booth header. Keeps
 * the amber plane visually + functionally separate from the teal booth (B7 / rule #26).
 */
export function CockpitSubLayout({
  title,
  backTo = "/cockpit",
  children,
}: {
  title: string;
  backTo?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <header className="sticky top-0 z-10 flex h-12 items-center gap-1 border-b border-border bg-background/95 px-3 backdrop-blur">
        <Button variant="ghost" size="sm" asChild aria-label={t("cockpitOutletNew.back")}>
          <Link to={backTo}>
            <ChevronLeft className="size-4" /> {t("cockpitOutletNew.back")}
          </Link>
        </Button>
        <h1 className="text-sm font-medium">{title}</h1>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
