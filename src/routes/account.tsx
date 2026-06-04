import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { PinEntry } from "@/components/auth/PinEntry";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Stage = "current" | "new" | "confirm" | "submitting";

/**
 * Self-service change-PIN. Wires the existing `auth.changePin` ACTION (v0.5.6).
 * Three sequential 4-digit entries (current → new → confirm). changePin owns its
 * idempotency cache, so we mint a one-shot crypto.randomUUID() at submit (the
 * shareReceipt / sale-drafts convention) — NOT useIdempotency.
 */
function friendlyChangePinError(msg: string): string {
  const locked = msg.match(/LOCKED_OUT:(\d+)/);
  if (locked) return `Terkunci. Tunggu ${locked[1]} detik lalu coba lagi.`;
  if (msg.includes("SAME_PIN")) return "PIN baru harus berbeda dari PIN lama.";
  if (msg.includes("NEW_PIN_INVALID")) return "PIN baru harus 4 angka.";
  if (msg.includes("INVALID_PIN")) return "PIN lama salah.";
  return "Gagal mengubah PIN.";
}

export default function AccountRoute() {
  const navigate = useNavigate();
  const session = useSession();
  const changePin = useAction(api.auth.actions.changePin);

  const [stage, setStage] = useState<Stage>("current");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resetTick, setResetTick] = useState(0);

  if (session.status === "loading") {
    return (
      <SpokeLayout title="Ubah PIN" backTo="/">
        <main className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      </SpokeLayout>
    );
  }
  if (session.status !== "active") return null; // RootLayout redirects unauthenticated

  const bump = () => setResetTick((n) => n + 1);
  const restart = () => {
    setStage("current");
    setCurrentPin("");
    setNewPin("");
    bump();
  };

  const onPin = async (pin: string) => {
    setError(null);
    if (stage === "current") {
      setCurrentPin(pin);
      setStage("new");
      bump();
      return;
    }
    if (stage === "new") {
      setNewPin(pin);
      setStage("confirm");
      bump();
      return;
    }
    if (stage === "confirm") {
      if (pin !== newPin) {
        setError("PIN tidak cocok. Ulangi PIN baru.");
        setNewPin("");
        setStage("new");
        bump();
        return;
      }
      setStage("submitting");
      try {
        await changePin({
          sessionId: session.sessionId,
          currentPin,
          newPin,
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success("PIN berhasil diubah");
        navigate("/", { replace: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("SESSION_INVALID")) {
          navigate("/login", { replace: true });
          return;
        }
        setError(friendlyChangePinError(msg));
        restart();
      }
    }
  };

  const prompt =
    stage === "current" ? "Masukkan PIN lama"
    : stage === "new" ? "Masukkan PIN baru"
    : stage === "confirm" ? "Konfirmasi PIN baru"
    : "Menyimpan…";

  return (
    <SpokeLayout title="Ubah PIN" backTo="/">
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <p className="text-sm text-muted-foreground" data-testid="account-prompt">{prompt}</p>
        {error && (
          <p className="text-sm text-destructive text-center" role="alert" data-testid="account-error">
            {error}
          </p>
        )}
        {stage === "submitting" ? (
          <p className="text-sm text-muted-foreground">Menyimpan…</p>
        ) : (
          <PinEntry onSubmit={onPin} reset={resetTick} />
        )}
        <Button variant="ghost" onClick={() => navigate("/")}>Batal</Button>
      </main>
    </SpokeLayout>
  );
}
