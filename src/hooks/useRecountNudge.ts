import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useSession } from "./useSession";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly nudge — returns `true` when more than 1 hour has passed since the last
 * recount, or when there has never been a recount.
 *
 * Returns `false` while the query is loading so the UI does not flash a nudge
 * banner before we know the real state.
 *
 * v0.5.2 simplify: was a 60-second polling tick (re-rendering once a minute
 * unconditionally). Now schedules a single `setTimeout` to the exact moment
 * the nudge becomes due — no work between then and now. If we're already past
 * the boundary, set `pastDue` synchronously; the `last_recount_at` query is
 * reactive, so a future recount automatically reschedules.
 */
export function useRecountNudge(): boolean {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const state = useQuery(api.inventory.public.getRecountState, sessionId ? { sessionId } : "skip");
  const [pastDue, setPastDue] = useState(false);

  useEffect(() => {
    setPastDue(false);
    if (!state || state.last_recount_at == null) return;
    const fireAt = state.last_recount_at + HOUR_MS;
    const delay = fireAt - Date.now();
    if (delay <= 0) {
      setPastDue(true);
      return;
    }
    const id = setTimeout(() => setPastDue(true), delay);
    return () => clearTimeout(id);
  }, [state]);

  if (state === undefined) return false; // loading — don't nudge until we know
  if (state.last_recount_at == null) return true; // never counted — definitely nudge
  return pastDue || Date.now() - state.last_recount_at > HOUR_MS;
}
