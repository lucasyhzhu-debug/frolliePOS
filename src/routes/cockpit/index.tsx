import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";

/**
 * Owner cockpit home (v2.0 owner-auth, ADR-052). Spec-2 ships the auth plane only;
 * the cockpit dashboard/screens are Spec-3. This is the post-login landing page —
 * it exists so a successful login has a real navigation target (without it,
 * `navigate("/cockpit")` would fall through to the `*` catch-all → `/` → the
 * cross-plane guard → `/cockpit/login`, a bounce loop).
 *
 * Gated by RootLayout's cockpit branch (requires an active kind="cockpit" session),
 * so it only renders for a signed-in owner. The amber `.theme-owner` is applied by
 * RootLayout on /cockpit/* — this view uses semantic tokens only.
 */
export default function CockpitHomeRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const t = useT();
  const logoutCockpit = useMutation(api.auth.public.logoutCockpit);
  const logoutKey = useIdempotency("cockpit:logout");
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerName = session.status === "active" ? session.staff.name : "";

  const onSignOut = async () => {
    if (session.status !== "active" || !logoutKey) return;
    setSigningOut(true);
    setError(null);
    try {
      await logoutCockpit({ idempotencyKey: logoutKey, sessionId: session.sessionId });
    } catch (err) {
      // Best-effort: clear the local session regardless so the owner always lands
      // back on the login screen. Surface a soft note only.
      setError(errorMessage(err));
    }
    clearSession();
    navigate("/cockpit/login", { replace: true });
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-background p-6 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t("cockpitHome.eyebrow")}
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-primary">
          {t("cockpitHome.title")}
        </h1>
        {ownerName && <p className="text-base text-foreground">{ownerName}</p>}
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{t("cockpitHome.body")}</p>
      <Button variant="outline" onClick={onSignOut} disabled={signingOut}>
        {signingOut ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("cockpitLogin.signOut")}
          </span>
        ) : (
          t("cockpitLogin.signOut")
        )}
      </Button>
      {error && <p className="text-xs text-muted-foreground">{error}</p>}
    </main>
  );
}
