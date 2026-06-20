import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { PinEntry } from "@/components/auth/PinEntry";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

type Step = "current" | "new" | "confirm";

/**
 * Self-service change-PIN. Wires the existing `auth.changePin` ACTION (v0.5.6).
 * Three sequential 4-digit entries (current → new → confirm). changePin owns its
 * idempotency cache, so we mint a one-shot crypto.randomUUID() at submit (the
 * shareReceipt / sale-drafts convention) — NOT useIdempotency.
 */
function friendlyChangePinError(msg: string, t: ReturnType<typeof useT>): string {
  const locked = msg.match(/LOCKED_OUT:(\d+)/);
  if (locked) return t("account.errorLocked", { seconds: locked[1] });
  if (msg.includes("SAME_PIN")) return t("account.errorSamePin");
  if (msg.includes("NEW_PIN_INVALID")) return t("account.errorNewPinInvalid");
  if (msg.includes("INVALID_PIN")) return t("account.errorInvalidPin");
  return t("account.errorGeneric");
}

export default function AccountRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const changePin = useAction(api.auth.actions.changePin);
  const t = useT();

  const [step, setStep] = useState<Step>("current");
  const [busy, setBusy] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resetTick, setResetTick] = useState(0);

  if (session.status === "loading") {
    return (
      <SpokeLayout title={t("account.title")} backTo="/">
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null; // RootLayout redirects unauthenticated

  const bump = () => setResetTick((n) => n + 1);
  const restart = () => {
    setStep("current");
    setCurrentPin("");
    setNewPin("");
    bump();
  };

  const onPin = async (pin: string) => {
    setError(null);
    if (step === "current") {
      setCurrentPin(pin);
      setStep("new");
      bump();
      return;
    }
    if (step === "new") {
      setNewPin(pin);
      setStep("confirm");
      bump();
      return;
    }
    if (step === "confirm") {
      if (pin !== newPin) {
        setError(t("account.errorPinMismatch"));
        setNewPin("");
        setStep("new");
        bump();
        return;
      }
      setBusy(true);
      try {
        await changePin({
          sessionId: session.sessionId,
          currentPin,
          newPin,
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success(t("account.successChanged"));
        navigate("/", { replace: true });
      } catch (err) {
        const msg = errorMessage(err);
        if (msg.includes("SESSION_INVALID")) {
          navigate("/login", { replace: true });
          return;
        }
        setError(friendlyChangePinError(msg, t));
        restart();
      } finally {
        setBusy(false);
      }
    }
  };

  const prompt = busy
    ? t("account.promptSaving")
    : step === "current" ? t("account.promptCurrent")
    : step === "new" ? t("account.promptNew")
    : t("account.promptConfirm");

  return (
    <SpokeLayout title={t("account.title")} backTo="/">
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <p className="text-sm text-muted-foreground" data-testid="account-prompt">{prompt}</p>
        {error && (
          <p className="text-sm text-destructive text-center" role="alert" data-testid="account-error">
            {error}
          </p>
        )}
        {busy ? (
          <p className="text-sm text-muted-foreground">{t("account.promptSaving")}</p>
        ) : (
          <PinEntry onSubmit={onPin} reset={resetTick} />
        )}
        <Button variant="ghost" onClick={() => navigate("/")}>{t("common.cancel")}</Button>
      </main>
    </SpokeLayout>
  );
}
