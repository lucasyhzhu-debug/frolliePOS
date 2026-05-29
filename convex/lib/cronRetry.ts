// convex/lib/cronRetry.ts
//
// Shared transient-error retry policy for cron-triggered sends.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Convex crons fire a function exactly ONCE with NO auto-retry. A send-action's
// first step is typically a runQuery (resolve the destination chat). If a
// transient Convex capacity error — "There are no available workers to process
// the request" — coincides with the firing time, that runQuery throws BEFORE any
// message is sent and the scheduled post is silently dropped. No error in the
// chat, just a missing message. (This bit the source project's midday digest on
// 2026-05-29.)
//
// ── The pattern ──────────────────────────────────────────────────────────────
// Every CRON-triggered send gets a thin `*Resilient` wrapper internalAction that:
//   1. runs the real send-action via `ctx.runAction`,
//   2. on a TRANSIENT error only, self-reschedules a backed-off retry
//      (`ctx.scheduler.runAfter`) up to RESILIENT_MAX_ATTEMPTS,
//   3. rethrows anything else (so it surfaces in the cron dashboard).
// Crons point at the wrapper; the raw send-action stays the on-demand entrypoint
// (a slash command, or an admin test-send) where a human can just re-issue it.
//
// Why a per-action wrapper and not one generic action: `scheduler.runAfter` needs
// a concrete function reference to reschedule, and references are not serialisable
// as args — so each wrapper must name itself. Only the POLICY (classification +
// backoff) is shared here.
//
// ── Why retrying is safe ──────────────────────────────────────────────────────
// Transient errors are classified by message substring and only ever occur before
// the send loop (at a Convex runQuery/runAction). A mid-send Telegram failure does
// NOT match isTransientError, so it is never retried — re-running a partially-sent
// action would double-post. Any pre-send work that DOES re-run on retry (e.g. a
// best-effort data refresh) must be idempotent.
//
// See examples/packList/sendPackList.ts for a worked wrapper, and
// SELF-REGISTRATION.md / RUNBOOK.md § "Scheduled message never arrived".

/** Initial attempt + 2 retries. */
export const RESILIENT_MAX_ATTEMPTS = 3;

/** Linear backoff: 60s before retry 1, 120s before retry 2. `attempt` is 0-based. */
export function resilientRetryDelayMs(attempt: number): number {
  return 60_000 * (attempt + 1);
}

/**
 * Substrings identifying a transient Convex system/overload error — the only
 * class of failure safe to retry from a cron wrapper. Case-insensitive match.
 */
const TRANSIENT_ERROR_SUBSTRINGS = ["no available workers"];

export function isTransientError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_ERROR_SUBSTRINGS.some((s) => msg.includes(s));
}
