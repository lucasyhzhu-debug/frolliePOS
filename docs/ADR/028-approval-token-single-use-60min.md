# 028. Approval token: single-use, 60-minute TTL

**Date:** 2026-05-21
**Status:** Accepted
**Group:** WA

## Context

The approval URL posted to WhatsApp ([ADR-027](./027-wa-approval-via-staff-own-wa.md)) is a capability — possession of the URL lets you see the approval context. We want that to be safe even if the message gets forwarded out of the Managers group by accident. We also want a stale link not to be reusable.

## Decision

Token = 32-byte URL-safe random (≈256 bits of entropy). **Single-use** (consumed on the first successful approval OR denial). **60-minute TTL** from creation. After consumption or expiry, the landing page shows "this request has been resolved" / "this request has expired."

## Alternatives considered

- **Long-lived token, multi-use.** Rejected: forwarded link could be used to inspect transaction details forever; stale links accumulate confusion ("which #057 is this?").
- **Token tied to manager identity (token includes manager id).** Rejected: defeats the "any manager in the group can approve" property — point is that whoever taps first wins.
- **No TTL.** Rejected: pending requests should time out gracefully; a 4-hour-old request likely no longer matches reality (customer may have left, situation resolved by other means).

## Consequences

- *Easier:* exactly one approval per request, attributable to the first manager who acts.
- *Stale token UX:* landing page shows the request status clearly ("approved by Lucas at 14:42" / "expired at 15:41") rather than 404. Better trail for the chat history.
- *Schema:* `pos_approval_tokens { token, request_id, expires_at, consumed_at, consumed_by_mgr_id }`. Reaper cleans expired+consumed rows after 30 days for compactness.
- *Cancel from staff side:* if staff cancels the approval request on their device, the token is invalidated (consumed_at set with `consumed_by = "cancelled"` reason).
