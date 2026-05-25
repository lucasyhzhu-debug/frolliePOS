# 013. Idempotency keys on every mutation

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Pay

## Context

Flaky network + impatient staff = double-tap on "Charge" = two Xendit invoices for one cart, or two stock-in rows for one tray. Convex mutations retry on transient errors. Without an idempotency layer, retries can do the same work twice.

## Decision

Every state-changing public Convex mutation accepts an `idempotencyKey` (client-generated UUIDv4). Server dedupes by key for 24 hours — first call writes the row(s) and stores the response in `pos_idempotency`; subsequent calls with the same key return the stored response without re-executing. A mutation harness wraps every public mutation so individual function code doesn't have to think about it.

## Alternatives considered

- **No idempotency, rely on UI to disable buttons during in-flight.** Rejected: doesn't cover network retries, doesn't cover service worker re-fires, doesn't cover the "user reloads the page mid-action" case.
- **Per-mutation hand-rolled dedupe.** Rejected: every author has to remember to add it; one forgotten mutation = one duplicate-charge bug.
- **Idempotency keyed on (staff_id, mutation_name, args_hash).** Rejected: stale state in args (timestamps, generated ids) makes hashing fragile. Client-generated UUID per intent is unambiguous.

## Consequences

- *Easier:* every mutation safe under retry. Charge double-tap is a non-event.
- *Harder:* `pos_idempotency` table grows; 24h TTL + scheduled reaper keeps it bounded. Storage cost is trivial at expected volumes (low thousands of mutations per day).
- *Schema:* `pos_idempotency { key, mutation_name, staff_id, response_blob, expires_at }`.
- *Client side:* `useIdempotency()` hook returns a stable key per intent (regenerated on intent change, not on render).
- *Related:* [ADR-014](./014-single-xendit-invoice-per-transaction.md) (Xendit-side equivalent of the same problem).
