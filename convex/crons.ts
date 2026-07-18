import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// 22:00 WIB booth close = 15:00 UTC (WIB = UTC+7, confirmed at execution).
// Resilient wrapper retries transient overload via cronRetry; non-transient
// errors (e.g. owners role unbound, malformed payload) surface to the cron
// dashboard with an audited skip — see telegram/ownersSummary.ts.
// v2.0 Spec-4 Task 7: renamed from founders-shift-summary; now sends both
// the owners business rollup AND per-outlet managers_daily_summary.
const crons = cronJobs();

crons.daily(
  "owners-shift-summary",
  { hourUTC: 15, minuteUTC: 0 },
  internal.telegram.ownersSummary.sendOwnersSummaryResilient,
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

// 02:20 WIB forward-outbox housekeeping = 19:20 UTC (slotted after
// api-housekeeping 19:00, before telegram-log-purge 20:05). Purges DELIVERED
// pos_qris_forward_outbox rows older than 30 days (raw payloads are dead weight
// once forwarded); `failed` rows are kept as reconciliation forensics.
crons.daily(
  "forward-outbox-housekeeping",
  { hourUTC: 19, minuteUTC: 20 },
  internal.payments.forwarder._purgeDeliveredForwards_internal,
  {},
);

// 03:10 WIB owner-auth housekeeping = 20:10 UTC. Pre-dawn, slotted between
// telegram-log-purge (20:05) and settlement-sync (20:30) — no collision.
// Deletes expired/consumed owner_auth_otp rows and expired/redeemed
// owner_auth_bindings rows to bound table growth.
crons.daily(
  "owner-auth-housekeeping",
  { hourUTC: 20, minuteUTC: 10 },
  internal.auth.internal._purgeOwnerAuthHousekeeping_internal,
  {},
);

export default crons;
