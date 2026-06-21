import { useState } from "react";
import { Navigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useCountdown } from "@/hooks/useCountdown";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

/**
 * /mgr/device-setup (v0.5.6) — mint a 6-digit device-registration code via the
 * existing manager-gated `staff.generateDeviceSetupCode` mutation. Read it aloud
 * to the new device's operator, who types it on /activate. Regenerate supersedes.
 * A dedicated spoke (matches the mgr/home launcher → spoke idiom), not inline.
 */
export default function MgrDeviceSetup() {
  const session = useSession();
  const t = useT();

  if (session.status === "loading") {
    return (
      <SpokeLayout title={t("mgrDeviceSetup.title")}>
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }
  return <MgrDeviceSetupInner sessionId={session.sessionId} />;
}

function MgrDeviceSetupInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const generate = useMutation(api.staff.public.generateDeviceSetupCode);
  const [minted, setMinted] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const onGenerate = async () => {
    setBusy(true);
    try {
      const res = await generate({ sessionId, idempotencyKey: crypto.randomUUID() });
      setMinted(res);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SpokeLayout title={t("mgrDeviceSetup.title")} backTo="/mgr">
      <main className="flex flex-1 flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t("mgrDeviceSetup.instruction")}
        </p>
        {minted ? (
          <SetupCodeCard minted={minted} onRegenerate={onGenerate} busy={busy} />
        ) : (
          <Button onClick={onGenerate} disabled={busy} size="lg">
            {busy ? t("mgrDeviceSetup.generating") : t("mgrDeviceSetup.generateBtn")}
          </Button>
        )}

        <OutletSection sessionId={sessionId} />
      </main>
    </SpokeLayout>
  );
}

/**
 * Outlet-device picker (v1.2). Lists active registered devices and lets the
 * manager designate which one is the booth "outlet". Only the outlet runs the
 * start-of-day / handover SOP; every other device is a viewer that skips it.
 */
function OutletSection({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const t = useT();
  const thisDeviceId = useDeviceId();
  const data = useQuery(api.staff.public.listRegisteredDevices, { sessionId });
  const setOutlet = useMutation(api.staff.public.setOutletDevice);
  const [pending, setPending] = useState<string | "__clear__" | null>(null);

  async function choose(deviceId: string | null) {
    setPending(deviceId ?? "__clear__");
    try {
      await setOutlet({ sessionId, idempotencyKey: crypto.randomUUID(), deviceId });
      toast.success(t("mgrDeviceSetup.outletSetDone"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const outletId = data?.outletDeviceId ?? null;
  // Banner describing THIS device's role (helps a manager on their PC understand
  // why they don't see the start-of-day checklist).
  const thisRole =
    outletId === null
      ? t("mgrDeviceSetup.outletNoneSet")
      : thisDeviceId && outletId === thisDeviceId
        ? t("mgrDeviceSetup.outletThisOutlet")
        : t("mgrDeviceSetup.outletThisViewer");

  return (
    <section className="mt-2 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{t("mgrDeviceSetup.outletTitle")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("mgrDeviceSetup.outletExplain")}
        </p>
      </div>

      <Card className="px-3 py-2 text-xs text-muted-foreground">{thisRole}</Card>

      {data === undefined ? (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : data.devices.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("mgrDeviceSetup.outletEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.devices.map((d) => {
            const isOutlet = outletId === d.device_id;
            const isThis = thisDeviceId === d.device_id;
            return (
              <li key={d._id}>
                <Card className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {d.label}
                      {isThis && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({t("mgrDeviceSetup.outletThisDevice")})
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      …{d.device_id.slice(-6)}
                    </p>
                  </div>
                  {isOutlet ? (
                    <span className="shrink-0 rounded-full bg-success/15 px-3 py-1 text-xs font-medium text-success">
                      {t("mgrDeviceSetup.outletCurrent")}
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={pending !== null}
                      onClick={() => choose(d.device_id)}
                    >
                      {t("mgrDeviceSetup.outletSetBtn")}
                    </Button>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {outletId !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={pending !== null}
          onClick={() => choose(null)}
        >
          {t("mgrDeviceSetup.outletClearBtn")}
        </Button>
      )}
    </section>
  );
}

function SetupCodeCard({
  minted,
  onRegenerate,
  busy,
}: {
  minted: { code: string; expiresAt: number };
  onRegenerate: () => void;
  busy: boolean;
}) {
  const { mmss, expired } = useCountdown(minted.expiresAt);
  const t = useT();

  return (
    <Card className="flex flex-col items-center gap-3 p-6">
      <span
        className="font-mono text-4xl font-bold tracking-[0.3em] tabular-nums"
        data-testid="setup-code"
      >
        {minted.code}
      </span>
      {expired ? (
        <p className="text-sm text-destructive" data-testid="setup-expired">
          {t("mgrDeviceSetup.codeExpired")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="setup-countdown">
          {t("mgrDeviceSetup.codeExpiry", { mmss })}
        </p>
      )}
      <Button variant="outline" size="sm" onClick={onRegenerate} disabled={busy}>
        {busy ? t("mgrDeviceSetup.generating") : t("mgrDeviceSetup.regenerateBtn")}
      </Button>
    </Card>
  );
}
