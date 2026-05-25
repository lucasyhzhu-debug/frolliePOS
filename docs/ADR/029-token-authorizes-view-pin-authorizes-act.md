# 029. Token authorises VIEW; PIN authorises ACT

**Date:** 2026-05-21
**Status:** Accepted
**Group:** WA

## Context

Anyone with the approval URL ([ADR-028](./028-approval-token-single-use-60min.md)) can open it. That's intentional — auditability inside the Managers group means everyone can see what's being approved. But seeing isn't the same as approving — only a manager whose PIN matches should be able to execute the action.

## Decision

**Two-stage authorisation on the landing page:**

1. **Token authorises VIEW.** Landing page (`/approve/:token`) renders the public summary of the approval request: amount, what's being refunded, reason, requester, time, audit-log-context. No PIN required to view. Open in any browser; works in WhatsApp's in-app browser.
2. **PIN authorises ACT.** "Approve" button reveals the PIN sheet (`/approve/:token/pin`). On submit, server calls `approvals.approve({ token, mgrPin })`. Server validates token (unused, unexpired) + verifies PIN belongs to a manager-role staff record. Only then does the underlying action execute on the staff's device.

**Non-managers can open the link and see context but cannot approve.** Staff cannot self-approve (their own PIN doesn't pass the manager-role check).

## Alternatives considered

- **Token = sole authorisation (no PIN gate).** Rejected: anyone with the URL could approve, including a forwarded leak. PIN is the human-bound credential.
- **PIN entered at the time of WA send.** Rejected: defeats the "any manager anywhere" property. The whole point is to broadcast and let the available manager act.
- **OAuth flow with manager identity.** Rejected: way too heavy for the operational pattern.

## Consequences

- *Easier:* clear two-stage security model. View = transparency. Act = authorised.
- *Harder:* PIN entry on the landing page is a second auth surface (the first being device PIN entry on the booth). Both share the lockout counter ([ADR-002](./002-lockout-policy.md)) keyed by manager id, so brute-forcing the landing page also locks out the booth login.
- *Token verification:* the landing-page view query reads the request payload from the server using the token; server returns a sanitised view (no internal ids, no PII beyond what's relevant to approve).
- *Mobile UX:* PIN sheet is full-keypad, same primitive as the booth login.
