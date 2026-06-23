# ADR-052. Owner auth plane — Telegram-OTP authorises MANAGE

**Date:** 2026-06-21
**Status:** Accepted
**Group:** Auth

## Context

The multi-outlet program (brainstorm 2026-06-21) introduces a **business owner** who manages *all outlets in their business*: cross-outlet financials, the new-outlet/clone wizard, staff-access management, promotions. This is a fundamentally different authentication subject from today's booth user:

| Axis | Booth user (today) | Owner (new) |
|---|---|---|
| Who | staff / manager at ONE outlet | the business OWNER, business-wide |
| Scope | one outlet, device-bound | all outlets in the deployment (outlet-UNSCOPED reads) |
| Surface | booth app (`/sale/*`, staff-picker) | owner cockpit (`/cockpit/*`) — see [`2026-06-21-owner-cockpit-design.md`](../superpowers/specs/2026-06-21-owner-cockpit-design.md) (Spec 3) |
| Credential | 4-digit PIN + registered device | Telegram-OTP to private DM |
| Session | ephemeral, ends on Lock (ADR-003) | durable (idle timeout + remember-device) |
| Physical assumption | shared phone at a counter | owner's personal phone, off-booth, anywhere |

Three concrete failure modes if we reuse booth PIN auth for the cockpit:

1. **PIN is a 4-digit shared-counter credential, not a personal one.** ADR-001 accepts a 4-digit PIN *because* it is paired with device registration (ADR-000 §6) and an ephemeral session on a known booth phone. The owner cockpit is reached from an arbitrary personal device with no device-registration step — a 4-digit PIN alone there is brute-forceable and not bound to the human.
2. **Booth sessions die on Lock (ADR-003).** An owner reviewing financials across outlets needs a durable session, not one that ends every time the booth is locked. The two lifecycles are incompatible on one session model without a discriminator.
3. **The owner has no outlet.** Every booth auth helper resolves `outlet_id` from the device (Spec 1, [`2026-06-21-outlet-scoping-data-plane-design.md`](../superpowers/specs/2026-06-21-outlet-scoping-data-plane-design.md)). The owner is deliberately outlet-UNSCOPED. Threading `outlet_id` through an owner session would be a lie.

We already own a delivery channel with a real identity proof: Telegram. Managers bind chats (ADR-035); the bot can message any chat that has `/start`-ed it. A **one-time-passcode delivered to the owner's private Telegram DM** gives us (a) a possession factor (control of that Telegram account) without standing up email/SMS infra, and (b) reuse of the existing bot.

## Decision

**Owner authentication is a distinct auth plane — "OTP authorises MANAGE" — extending [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md).**

ADR-029 established: **token authorises VIEW; PIN authorises ACT** (booth/approval plane). This ADR adds a third verb for the owner plane:

> **OTP authorises MANAGE.** A Telegram-OTP, verified against a code delivered to the owner's *private* DM, mints a durable cockpit session that authorises business-wide management reads + writes. Possession of the owner's Telegram account is the human-bound credential, the way the PIN is for ACT.

### Decision A — Owner is a role, the session is a `kind`

- A new `staff.role` member: **`"owner"`**. Owner bypasses `staff_outlet_access` (Spec 1) — implicit access to ALL outlets in the deployment. Owner ⊇ manager capabilities for cockpit-surfaced actions.
- Sessions gain a discriminator **`kind: "booth" | "cockpit"`** on `staff_sessions` (default `"booth"` for backward-compat; absent ⇒ booth). Cockpit sessions carry **no `outlet_id`** (the owner is outlet-unscoped; the field is optional on the session row per Spec 1 and left absent for cockpit). Booth sessions keep the Spec-1 `outlet_id`.
- We reuse `staff_sessions` rather than a new table: same lifecycle primitives (`started_at`/`ended_at`/`end_reason`), same `requireSession` family, one place to revoke.

### Decision B — Telegram-OTP to the PRIVATE DM, never the group

