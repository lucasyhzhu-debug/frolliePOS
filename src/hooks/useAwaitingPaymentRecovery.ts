import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { useSession } from "./useSession";

export interface AwaitingPaymentRecovery {
  count: number;
  latest: Doc<"pos_transactions"> | null;
}

/**
 * Surfaces in-flight `awaiting_payment` transactions (last 5 min, booth-wide)
 * so the home screen can offer to resume one — e.g. a webhook confirmed while
 * the app was closed, or staff navigated away mid-charge. Wraps the orphaned
 * transactions.public.listRecentAwaitingPayment query.
 *
 * Returns { count: 0, latest: null } while loading (query undefined) so the
 * banner never flashes. `latest` = most-recent by created_at (the query
 * returns ascending index order, so we reduce rather than take [0]).
 */
export function useAwaitingPaymentRecovery(): AwaitingPaymentRecovery {
  const session = useSession();
  const sessionId = session.status === "active" ? session.sessionId : null;
  const list = useQuery(
    api.transactions.public.listRecentAwaitingPayment,
    sessionId ? { sessionId } : "skip",
  );
  if (!list || list.length === 0) return { count: 0, latest: null };
  const latest = list.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return { count: list.length, latest };
}
