# 005. Manager-PIN is one-off, not a persistent mode

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Auth

## Context

Sensitive actions (refunds, voids, manual payment-confirm, negative-stock confirms, on-device settings edits) need manager authorisation. Risk: a "manager mode" left active on the booth iPad after the manager walks away gives staff escalated permissions they shouldn't have.

## Decision

Every manager-PIN gate is a **single-use PIN entry**. No persistent elevated session. Each sensitive action prompts the manager (or, after [ADR-027](./027-wa-approval-via-staff-own-wa.md), routes to the WA approval flow) to re-enter their PIN at the moment of action.

## Alternatives considered

- **Time-limited manager session (e.g., 5 min elevated).** Rejected: 5 minutes is enough for staff to do several unauthorised actions; "did the manager already approve this?" becomes ambiguous.
- **Stay-elevated until logout.** Rejected: explicit risk of "manager mode left on."
- **"Approve next N actions" batch flow.** Rejected: confusing audit trail. One action = one approval = one audit row is the cleanest invariant.

## Consequences

- *Easier:* every audit row has an unambiguous mgr id + reason. UX-Q3 closed: no mode confusion.
- *Harder:* manager enters PIN N times per shift if N approvals — acceptable. The WA approval flow ([ADR-027](./027-wa-approval-via-staff-own-wa.md)) reduces the wait time when the manager isn't physically present.
- *Sensitive actions in v1:* refund, void of a paid transaction, manual payment-confirm (`payment.confirmed_manual_override`), negative-stock sale confirmation, stock adjustment (`stock.adjusted`), on-device settings edits, PIN reset.
