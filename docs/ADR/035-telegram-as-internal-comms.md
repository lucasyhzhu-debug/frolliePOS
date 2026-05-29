# 035. Telegram as internal comms infrastructure

**Date:** 2026-05-27
**Status:** Accepted. Supersedes [ADR-027](./027-wa-approval-via-staff-own-wa.md) and [ADR-033](./033-founders-shift-summary-share.md).
**Group:** Comms

## Context

[ADR-027](./027-wa-approval-via-staff-own-wa.md) chose the wa.me share-intent pattern for manager-approval flows: when a PIN gate is hit off-booth, staff tap a pre-filled message that sends from their own WhatsApp to the Frollie · Managers group. [ADR-033](./033-founders-shift-summary-share.md) applied the same pattern for founders shift-summary at lock/handoff.

The wa.me approach has a structural weakness: it depends on a specific staff member's personal WhatsApp being present at the booth and on that person manually completing the share. If no staff member is physically at the device, off-booth approval is blocked. If the staff member forgets to send, the approval loop never starts.

During v0.3, a Telegram bot POC was built and shipped at `/dev/telegram`. The POC demonstrated that a real Telegram bot can post structured messages to a group chat without any staff involvement — no personal account, no share sheet, no booth presence required. The v0.3 PIN-reset flow (lockout → Telegram link → `/approve/:token` → manager PIN) uses this bot as the notification channel and proved the pattern end-to-end.

Telegram also removes the 1-3 week Meta Cloud API verification barrier that made WhatsApp Cloud API impractical for v1 (a reason cited in ADR-027's alternatives). The bot is operational from day one with a single `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env pair.

## Decision

**Telegram bot is the internal comms infrastructure for v0.3 and forward.**

The bot joins `audit/` and `idempotency/` as foundational, allow-listed infrastructure per [ADR-034](./034-deep-modules-surface-apis.md) §"Implementation notes — Module-boundary lint". Any module may import telegram-send helpers from `convex/telegram/` (or its successor `convex/approvals/telegram/` when the module graduates in v0.4) without triggering the cross-module lint rule.

Off-booth approval flows notify via Telegram:

- **v0.3 — staff PIN reset.** Lockout event → Telegram message with approval link → manager opens `/approve/:token` from any device → enters their manager PIN → PIN is reset on behalf of the locked staff member. Token-authorises-VIEW / PIN-authorises-ACT ([ADR-029](./029-token-authorizes-view-pin-authorizes-act.md)) holds unchanged.
- **v0.4+ — other PIN-gated actions.** Refund, void, manual payment confirmation, and stock adjustment approvals will migrate to the same Telegram-notification pattern. The `pos_approval_requests` schema ([ADR-030](./030-approval-audit-captures-full-context.md)) is unchanged; only the notification delivery channel changes.

The wa.me share-intent pattern of ADR-027 and the founders shift-summary share of ADR-033 are replaced by Telegram-delivered notifications. Founders shift-summary becomes a scheduled or lock-triggered Telegram post to the Frollie · Founders group — no manual share step.

## Alternatives considered

- **Keep wa.me share-intent (ADR-027 pattern).** Rejected: depends on a specific staff member's WhatsApp being present at the booth. Fails the off-booth-no-staff case that v0.3 PIN-reset must handle. Zero-infra advantage disappears once the Telegram bot is running anyway.
- **WhatsApp Cloud API.** Rejected: 1-3 week Meta verification process, ongoing infra cost, more surface area than Telegram for identical functionality. The v1.1+ reconsideration from ADR-027 is superseded — Telegram is the answer, not Cloud API.
- **SMS (Twilio or similar).** Rejected: per-message cost, spam-flag risk on links, no thread context, no group semantics.
- **In-app push notification to a manager's device.** Rejected: requires manager to have the POS installed and logged in — friction. Telegram is already present on their phone.

## Consequences

- *Easier:* off-booth approvals work from any device, any location, without a staff member at the booth. Bot posts autonomously — no share step.
- *Operational requirement:* `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` must be set in both Convex dev and prod environments. Bot must be a member of the target group(s). This is now a hard infra dependency for approval flows to work.
- *Security (prod hardening — v1.0 item):* the current POC logs raw approval tokens to `telegram_log` for debugging. In prod, tokens must be redacted from logs — the token appears in the URL sent to Telegram but must not be stored in the log row. This is a known open item, explicitly deferred to v1.0 hardening.
- *Token model unchanged:* [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md) token-authorises-VIEW / PIN-authorises-ACT holds. The approval landing page (`/approve/:token`) is identical regardless of whether the link arrived via Telegram or wa.me.
- *ADR-027 approval schema unchanged:* `pos_approval_requests` ([ADR-030](./030-approval-audit-captures-full-context.md)) is delivery-channel-agnostic. Migration is additive — add `notification_channel: "telegram"` field; no row-level breaking change.
- *wa.me code:* the share-intent front-end helpers built for ADR-027 can be removed in v0.4 when all approval kinds are migrated. They are dead code from v0.3 forward for the PIN-reset kind.

## References

- [ADR-027](./027-wa-approval-via-staff-own-wa.md) — superseded (WhatsApp approval via staff's own WA)
- [ADR-033](./033-founders-shift-summary-share.md) — superseded (founders shift-summary share)
- [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md) — token-VIEW / PIN-ACT; unchanged
- [ADR-030](./030-approval-audit-captures-full-context.md) — approval audit schema; unchanged
- [ADR-034](./034-deep-modules-surface-apis.md) — module boundaries / foundational allow-list
- `convex/telegram/` — current POC code (graduates to `convex/approvals/telegram/` in v0.4)
- `docs/MEMORY.md` — Telegram POC current state and artifact paths
