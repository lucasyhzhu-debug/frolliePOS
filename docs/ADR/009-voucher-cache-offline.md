# 009. Voucher cache for offline use

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Ops

## Context

Mall WiFi is flaky. Staff still need to apply voucher codes when the network is degraded. Vouchers are static, manager-managed, distributed out-of-band (social media, influencer DMs, mall flyers).

## Decision

The catalog query (read at login + revalidated periodically) includes the active voucher set. Cached on device alongside products/SKUs/levels. Apply offline → queued. On sync, the server **re-validates** (expiry, single-use redemption, min subtotal, active flag) before committing the redemption. If a voucher expired between cache and sync, server rejects with a clear reason → UX surfaces a banner ("voucher expired during offline") + bumps the user back to the voucher picker.

## Alternatives considered

- **Don't cache vouchers — require online for any voucher apply.** Rejected: defeats the offline cart-build pattern. Customer is at the counter, mall WiFi just dropped, "sorry I can't apply your voucher right now" is bad.
- **Cache vouchers but apply client-side only (don't re-validate on sync).** Rejected: race on single-use codes; voucher could be applied twice by two devices in the same window.

## Consequences

- *Easier:* voucher apply works offline. Latency to sync resolves the race authoritatively.
- *Harder:* the "expired during offline" UX edge case needs explicit handling. Banner + return to picker is the chosen path.
- *Schema:* `pos_vouchers` carries `expires_at?`, `max_redemptions?`, `used_count` (incremented atomically with `pos_voucher_redemptions` insert), `min_cart_value?`, `active`.
- *Related:* [ADR-010](./010-no-voucher-stacking.md) (no stacking simplifies the offline merge).
