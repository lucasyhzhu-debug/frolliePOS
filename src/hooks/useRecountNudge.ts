import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSession } from "./useSession";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly nudge — returns `true` when more than 1 hour has passed since the last
 * recount, or when there has never been a recount.
 *
 * Returns `false` while the query is loading so the UI does not flash a nudge
 * banner before we know the real state.
 */
export function useRecountNudge(): boolean {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const state = useQuery(api.inventory.public.getRecountState, sessionId ? { sessionId } : "skip");
  if (state === undefined) return false; // loading — don't nudge until we know
  if (state.last_recount_at == null) return true; // never counted — definitely nudge
  return Date.now() - state.last_recount_at > HOUR_MS;
}
