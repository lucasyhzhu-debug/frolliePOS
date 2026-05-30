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

export default crons;
