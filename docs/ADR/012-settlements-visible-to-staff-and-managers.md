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
