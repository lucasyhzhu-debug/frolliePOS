# 007. Audit log is append-only, server-timestamped

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Ops

## Context

POS is a financial system. Disputes happen ("you charged me twice", "I didn't authorise that refund"). Reconciliation against the bank requires a trustworthy record of who did what when. Device-local logs are insufficient — device loss or wipe must not erase the trail, and staff must not be able to clear logs from the device.

## Decision

`audit_log` is a Convex table. **Every state-changing mutation writes one row before returning.** Server time only (see [ADR-031](./031-convex-server-time-wins.md)). **Never updated, never deleted** — enforced at the mutation layer; code review catches any violations. Stored indefinitely. Indexed by `(actor_id, created_at)`, `(entity_type, entity_id)`, `(action, created_at)` for the "who changed this?", "what did this person do?", and "show me all refunds this week" query patterns.

## Alternatives considered

- **Device-local log, batched sync.** Rejected: device loss erases history; staff can clear local storage; sync gap reopens the dispute problem.
- **External log service (Datadog, BigQuery).** Rejected: extra dependency, more places to fail, latency between action and audit row available for dashboard queries.
- **Soft-delete via `deleted_at` column.** Rejected: invites "I'll just hide this" behaviour. Hard ban on mutation/deletion is cleaner.

## Consequences

- *Easier:* one place to look for any past action. Manager dashboard's audit view reads from this table.
- *Cheap writes, indefinite retention.* At expected volumes (hundreds of actions per day), Convex bandwidth cost is negligible.
- *Offline behaviour:* audit-log writes queue alongside their primary mutation and succeed or fail atomically on reconnect ([ADR-013](./013-idempotency-keys.md), [ADR-025](./025-service-worker-cache.md)).
- *Schema discipline:* `audit_log.action` is a string enum maintained in `convex/audit.ts` and `docs/SCHEMA.md`. Adding a new action is part of the "how to add a feature" checklist in `CLAUDE.md`.
