# 031. Convex server time wins

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Time

## Context

The iPad's clock can drift, be manually set wrong, or be wrong because of timezone confusion. Timestamps on financial events must be authoritative — auditors don't accept "the device thought it was 14:38 but it was actually 16:38."

## Decision

Every server-written timestamp uses `Date.now()` **inside the Convex function** (not on the client). Client never sends `created_at` or any other server-meaningful timestamp. Stored values are UTC ms (Unix epoch milliseconds). Display layer converts to client timezone (typically `Asia/Jakarta`) using `Intl.DateTimeFormat`.

## Alternatives considered

- **Trust client timestamps for performance.** Rejected: not negotiable for financial records.
- **NTP-sync the device on app startup.** Rejected: doesn't help when the device is offline at the moment of action; server-side timestamps don't have this dependency.
- **Per-action timezone override (`event_local_time`).** Rejected: solving a non-problem — Jakarta-time is the only timezone the booth operates in.

## Consequences

- *Easier:* audit log timestamps are always trustworthy. Lock-shift summaries computed from server timestamps reproduce identically regardless of which device queries them.
- *Harder:* drafts/offline mutations queued client-side have to be careful about ordering. Mitigation: server timestamps the mutation at execution time (after dequeue), so the audit log reflects when the server processed it. The client can optionally surface "this draft was started at HH:MM (your device time)" as a UX hint but the canonical record is server time.
- *Schema:* every `_at` field is a `number` (ms epoch). Convention: server-written fields end in `_at` (`created_at`, `paid_at`, `decided_at`); client-display-only fields (rare) end in `_local_label`.
- *Display:* `src/lib/format.ts` exports `fmtTime(epochMs)`, `fmtDate(epochMs)`, `fmtRelative(epochMs)` — all timezone-aware via `Intl`.
