import { useEffect, useRef } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useApproval } from "@/hooks/useApproval";
import { Button } from "@/components/ui/button";
import type { Id } from "../../../convex/_generated/dataModel";

type Props = {
  requestId: Id<"pos_approval_requests"> | null;
  /** Override the default "Approved" copy on the resolved screen. */
  successMessage?: string;
  onResolved?: () => void;
  onDenied?: () => void;
  onExpired?: () => void;
  /** When provided (manager session only), shows a "Batalkan permintaan" button in the pending state. */
  onCancel?: () => void;
};

export function ApprovalPending({
  requestId,
  successMessage,
  onResolved,
  onDenied,
  onExpired,
  onCancel,
}: Props) {
  const status = useApproval(requestId);

  // Fire terminal callbacks exactly once per transition.
  const called = useRef(false);
  useEffect(() => {
    if (called.current) return;
    if (status === "resolved") {
      called.current = true;
      onResolved?.();
    } else if (status === "denied") {
      called.current = true;
      onDenied?.();
    } else if (status === "expired") {
      called.current = true;
      onExpired?.();
    }
  }, [status, onResolved, onDenied, onExpired]);

  if (status === "loading" || status === "missing") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Waiting for a manager to approve in Telegram…
        </p>
        {onCancel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            data-testid="approval-cancel"
          >
            Batalkan permintaan
          </Button>
        )}
      </div>
    );
  }

  if (status === "resolved") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
        <CheckCircle2 className="h-6 w-6 text-primary" />
        <p className="text-sm font-medium">{successMessage ?? "Approved"}</p>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
        <p className="text-sm text-destructive">
          Declined by manager — try again
        </p>
        {onDenied && (
          <Button variant="outline" size="sm" onClick={onDenied}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  // expired
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
      <p className="text-sm text-muted-foreground">
        Request expired. Try again.
      </p>
      {onExpired && (
        <Button variant="outline" size="sm" onClick={onExpired}>
          Retry
        </Button>
      )}
    </div>
  );
}
