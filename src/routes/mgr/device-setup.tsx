import { useState } from "react";
import { Navigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
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
      </main>
    </SpokeLayout>
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
