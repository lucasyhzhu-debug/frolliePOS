/**
 * /cockpit/outlets — owner cockpit outlet list (v1.3.0 Task 10).
 *
 * Lists all active outlets from api.cockpit.outlets.listOutlets.
 * Gated by RootLayout's cockpit session branch; this component only renders
 * for a signed-in owner with an active kind="cockpit" session.
 *
 * Design: amber/gold .theme-owner tokens applied by RootLayout on /cockpit/* —
 * this view uses semantic tokens only (ADR-047). No raw palette literals.
 */

import { Link } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useT } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SpokeLayout } from "@/components/layout/SpokeLayout";

export default function CockpitOutlets() {
  const session = useSession();
  const t = useT();

  const sessionId = session.status === "active" ? session.sessionId : undefined;

  const outlets = useQuery(
    api.cockpit.outlets.listOutlets,
    sessionId ? { sessionId } : "skip",
  );

  if (session.status === "loading") {
    return (
      <SpokeLayout title={t("cockpitOutlets.title")} backTo="/cockpit">
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </div>
      </SpokeLayout>
    );
  }

  return (
    <SpokeLayout title={t("cockpitOutlets.title")} backTo="/cockpit">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-center justify-end">
          <Button size="sm" asChild>
            <Link to="/cockpit/outlets/new">{t("cockpitOutlets.newOutlet")}</Link>
          </Button>
        </div>

        {outlets === undefined ? (
          // Loading skeleton — three placeholder cards while Convex resolves.
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted" />
              </Card>
            ))}
          </div>
        ) : outlets.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">{t("cockpitOutlets.empty")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {outlets.map((o) => (
              <Card
                key={o._id}
                className={`flex items-start justify-between gap-3 p-4${o.active ? "" : " opacity-60"}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium leading-tight">{o.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">{o.code}</p>
                  {o.address && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{o.address}</p>
                  )}
                </div>
                <Badge
                  variant={o.active ? "default" : "secondary"}
                  className="shrink-0 text-[10px]"
                >
                  {o.active ? t("cockpitOutlets.active") : t("cockpitOutlets.inactive")}
                </Badge>
              </Card>
            ))}
          </div>
        )}
      </div>
    </SpokeLayout>
  );
}
