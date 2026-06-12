import { cn } from "@/lib/utils";
import { useIsOnline } from "@/hooks/useIsOnline";

type ConnState = "online" | "queued" | "offline";

const LABELS: Record<ConnState, string> = {
  online: "live",
  queued: "sync…",
  offline: "offline",
};

const COLORS: Record<ConnState, string> = {
  online: "bg-emerald-500",
  queued: "bg-amber-500",
  offline: "bg-red-500",
};

/** Connection indicator dot. State sourcing lives in useIsOnline. */
export function ConnDot() {
  const state: ConnState = useIsOnline() ? "online" : "offline";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full ring-1 ring-foreground/20", COLORS[state])} />
      <span>{LABELS[state]}</span>
    </span>
  );
}
