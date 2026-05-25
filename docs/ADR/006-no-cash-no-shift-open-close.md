# 006. No cash → no shift open/close

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Ops

## Context

Traditional POS systems open a shift by counting the cash drawer and close it by counting again, reconciling the variance. Frollie booth is QRIS-only — there's no cash, no till, nothing to reconcile in the drawer.

## Decision

Replace "open/close shift" with a single **Lock + handoff** action. Lock = explicit end-of-session marker that writes a summary audit row, optionally posts a structured shift summary to the founders' WhatsApp group ([ADR-033](./033-founders-shift-summary-share.md)), and ends the staff session. Shift summary is computed retrospectively from transactions between two adjacent Lock events for the same staff. No "drawer" entity, no cash variance, no open-shift count.

## Alternatives considered

- **Keep shift open/close anyway for "structure".** Rejected: ceremony without purpose. Adds two extra taps per shift for nothing.
- **No explicit shift marker at all.** Rejected: founders want a daily pulse and staff want closure ("did my shift's numbers look good?"). Lock provides the marker.

## Consequences

- *Easier:* one action ends the shift. No drawer counts. No variance reports.
- *Harder:* "shift" is a derived concept (everything between two Lock events for staff X). Reports must compute on the fly. Mitigation: indexed `staff_sessions` by `(staff_id, ended_at)` makes this cheap.
- *Future cash support:* when/if cash is added, this decision reverses cleanly — add `pos_shifts` and `pos_cash_movements` tables, keep Lock as the shift-end trigger (now also closing the drawer).
- *Related:* [strategic foundations §5 (finished goods)](./000-strategic-foundations.md#5-finished-goods-only--no-kitchen-inventory-in-v1) and [DECISIONS.md "Cash deferred"](../DECISIONS.md) for the broader cash-deferred rationale.
