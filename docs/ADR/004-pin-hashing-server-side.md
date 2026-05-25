# 004. PIN hashing on the server (argon2id)

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Auth

## Context

PINs are weak (10,000 combinations on 4 digits). A database leak that exposed PIN hashes to an offline attack would be catastrophic — even strong hashing can't make a 4-digit space resistant to GPU brute force in absolute terms, but it can make it slow enough that lockout ([ADR-002](./002-lockout-policy.md)) and detection remain meaningful.

## Decision

PIN stored as **argon2id** hash with per-row random salt and memory/time parameters tuned for ~200ms verification cost on Convex action runtime. Verify on server only via a Convex action (never a mutation — actions can be long-running, mutations should not). Never echo PIN back; never log it; never include in audit_log `before/after` payloads.

## Alternatives considered

- **bcrypt cost 12.** Considered initially (was in the original ADR-005). Rejected in favour of argon2id: memory-hard, resistant to ASIC/GPU acceleration, current OWASP recommendation for new systems.
- **scrypt.** Comparable to argon2id; argon2id is the more modern winner of the PHC competition and has wider library support in Node ecosystems.
- **PBKDF2.** Rejected: not memory-hard. Brute-forceable on commodity GPUs.
- **Plain SHA-256 + salt.** Rejected: not a password hash function. Trivially brute-forceable.

## Consequences

- *Easier:* one hashing primitive, server-only, no client crypto.
- *Harder:* argon2id verify is ~200ms — runs in a Convex action, not a mutation, so it doesn't block the event loop. Login flow: client calls `auth.verifyPinAction` (action) → on success, internal call to `auth.loginWithPin` (mutation) writes the session row.
- *PIN reset:* manager overwrites hash via `staff.resetPin` (manager-only mutation, internally calls the hashing action). No "forgot PIN via email" — manager portal only.
- *Algorithm migration:* `pos_staff.pin_hash` stores the encoded argon2 string (`$argon2id$v=19$m=...$...$...`), so future parameter increases or algorithm swaps can be done lazily on next successful login.