- The OTP is delivered to the owner's **private** Telegram chat (`chatType: "private"`), addressed by `staff.telegram_user_id`. **Never the owners group chat.** An OTP posted to a shared chat is readable by every member — that defeats the possession factor entirely. This is a hard rule, asserted in code (the delivery path resolves a private `telegram_user_id`, not a role→group chat).
- **Constraint: a bot cannot initiate a DM to a user who has not `/start`-ed it** (Telegram platform rule). So before OTP can ever be sent, the owner must have an open DM channel with the bot AND we must have recorded their `telegram_user_id`. Both are bootstrapped by the binding deep-link (Decision C).

### Decision C — One-time `/start <token>` deep-link does triple duty

Binding the owner's Telegram account is a one-time bootstrap via a Telegram deep-link `https://t.me/<bot>?start=<token>`. When the owner taps it and the bot receives `/start <token>`:

1. **Verify** the owner controls that Telegram account (they redeemed a single-use, TTL-bounded token issued to *them*).
2. **Write** `staff.telegram_user_id` = the `from.id` of the `/start` sender.
3. **Open** the DM channel (the very act of `/start` lets the bot DM them thereafter).

The binding token lives in a new `owner_auth_bindings` table (single-use, hashed, 60-min TTL — mirrors ADR-028/029 token discipline). It is issued by a manager/existing-owner action in the cockpit (or, for the very first owner, by a seed/bootstrap path).

### Decision D — OTP lifecycle reuses the lockout/throttle patterns

OTP challenges live in a new `owner_auth_otp` table. The flow mirrors the booth login funnel (verify-in-action, commit-in-mutation, server-time-wins, throttle on miss):

- **Request** (`requestOwnerOtp` action): resolve owner by entered identifier (their `staff.code` or a registered email-less handle — see Open Questions), confirm `telegram_user_id` is bound, mint a 6-digit numeric OTP, store `code_hash` + `expires_at` (5-min TTL), DM it. Rate-limited per owner (reuse `pos_auth_attempts`-style counter, keyed by `staff_id`: 3 requests / 15 min → cooldown) so OTP-request spam can't flood the owner's DM.
- **Verify** (`verifyOwnerOtp` action): constant-time compare the entered code to the stored hash; on success mint a `kind: "cockpit"` session; on miss increment a per-challenge fail counter (cap 5 → invalidate the challenge, force re-request). Misses are **audited but do NOT touch the booth lockout counter** — same isolation principle as SEC-07 (a cockpit attacker must not be able to DoS-lock booth logins). `logAudit` verbs: `owner.otp_requested`, `owner.otp_failed`, `owner.login`.

### Decision E — Durable session + optional remembered-device quick-PIN (v1)

- Cockpit session **idle timeout ~30 min** (sliding; refreshed on activity) + an explicit **logout**. Idle timeout is enforced server-side on `requireCockpitSession` by comparing `last_active_at` (new optional field on `staff_sessions`, cockpit-only) to `now`.
- **Optional remember-device (~30 d):** on the device the owner ticks "remember", we persist a long-lived **remembered-device token** (hashed, in `owner_auth_bindings` or a sibling table) so a *return visit* can skip the full OTP and instead unlock with a quick 4-6 digit cockpit-PIN (a SECOND factor of "something you set", bound to that remembered device). First login on any device is always full OTP.
- **v1 ships OTP-only + the optional remembered-device quick-PIN. Mandatory passphrase / WebAuthn passkeys are ROADMAP, not v1** (YAGNI — the owner population is tiny and Telegram-possession is a strong factor for the threat model).

## Alternatives considered

- **Reuse booth PIN auth for the cockpit.** Rejected: 4-digit PIN with no device registration on an arbitrary personal phone is weak; booth sessions die on Lock; the owner has no outlet to thread. Three structural mismatches (see Context).
- **Email magic-link / SMS OTP.** Rejected for v1: stands up new infra (email sender / SMS gateway + cost) when we already own a bot channel with a real identity proof. Telegram-DM possession is sufficient for the owner threat model. (Email/SMS = roadmap if we outgrow Telegram.)
- **OTP to the owners GROUP chat.** Rejected: an OTP in a shared chat is readable by everyone in it — no possession factor. Hard no; DM-only is asserted in code.
- **OAuth / external IdP (Google sign-in).** Rejected for v1: heavy, adds a third-party dependency, and the owner cohort is small. Roadmap.
- **A separate `owner_sessions` table.** Rejected: duplicates lifecycle plumbing (`requireSession`, revoke, audit). A `kind` discriminator on `staff_sessions` is the smaller, single-revoke-point change.

