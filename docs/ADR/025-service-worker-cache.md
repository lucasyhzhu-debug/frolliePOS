# 025. Service worker cache policy

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Sync

## Context

Mall WiFi is unreliable — drops happen mid-shift. The POS must remain usable for *sales* offline. Auth must NOT be usable offline (a stolen device with cached credentials should not be able to make sales without server reachability for at least the auth handshake).

See [strategic foundations §3 (PWA)](./000-strategic-foundations.md#3-pwa-not-native-android) for the platform context.

## Decision

Three cache strategies, scoped by resource type:

| Resource | Strategy | Rationale |
|---|---|---|
| Catalog (products, SKUs, levels, vouchers, staff list) | `stale-while-revalidate` | Cart-build works offline; freshness arrives on reconnect |
| Transactions, history, settlements | `network-first` with optimistic queue fallback | Fresh-on-reconnect; queue when offline |
| Auth (`auth.loginWithPin`, `auth.verifyPinAction`) | `network-only` | Auth must never work from cache |
| App shell (HTML/JS/CSS) | `cache-first` with background refresh | Fast initial paint; updates roll in on next reload |

## Alternatives considered

- **Full offline-first (Replicache, ElectricSQL, RxDB).** Rejected: stack deviation from Frollie Pro. Worth revisiting in v2 if offline becomes operationally critical.
- **No offline support, just retry on failure.** Rejected: catalog browsing while offline is a low-effort win that significantly improves perceived reliability.
- **Allow cached auth (sign in offline if cached session still valid).** Rejected: device-loss attack vector. Network reachability for auth is a security control, not a UX optimisation.

## Consequences

- *Easier:* staff can still build carts and save drafts during brief network drops. Catalog is always responsive.
- *Sale-during-offline = optimistic transaction + queued mutation.* Mutations carry their `idempotencyKey` ([ADR-013](./013-idempotency-keys.md)); server dedupes on reconnect.
- *Auth lockout:* offline means literally cannot log in. Intentional. Banner shows "Offline — sign in requires network."
- *Storage:* IndexedDB on Android Chrome allows several GB; our cache is well under 5MB. No quota concerns.
- *Related:* [ADR-026](./026-reconciliation-on-reload.md) (handling the mid-sale interruption case).
