import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useSession } from "./useSession";

const HOUR_MS = 60 * 60 * 1000;
const TICK_MS = 60 * 1000;

/**
 * Hourly nudge — returns `true` when more than 1 hour has passed since the last
 * recount, or when there has never been a recount.
 *
 * Returns `false` while the query is loading so the UI does not flash a nudge
 * banner before we know the real state.
 *
 * I8 (triple-review): tick every 60 s so the banner appears on time even if no
 * other re-render happens between recounts. The `setTick` value is unused —
 * the bump is only there to force a re-render so `Date.now() - last_recount_at`
 * is re-evaluated against the latest clock.
 */
export function useRecountNudge(): boolean {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const state = useQuery(api.inventory.public.getRecountState, sessionId ? { sessionId } : "skip");
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  if (state === undefined) return false; // loading — don't nudge until we know
  if (state.last_recount_at == null) return true; // never counted — definitely nudge
  return Date.now() - state.last_recount_at > HOUR_MS;
}
