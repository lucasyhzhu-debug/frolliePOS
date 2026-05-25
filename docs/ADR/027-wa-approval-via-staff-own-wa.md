# 027. WhatsApp approval via staff's own WhatsApp

**Date:** 2026-05-21
**Status:** Accepted
**Group:** WA

## Context

Manager-PIN gates ([ADR-005](./005-manager-pin-one-off.md)) assume a manager is physically present or reachable at the booth. In practice, the manager is often elsewhere — at the kitchen, at home, in transit. Pre-v0.4 the only option was "wait for the manager." The WhatsApp Cloud API would let a business bot post approval requests to a group, but provisioning it takes 1-3 weeks of Meta verification and adds an external dependency.

Staff are already in the **Frollie · Managers** WhatsApp group on their personal phone. We can use that.

## Decision

When a manager-PIN gate is hit (refund, manual confirm, negative-stock confirm, void of paid txn), the POS opens a `wa.me` share-intent pre-filled with the approval request message + a token URL. Staff picks the Managers group in the native share sheet and taps send. The message looks like it came from staff (because it did — from their own WA) and any manager in the group can tap the link to approve.

**No business WhatsApp account. No bot. No Cloud API.**

## Alternatives considered

- **WhatsApp Cloud API + business account.** Rejected for v1: 1-3 weeks verification, more infrastructure, marginal benefit. Revisit for v1.1+ if volume justifies.
- **SMS + Twilio.** Rejected: clunkier UX, costs money per send, no link-preview cards, no group context.
- **In-app notification to a manager's app.** Rejected: requires manager to have the POS installed and logged in — friction.
- **Email.** Rejected: managers don't check email at the moment something at the booth needs approval.

## Consequences

- *Easier:* zero infra. Works on day one of v0.4.
- *Harder:* POS can't see delivery/read receipts (it's not the sender, the staff member is). POS only knows when the approval **link** is opened (token landing fires) — that signal is enough.
- *Tradeoff:* messages come from the staff member's personal WhatsApp, not a business identity. Group context already trusts that (staff and managers all know each other).
- *Same pattern for founders share:* [ADR-033](./033-founders-shift-summary-share.md) uses the same wa.me share-intent model for the daily shift summary.
- *Schema:* `pos_approval_requests { id, kind, requester_staff_id, entity_id, payload, reason_provided, status, decided_by_mgr_id?, decided_at?, audit_log_id? }` ([ADR-030](./030-approval-audit-captures-full-context.md)).
