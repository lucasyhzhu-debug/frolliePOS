import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// 22:00 WIB booth close = 15:00 UTC (WIB = UTC+7, confirmed at execution).
// Resilient wrapper retries transient overload via cronRetry; non-transient
// errors (e.g. founders role unbound, malformed payload) surface to the cron
// dashboard with an audited skip — see telegram/foundersSummary.ts.
const crons = cronJobs();

crons.daily(
  "founders-shift-summary",
  { hourUTC: 15, minuteUTC: 0 },
  internal.telegram.foundersSummary.sendFoundersSummaryResilient,
  { attempt: 0 },
);

// 02:00 WIB nightly stock-recon = 19:00 UTC (prior day). Scheduled outside
// operational hours so the alert can wait until morning; the action's own
// retry path uses ctx.scheduler.runAfter (linear back-off, max 3 attempts)
// for transient failures — see inventory/cronActions.ts.
crons.daily(
  "stock-recon",
  { hourUTC: 19, minuteUTC: 0 },
  internal.inventory.cronActions.sendStockReconResilient,
  { attempt: 0 },
);

// Retention purges. Both tables are debug/dedup trails — the audit_log is the
// authoritative record, so bounded TTLs are safe. Run pre-dawn WIB (03:00 WIB
// = 20:00 UTC) so they don't compete with the 22:00 founders summary window
// and don't touch the booth during business hours.
crons.daily(
  "telegram-updates-purge",
  { hourUTC: 20, minuteUTC: 0 },
  internal.telegram.internal._purgeOldTelegramUpdates_internal,
  {},
);

crons.daily(
  "telegram-log-purge",
  { hourUTC: 20, minuteUTC: 5 },
  internal.telegram.internal._purgeOldTelegramLog_internal,
  {},
);

// 03:30 WIB settlement poll = 20:30 UTC. Pre-dawn, clear of the existing jobs
// (19:00, 20:00, 20:05 UTC). Resilient wrapper retries transient errors; zero
// settled rows is the expected pre-KYB result (audited skip, not an error).
// Settlement has NO webhook — poll-only via List Transactions API.
// See settlements/cronActions.ts and docs/xendit-reference/settlement-reconciliation.md.
crons.daily(
  "settlement-sync",
  { hourUTC: 20, minuteUTC: 30 },
  internal.settlements.cronActions.syncSettlementsResilient,
  { attempt: 0 },
);

// 02:00 WIB API housekeeping = 19:00 UTC. Deletes stale api_rate_buckets
// (>2 min) and old api_request_log rows (>90 days). Correctness doesn't depend
// on it — rate windows self-expire logically — but it bounds storage growth.
crons.daily(
  "api-housekeeping",
  { hourUTC: 19, minuteUTC: 0 },
  internal.api.v1.internal._purgeApiHousekeeping_internal,
  {},
);

export default crons;
