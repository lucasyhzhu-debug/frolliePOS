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

export default crons;
