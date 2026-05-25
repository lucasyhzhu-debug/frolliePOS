# 001. PIN-only authentication

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Auth

## Context

Shared booth iPad. Staff turnover happens. No keyboard for typing emails or passwords. Speed at shift change matters more than enterprise-grade auth.

## Decision

4-digit PIN per staff record. No email/password fields on the device. Login = pick name from the staff list → enter PIN. Combined with [device registration](./000-strategic-foundations.md#6-device-registration-before-login-security-control), the PIN-on-registered-device pair is the credential.

## Alternatives considered

- **Clerk / Auth0 / similar SaaS auth.** Rejected: external dependency, email/phone flows don't fit shared-device pattern, marginal cost not justified.
- **Full password (string).** Rejected: typing passwords on a phone at every shift change is slow. PINs match the operational reality.
- **Biometric (Face ID / fingerprint).** Rejected: shared device makes biometrics impractical. Future enhancement once staff have personal devices.
- **No auth, staff dropdown.** Rejected: no audit accountability. Anyone can pose as anyone.

## Consequences

- *Easier:* fast login, low friction, fits shared-device model.
- *Harder:* 4-digit PINs are weak in isolation. Mitigations: device registration (ADR foundations §6), lockout policy ([ADR-002](./002-lockout-policy.md)), manager-PIN gating on sensitive actions ([ADR-005](./005-manager-pin-one-off.md)).
- *PIN collisions are fine.* Name + PIN is the credential — two staff can share `0000` without ambiguity because login picks the name first.
- *PIN reset:* manager portal only ([ADR-004](./004-pin-hashing-server-side.md)).
