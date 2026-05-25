# Architecture Decision Records

One file per implementation decision. Format: `NNN-kebab-case-title.md`. Strategic foundational decisions (deployment, vendor, platform, scope) are consolidated in `000-strategic-foundations.md`.

## Index

### Foundations (consolidated)

| | Title | Date | Status |
|---|---|---|---|
| [000](./000-strategic-foundations.md) | Strategic foundations (shared Convex · Xendit · PWA · PPN · finished goods · device registration · settlement · three-path confirmation) | 2026-05-21 | Accepted |

### Implementation (one per file, mapped to wireframe v0.5 handoff registry)

| ADR | Group | Title | Date | Status |
|---|---|---|---|---|
| [001](./001-pin-only-authentication.md) | Auth | PIN-only authentication | 2026-05-21 | Accepted |
| [002](./002-lockout-policy.md) | Auth | Lockout policy: 3 fails → 60s | 2026-05-21 | Accepted |
| [003](./003-shared-device-ephemeral-session.md) | Auth | Shared device, ephemeral session | 2026-05-21 | Accepted |
| [004](./004-pin-hashing-server-side.md) | Auth | PIN hashing on the server (argon2id) | 2026-05-21 | Accepted |
| [005](./005-manager-pin-one-off.md) | Auth | Manager-PIN is one-off, not a persistent mode | 2026-05-21 | Accepted |
| [006](./006-no-cash-no-shift-open-close.md) | Ops | No cash → no shift open/close | 2026-05-21 | Accepted |
| [007](./007-audit-log-append-only.md) | Ops | Audit log is append-only, server-timestamped | 2026-05-21 | Accepted |
| [008](./008-refunds-as-new-rows.md) | Ops | Refunds are new rows, not status mutations | 2026-05-21 | Accepted |
| [009](./009-voucher-cache-offline.md) | Ops | Voucher cache for offline use | 2026-05-21 | Accepted |
| [010](./010-no-voucher-stacking.md) | Ops | No voucher stacking | 2026-05-21 | Accepted |
| [011](./011-qris-via-xendit-bca-va-secondary.md) | Pay | QRIS via Xendit (primary); BCA VA secondary | 2026-05-21 | Accepted |
| [012](./012-settlements-visible-to-staff-and-managers.md) | Pay | Settlements visible to staff + managers | 2026-05-21 | Accepted |
| [013](./013-idempotency-keys.md) | Pay | Idempotency keys on every mutation | 2026-05-21 | Accepted |
| [014](./014-single-xendit-invoice-per-transaction.md) | Pay | Single Xendit invoice per transaction (explicit cancel on retry) | 2026-05-21 | Accepted |
| [015](./015-idr-integer-rupiah.md) | Pay | IDR as integer rupiah; no floats | 2026-05-21 | Accepted |
| [016](./016-product-inventory-separation.md) | Stock | Product ↔ Inventory separation | 2026-05-21 | Accepted |
| [017](./017-available-qty-computed-clientside.md) | Stock | `available_qty` computed client-side | 2026-05-21 | Accepted |
| [018](./018-negative-stock-allowed-flagged.md) | Stock | Negative stock allowed at sale, flagged | 2026-05-21 | Accepted |
| [019](./019-refund-re-credits-stock.md) | Stock | Refund re-credits stock | 2026-05-21 | Accepted |
| [020](./020-stock-movement-source-enum.md) | Stock | Stock movement source enum | 2026-05-21 | Accepted |
| [021](./021-receipt-url-convex-http-action.md) | Receipts | Receipt URL via Convex HTTP action | 2026-05-21 | Accepted |
| [022](./022-receipt-html-retention-24h.md) | Receipts | Receipt HTML retention: 24h; data: forever | 2026-05-21 | Accepted |
| [023](./023-receipt-number-format.md) | Receipts | Receipt number format `R-YYYY-NNNN` | 2026-05-21 | Accepted |
| [024](./024-discount-ordering-line-voucher-tax.md) | Receipts | Discount ordering: line → voucher → tax | 2026-05-21 | Accepted |
| [025](./025-service-worker-cache.md) | Sync | Service worker cache policy | 2026-05-21 | Accepted |
| [026](./026-reconciliation-on-reload.md) | Sync | Reconciliation on reload | 2026-05-21 | Accepted |
| [027](./027-wa-approval-via-staff-own-wa.md) | WA | WhatsApp approval via staff's own WhatsApp | 2026-05-21 | Accepted |
| [028](./028-approval-token-single-use-60min.md) | WA | Approval token: single-use, 60-minute TTL | 2026-05-21 | Accepted |
| [029](./029-token-authorizes-view-pin-authorizes-act.md) | WA | Token authorises VIEW; PIN authorises ACT | 2026-05-21 | Accepted |
| [030](./030-approval-audit-captures-full-context.md) | WA | Approval audit captures full context | 2026-05-21 | Accepted |
| [031](./031-convex-server-time-wins.md) | Time | Convex server time wins | 2026-05-21 | Accepted |
| [032](./032-saved-drafts-purge-24h.md) | Time | Saved drafts purge after 24h | 2026-05-21 | Accepted |
| [033](./033-founders-shift-summary-share.md) | Time | Founders shift-summary share: opt-in, default ON | 2026-05-21 | Accepted |

## Groups

- **Auth** — sessions, PINs, lockouts (ADR-001 through ADR-005)
- **Ops** — shifts, audit, refunds, vouchers (ADR-006 through ADR-010)
- **Pay** — Xendit, idempotency, currency (ADR-011 through ADR-015)
- **Stock** — products ↔ inventory, movements (ADR-016 through ADR-020)
- **Receipts** — receipt URL, numbering, tax (ADR-021 through ADR-024)
- **Sync** — offline, service worker, reconciliation (ADR-025, ADR-026)
- **WA** — WhatsApp manager approval (ADR-027 through ADR-030)
- **Time** — timestamps, retention, scheduled (ADR-031 through ADR-033)

## Template

```markdown
# NNN. Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN
**Group:** Auth | Ops | Pay | Stock | Receipts | Sync | WA | Time

## Context

What's the problem? What constraints apply? What does Frollie Pro do today?

## Decision

What did we decide. One paragraph.

## Alternatives considered

- **Option A**: pros, cons, why rejected.
- **Option B**: pros, cons, why rejected.

## Consequences

- What gets easier.
- What gets harder.
- What breaks if the assumption underneath is wrong.
- Migration cost if reversed.
```

## Notes

- ADR numbering matches the v0.5 wireframe handoff registry (`frollie-pos design files/project/wireframes/handoff.jsx`). If a new decision is added, it gets the next free number — not inserted into the existing sequence.
- Strategic foundational decisions that pre-date the v0.5 registry (deployment model, vendor selection, platform choice, etc.) are consolidated in [`000-strategic-foundations.md`](./000-strategic-foundations.md) rather than spread across individual ADRs — see that doc's closing table for "what's subsumed vs preserved."
- Cross-references between ADRs use relative links: `[ADR-013](./013-idempotency-keys.md)`. Cross-references to other docs use repo-relative paths.
