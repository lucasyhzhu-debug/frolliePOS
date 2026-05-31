import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession, clearSession } from "@/hooks/useSession";
import { useIdempotency } from "@/hooks/useIdempotency";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function Lock() {
  const navigate = useNavigate();
  const session = useSession();
  const logout = useMutation(api.auth.public.logout);
  const idemKey = useIdempotency(`lock:${session.sessionId ?? "none"}`);

  if (session.status !== "active") return null;

  const handleLock = async () => {
    if (!session.sessionId || !idemKey) return;
    await logout({ sessionId: session.sessionId, idempotencyKey: idemKey });
    clearSession();
    navigate("/login", { replace: true });
  };

  return (
    <SpokeLayout title="Lock + handoff">
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-sm p-6 text-center">
          <h2 className="text-lg font-semibold">End {session.staff.name}&apos;s shift?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The next person taps their name and PIN to sign in.
          </p>
          <div className="mt-6 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => navigate("/")}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleLock}>
              Lock
            </Button>
          </div>
        </Card>
      </div>
    </SpokeLayout>
  );
}
