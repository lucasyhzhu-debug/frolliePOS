import { useConvex } from "convex/react";
import { useEffect, useState } from "react";

type ConvexWithStateApi = {
  connectionState?: () => { isWebSocketConnected: boolean };
  onStateChange?: (cb: () => void) => () => void;
};

/**
 * Reactive Convex connection flag. `true` = WebSocket connected.
 * Extracted from ConnDot (which keeps its own label/color rendering).
 * Falls back to 5s polling when the 1.31+ state API is absent — same
 * trade-off as ConnDot (battery over latency for a UI affordance).
 */
export function useIsOnline(): boolean {
  const convex = useConvex();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const c = convex as unknown as ConvexWithStateApi;
    const read = () => {
      const cs = c.connectionState?.();
      if (!cs) return setOnline(true);
      setOnline(cs.isWebSocketConnected);
    };
    if (typeof c.onStateChange === "function") {
      read();
      return c.onStateChange(read);
    }
    const id = setInterval(read, 5000);
    read();
    return () => clearInterval(id);
  }, [convex]);

  return online;
}
