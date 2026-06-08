# 012. Settlements visible to staff + managers

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Pay

## Context

Staff care that the sales they made on their shift actually hit the bank. Hiding settlement data ("admin-only") feels secretive and erodes trust in the POS as a financial record.

## Decision

`pos_settlements` is readable by any authenticated session — staff and managers both. Net amounts shown. MDR shown. Bank-account destination shown last 4 digits only (verification, not exposure). No raw banking-API credentials exposed.

## Alternatives considered

- **Admin-only visibility.** Rejected: staff lose visibility into whether their shift's revenue cleared. Real-world pattern: staff ask the manager every week.
- **Show only aggregate (last 7 days), not per-day.** Rejected: per-day is what matters when a staff wonders "did Friday's sales arrive on Saturday?".
- **Show only gross, hide MDR.** Rejected: managers need MDR for accounting; staff can see it too — it's not sensitive.

## Consequences

- *Easier:* single `Settlements` view, role-agnostic. Lives at `/settlements` for everyone.
- *Harder:* UX must be careful not to suggest staff have any control over settlement (it's automated by Xendit + the bank). View is read-only with clear "this is when Xendit paid out" framing.
- *Schema:* `pos_settlements` carries `xendit_settlement_id`, `settlement_date`, `gross_amount`, `mdr_amount`, `net_amount`, `transaction_count`, `bca_account_destination` (last 4 digits), `payload` (raw Xendit JSON for debugging), `synced_to_frollie_pro_at` (future v1.1 hook).
- *UX-Q6 closed:* flipped from admin-only.

## Amended 2026-06-08 (v0.7)

The original schema sketch (`xendit_settlement_id`, a "settlement webhook") assumed a Xendit **settlement object**. **There is none.** Settlement is per-transaction, knowable only by polling `GET /transactions` — verified false 2026-06-02 and confirmed against a live TEST-key `GET /transactions` call 2026-06-08. There is **no settlement webhook**.

`pos_settlements` is therefore **our own per-day aggregate**, keyed by `settlement_key` (`settle-YYYY-MM-DD`), **dual-source**:

- **manual** — a manager records a payout day by hand (PIN-gated `enterSettlementManually`). The verified launch path while Xendit KYB is pending.
- **xendit_poll** — a nightly `GET /transactions` poll (03:30 WIB) aggregates `SETTLED`/`EARLY_SETTLED` `MONEY_IN` rows by WIB settlement date (derived from `estimated_settlement_time`, since the API carries no `settlement_date` field).

**Conflict rule: poll wins.** A later `xendit_poll` overwrites a prior `manual` row's amounts and flips `source`, audited `settlement.poll_superseded_manual` (single writer `_upsertSettlementDay_internal`). Poll-over-poll and manual-over-manual patch in place under `settlement.upserted`.

The **read-access decision is UNCHANGED**: staff + managers both, role-agnostic `listSettlements`, BCA `bca_account_destination` last-4 only. Auto-poll **live-verification is KYB-gated** — TEST keys produce no real settlements, so the poll path is built + shape-tested but not yet live-verified end-to-end. See [`docs/xendit-reference/settlement-reconciliation.md`](../xendit-reference/settlement-reconciliation.md) for the confirmed API shape.
