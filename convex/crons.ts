import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// DECOMMISSION (v1.4.12, 2026-11-22): Frollie POS is being shut down. Seven of
// the eight scheduled jobs were removed — Convex deletes a cron on the next
// deploy when its registration disappears from this file:
//   owners-shift-summary, stock-recon            (sent Telegram messages)
//   telegram-updates-purge, telegram-log-purge,
//   api-housekeeping, forward-outbox-housekeeping,
//   owner-auth-housekeeping                      (retention purges)
// The purges are removed deliberately: nothing should delete rows between now
// and the final data export. To restore any job, recover its block from git
// history (last present at v1.4.11). See docs/RUNBOOK-decommission.md.
const crons = cronJobs();

// KEPT until the deployment is paused: 03:30 WIB settlement poll = 20:30 UTC.
// It sends no Telegram message — it only reads Xendit List Transactions and
// writes pos_settlements — and payouts for the final trading days land AFTER
// the last sale, so removing it early would leave those days unreconciled in
// the export. Settlement has NO webhook — poll-only.
// See settlements/cronActions.ts and docs/xendit-reference/settlement-reconciliation.md.
crons.daily(
  "settlement-sync",
  { hourUTC: 20, minuteUTC: 30 },
  internal.settlements.cronActions.syncSettlementsResilient,
  { attempt: 0 },
);

export default crons;
