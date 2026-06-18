import { cn } from "@/lib/utils";
import { useIsOnline } from "@/hooks/useIsOnline";

/** Connection indicator dot. State sourcing lives in useIsOnline. */
export function ConnDot() {
  const online = useIsOnline();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "h-2 w-2 rounded-full ring-1 ring-foreground/20",
          online ? "bg-success" : "bg-error",
        )}
      />
      <span>{online ? "live" : "offline"}</span>
    </span>
  );
}
