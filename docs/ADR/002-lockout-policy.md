# 002. Lockout policy: 3 fails → 60s

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Auth

## Context

Brute-force defence on a 4-digit PIN space (10,000 combinations). But staff fat-finger constantly under counter pressure, so the policy can't be punitive.

## Decision

3 wrong PINs in a row → 60-second lockout for **that staff record** (not that device). Counter persists in `pos_auth_attempts`; resets on successful login or after 60 seconds elapsed. Manager-PIN attempts during WhatsApp approval ([ADR-027](./027-wa-approval-via-staff-own-wa.md)) share the same lockout counter, keyed by manager id.

## Alternatives considered

- **Device-level lockout (lock the device, not the staff).** Rejected: punishes co-workers for one staff's typo, doesn't fit overlapping-shift pattern.
- **Exponential backoff (5s, 30s, 5min...).** Rejected: counter staff would learn to game it; flat 60s is predictable and unambiguous.
- **5 attempts before lockout.** Rejected: too generous on a 10k-combination space; 3-fail-60s is the standard mobile PIN convention.
- **Permanent lockout requiring manager reset.** Rejected: staff would call manager constantly. 60s self-recovery is the right balance.

## Consequences

- *Easier:* other staff can still sign in during one staff's lockout. Lockout state survives reload (persisted in `pos_auth_attempts`).
- *Harder:* requires per-staff state at the auth layer. Existing `pos_auth_attempts` table absorbs it.
- *Audit:* lockout entries logged to `audit_log` with `staff.locked_out` action — manager can spot grinding attempts.
- *Mitigation against manager-PIN brute-force from WA landing page:* same counter, keyed by manager id, so an attacker can't grind manager PINs by repeatedly opening a landing-page URL.
