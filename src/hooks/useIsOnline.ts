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
 *
 * Fail-open by design: the state API is undocumented (shape pinned against
 * Convex 1.31.7 by the hook tests). If a future client drops it, the hook
 * reports "online" and the offline guard degrades to server-error toasts —
 * preferable to bricking the charge screen on a healthy connection.
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
      // Defensive: the cast types onStateChange as returning an unsubscribe
      // fn, but the API is undocumented — if it ever returns void, handing
      // that to React would throw `undefined is not a function` on unmount.
      const unsub = c.onStateChange(read);
      return typeof unsub === "function" ? unsub : undefined;
    }
    const id = setInterval(read, 5000);
    read();
    return () => clearInterval(id);
  }, [convex]);

  return online;
}