## Consequences

- *Easier:* one durable, revocable owner session reusing `staff_sessions`; no new auth infra (Telegram already owned); a clean, auditable three-verb model (VIEW / ACT / MANAGE) that future surfaces can extend.
- *Easier:* the DM-only rule + binding deep-link give a real possession proof without email/SMS.
- *Harder:* a second login surface (`/cockpit/login`) with its own state machine, OTP table, throttle, and binding flow. The bot-cannot-DM-first constraint adds a mandatory one-time binding step before any OTP can flow.
- *Harder:* `requireSession` and friends must learn the `kind` discriminator so a booth session can't be replayed against cockpit routes and vice-versa. Existing callers must keep treating `kind: "booth"` as the default.
- *Breaks if assumption wrong:* if the owner loses access to their Telegram account, they cannot log in — recovery requires re-binding via another manager/owner (the deep-link issuer). For a single-owner business this is a real lockout risk → mitigation is an admin-issued re-bind path (Open Questions) and the remembered-device quick-PIN as a same-device fallback.
- *Reversal cost:* low-moderate. The `kind` field defaults to booth; dropping cockpit auth means stop minting `kind: "cockpit"` sessions + remove the cockpit route tree. `owner` role and `staff.telegram_user_id` are additive optional fields — no destructive migration to back out.

## Cross-references

- Extends [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md) (token=VIEW, PIN=ACT → adds OTP=MANAGE).
- Builds on [ADR-035](./035-telegram-as-internal-comms.md) (Telegram as internal comms; chat registry, `/start` self-registration) and [ADR-028](./028-approval-token-single-use-60min.md) (single-use token + TTL discipline).
- Inherits [ADR-001](./001-pin-only-authentication.md)/[ADR-002](./002-lockout-policy.md)/[ADR-004](./004-pin-hashing-server-side.md) (argon2 in actions, lockout) for the quick-PIN; [ADR-031](./031-convex-server-time-wins.md) (server time), [ADR-013](./013-idempotency-keys.md) (idempotency on the OTP-request/verify/binding mutations).
- Session-scoping interplay with Spec 1: [`2026-06-21-outlet-scoping-data-plane-design.md`](../superpowers/specs/2026-06-21-outlet-scoping-data-plane-design.md) (`staff_sessions.outlet_id`, `staff_outlet_access`, `staff.role = "owner"` bypass).
- Telegram per-outlet routing + `/start` binding handler interplay: [`2026-06-21-telegram-multitenant-routing-design.md`](../superpowers/specs/2026-06-21-telegram-multitenant-routing-design.md) (Spec 4).
- Gated surface: [`2026-06-21-owner-cockpit-design.md`](../superpowers/specs/2026-06-21-owner-cockpit-design.md) (Spec 3 — the cockpit this auth plane protects).
- Design doc: [`2026-06-21-owner-auth-plane-design.md`](../superpowers/specs/2026-06-21-owner-auth-plane-design.md).

## Related — new schema surface (full detail in the design doc)

| Table / field | Purpose |
|---|---|
| `staff.role += "owner"` | business-wide, outlet-unscoped role; bypasses `staff_outlet_access` |
| `staff.telegram_user_id?: number` | private DM target; written by `/start <token>` binding |
| `staff_sessions.kind?: "booth" \| "cockpit"` | session-plane discriminator (absent ⇒ booth) |
| `staff_sessions.last_active_at?: number` | cockpit idle-timeout anchor (sliding) |
| `owner_auth_otp` | OTP challenges: `staff_id`, `code_hash`, `expires_at`, `fail_count`, `consumed_at` |
| `owner_auth_bindings` | single-use `/start` binding tokens + remembered-device tokens (`token_hash`, `kind`, `staff_id`, `expires_at`, `redeemed_at`) |
