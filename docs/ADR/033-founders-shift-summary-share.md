# 033. Founders shift-summary share: opt-in, default ON

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Time

## Context

Founders (Lucas, Sari) want the daily pulse without setting up scheduled reports, dashboard refreshes, or separate channels. The Lock + handoff moment already produces a shift summary — sharing it is one extra tap.

## Decision

The Lock screen has a "Send summary to founders" toggle, **default ON**. Tapping "Lock + send" opens a wa.me share-intent with a structured preview message pre-filled. Staff picks the **Frollie · Founders** group in the native share sheet and taps send. Same model as [ADR-027 WhatsApp manager-approval](./027-wa-approval-via-staff-own-wa.md) — sent from the staff member's own WhatsApp, no business bot.

Toggle state persists per staff in `pos_staff.preferences.founders_share_on`.

## Alternatives considered

- **Business WhatsApp bot posting summaries automatically.** Rejected: 1-3 week Cloud API verification, ongoing infra, marginal benefit over the share-sheet pattern.
- **Email summary instead.** Rejected: founders don't check email at end-of-shift; WhatsApp is where they live.
- **Send to founders only on request (default off).** Rejected: defeats the "default pulse" goal. On-by-default with explicit toggle gives staff control without nagging.

## Consequences

- *Easier:* founders get a daily structured update with zero infra. Same wa.me pattern as approvals — one less thing to maintain.
- *Message preview (structured):* business header, shift window, totals (sales / txns / avg / refunds), top sellers, low stock, vs-yesterday delta, optional staff note. Renders cleanly inside WhatsApp as a multi-line message with a `frollie.id/shift/<token>` link to the full breakdown.
- *Audit:* lock action writes `audit_log.action = "staff.shift_summary_shared"` when toggle is on (the action itself doesn't depend on whether WA actually delivered — POS can't see that).
- *Per-staff toggle:* a privacy-sensitive staff can turn it off; preference persists.
