# 041. Staff-driven absolute stock recount (`recount` movement)

**Date:** 2026-06-01
**Status:** Accepted
**Group:** Inventory

## Context

The Frollie booth sells digital-payment-only via FPOS, but the same SKUs move through several **off-FPOS channels** too: food-delivery aggregators, walk-up cash sales that pre-date this system, sample give-aways, kitchen QA pulls, manager-side direct sales. Conservative estimate: **50–80 pcs/day move outside the FPOS-tracked path**. Over a week, the recorded `on_hand` drifts well beyond the actual shelf count — the FPOS number is *correct for FPOS sales*, but it is not the *physical truth* of the shelf.

v0.5.2 introduces a low-stock alert ([ADR-042](./042-low-stock-detection-inventory-telegram.md)). For that alert to be useful, `on_hand` has to approximate physical reality — otherwise alerts misfire (false positives drown out true ones, true ones never fire because phantom stock keeps the number above threshold). So a **periodic correction** is needed. The question is: *who* does it, *how often*, and *what's the audit trail*.

The existing `pos_stock_movements.source: "adjustment"` ([ADR-018](./018-negative-stock-allowed-flagged.md)) is reserved for manager-PIN-gated one-off corrections (e.g. "manager noticed 3 boxes spoiled, manually deducts"). It is the wrong primitive for a routine resync: PIN-gating every recount creates counter friction, and conflating routine recounts with exceptional adjustments destroys the audit signal that lets a manager skim the movement log and tell the two apart.

## Decision

**A staff-driven absolute recount flow.** Staff type the actual shelf count for each SKU; the system writes a new movement carrying the signed delta (`entered − before`) and snaps `on_hand` to `entered`.

Concretely:

1. **New `pos_stock_movements.source` literal: `"recount"`.** Distinct from `"adjustment"`. A `recount` movement records `delta = entered − before` (signed; can be negative if shelf is lower than tracked, positive if higher). The `on_hand` cache is patched to `entered` via `_applyLevelDelta_internal`; the movement log preserves the absolute number recounted alongside the delta.
2. **No manager-PIN gate at the booth.** Any staff session can submit a recount. The audit control is *notification*, not gating (see #3).
3. **Always-notify managers on every recount.** A Telegram message goes to the `managers` role (`sendTemplate` with a new `recount_completed` kind) listing each SKU touched, the before/after counts, and the staff who performed it. Managers cannot miss a recount, and any recount that looks suspicious is one tap away from investigation.
4. **Hourly nudge** on the home screen: a banner appears when more than 60 minutes have elapsed since the last recount, or when there has never been one. Singleton row `pos_recount_state` holds `{ last_recount_at }`, patched on every successful recount commit; the home screen reads it and renders the banner if `Date.now() − last_recount_at > 60 * 60 * 1000`.
5. **Per-SKU `_checkLowStock_internal` runs once after every recount** (ADR-042's reactive check fires here too). A recount that drops `on_hand` below `low_threshold` arms the low-stock flag; a recount that lifts it back above threshold re-arms (deletes the flag) on the next decrementing movement, not on the recount itself.

The notification is the *audit control*. Replacing manager-PIN with manager-notify trades a counter-side gate for an audit-trail gate: staff cannot quietly inflate or deflate stock without managers seeing it, and managers are not stuck at the counter for every routine count.

## Alternatives considered

- **Manager-PIN-gated recount per session.** Pros: explicit authorisation. Cons: a manager isn't always at the counter; forcing PIN entry for every routine recount creates friction that incentivises staff to skip the recount entirely, defeating the purpose. The always-notify audit trail is a cheaper control with equal accountability. **Rejected.**
- **Reuse the existing `adjustment` movement source.** Pros: no new literal, no schema change. Cons: conflates two semantically different operations — `adjustment` is a one-off exceptional correction, `recount` is a routine absolute resync. A manager scanning the movement log should be able to tell at a glance whether a delta came from a routine recount or a one-off correction; collapsing them into one source destroys that signal. **Rejected.**
- **Cron-based recount nag (daily/hourly Telegram nudge to staff).** Pros: keeps the reminder off the device UI. Cons: noise without enforcement — a Telegram nag to a staff group is easily ignored; staff aren't always reading the chat during a shift. A UI banner on the device they're already looking at is the right surface. **Rejected.**
- **Lock-out sales until a recount is performed.** Pros: hard enforcement. Cons: catastrophic at booth velocity — a missed recount must never block revenue. **Rejected on first principles.**

## Consequences

- *Easier:* low-stock alerts ([ADR-042](./042-low-stock-detection-inventory-telegram.md)) become useful because `on_hand` is periodically resynced to physical truth instead of drifting indefinitely.
- *Easier:* the audit trail distinguishes routine recounts (`source: "recount"`) from exceptional corrections (`source: "adjustment"`); the movement log stays readable.
- *Easier:* zero counter friction. Staff recount in seconds without waiting for a manager.
- *Harder:* `pos_recount_state` is a new singleton table (one row total, patched-or-inserted on every recount). The schema cost is trivial; we avoid a by-source index scan of `pos_stock_movements` to find the most recent recount, which would otherwise grow O(movements).
- *Harder:* a Telegram notification fires on every recount, including no-op recounts where every SKU's `entered` equals `before`. Acceptable — a no-op recount is still a positive signal ("staff did check at this time"), and frequency at booth velocity (a few per day) is low.
- *Concurrency:* two staff submitting different recounts for the same SKU within milliseconds → last-write-wins on `on_hand`, but **both** movements stay in `pos_stock_movements` (append-only per [ADR-007](./007-audit-log-append-only.md)). Reconciliation by reading the movement log is always possible. Acceptable: shared single device makes concurrent recounts vanishingly rare.
- *Failure isolation:* if the `managers` Telegram role is unbound, the dispatch action returns silently (no error). The DB state (movement + audit + recount-state stamp) is committed regardless — Telegram is an alert surface, not a gate.
- *Breaks if wrong:* if staff systematically game the recount to hide shrinkage (inflate counts to mask theft), the always-notify trail surfaces it but does not prevent it. v1.1 may add a periodic manager-PIN-gated *reconciliation recount* on top of this — additive, not a rewrite.

## Affects other ADRs

- **Extends [ADR-007](./007-audit-log-append-only.md):** every recount writes a `stock.recounted` audit row in addition to the movement; both are append-only.
- **Relates to [ADR-018](./018-negative-stock-allowed-flagged.md):** Negative `entered` values are REJECTED at the public mutation layer (`NEGATIVE_COUNT`). A negative shelf count is physically impossible; this is a defensive invariant — distinct from the sale-path NEG_STOCK semantics in ADR-018, which permit on-hand to drift negative when actual decrements outpace the recorded receipts. `"recount"` and `"adjustment"` remain distinct sources.
- **Relates to [ADR-034](./034-deep-modules-surface-apis.md):** `_applyLevelDelta_internal` (inventory-owned) is the single writer used by sale decrement, refund re-credit, manager adjustment, AND recount. Recount does not bypass the seam.
- **Relates to [ADR-035](./035-telegram-as-internal-comms.md):** recount notifications route to the `managers` Telegram role via `sendTemplate`, following the existing role-indirection pattern ([ADR-037](./037-telegram-self-registration-role-indirection.md)).
- **Upstream control for [ADR-042](./042-low-stock-detection-inventory-telegram.md):** low-stock detection consumes the recount-driven `on_hand` correctness. Without periodic recounts, low-stock alerts misfire; without low-stock alerts, recount accuracy has no consumer. The two ADRs are designed in tandem.
