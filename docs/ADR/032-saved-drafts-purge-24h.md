# 032. Saved drafts purge after 24h

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Time

## Context

Saved carts (drafts) accumulate when customers walk away mid-purchase. After a day, most are no longer relevant — and worse, they may reference prices that have changed, products that have been deactivated, or stock that's no longer available.

## Decision

`pos_drafts` carries `expires_at = created_at + 24h`. A scheduled Convex function deletes expired drafts daily. UI shows an "expires in Xh" badge. On Resume, the draft is re-priced against the current catalog; if any price moved, a "prices updated" banner shows the delta.

## Alternatives considered

- **Never purge — let drafts accumulate forever.** Rejected: stale drafts pile up; "Resume" tempts staff to act on stale data.
- **Purge on Lock instead of time-based.** Rejected: staff might lock without clearing drafts; next shift inherits stale state.
- **Purge only when product prices change.** Rejected: more complex; time-based is simpler and the practical cases align (a draft older than 24h was either forgotten or the customer left).

## Consequences

- *Easier:* draft list always shows recent, relevant carts. Reaper is one cron job.
- *Re-pricing on Resume:* the resume mutation re-reads current product prices, computes new line totals, surfaces "prices updated" if any line moved. Draft is not silently mutated — staff sees the change.
- *Schema:* `pos_drafts { id, staff_id, payload (serialized cart state), created_at, expires_at, customer_phone?, customer_name? }`. Reaper indexes on `expires_at`.
- *Audit:* draft discard (manual or via reaper) writes an audit row with `action = "draft.discarded"`, source `"manual"` or `"reaper"`.
