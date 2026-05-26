import { useConvex } from "convex/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

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

/**
 * Connection indicator. Subscribes to Convex's connection state when the
 * API is available (1.31+). Falls back to a 5-second interval otherwise —
 * 500ms polling is overkill for a UI dot and costly on mobile battery.
 */
export function ConnDot() {
  const convex = useConvex();
  const [state, setState] = useState<ConnState>("online");

  useEffect(() => {
    type ConvexWithStateApi = {
      connectionState?: () => { isWebSocketConnected: boolean };
      onStateChange?: (cb: () => void) => () => void;
    };
    const c = convex as unknown as ConvexWithStateApi;

    const read = () => {
      const cs = c.connectionState?.();
      if (!cs) return setState("online");
      setState(cs.isWebSocketConnected ? "online" : "offline");
    };

    if (typeof c.onStateChange === "function") {
      read();
      return c.onStateChange(read);
    }
    // Fallback: 5s polling, not 500ms.
    const id = setInterval(read, 5000);
    read();
    return () => clearInterval(id);
  }, [convex]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full ring-1 ring-foreground/20", COLORS[state])} />
      <span>{LABELS[state]}</span>
    </span>
  );
}
