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
| [027](./027-wa-approval-via-staff-own-wa.md) | WA | WhatsApp approval via staff's own WhatsApp | 2026-05-21 | Superseded by ADR-035 |
| [028](./028-approval-token-single-use-60min.md) | WA | Approval token: single-use, 60-minute TTL | 2026-05-21 | Accepted |
| [029](./029-token-authorizes-view-pin-authorizes-act.md) | WA | Token authorises VIEW; PIN authorises ACT | 2026-05-21 | Accepted |
| [030](./030-approval-audit-captures-full-context.md) | WA | Approval audit captures full context | 2026-05-21 | Accepted |
| [031](./031-convex-server-time-wins.md) | Time | Convex server time wins | 2026-05-21 | Accepted |
| [032](./032-saved-drafts-purge-24h.md) | Time | Saved drafts purge after 24h | 2026-05-21 | Accepted |
| [033](./033-founders-shift-summary-share.md) | Time | Founders shift-summary share: opt-in, default ON | 2026-05-21 | Superseded by ADR-035 |
| [034](./034-deep-modules-surface-apis.md) | Arch | Deep modules with surface APIs as architectural blueprint | 2026-05-26 | Accepted |
| [035](./035-telegram-as-internal-comms.md) | Comms | Telegram as internal comms infrastructure | 2026-05-27 | Accepted |
| [036](./036-xendit-dedicated-apis-inline.md) | Pay | Xendit inline QRIS via QR Codes API + BCA VA via FVA API | 2026-05-28 | Accepted |
| [037](./037-telegram-self-registration-role-indirection.md) | Comms | Telegram self-registration with role-indirection | 2026-05-30 | Accepted |
| [038](./038-refund-settlement-manual-v1.md) | Pay | Refund settlement: POS is system-of-record, money moves manually in v1 | 2026-05-31 | Accepted |
| [039](./039-receipt-after-refund-display-contract.md) | Receipts | Receipt-after-refund display contract | 2026-05-31 | Accepted |
| [040](./040-voucher-attribution-partial-refunds.md) | Pay | Voucher attribution on partial refunds: proportional, floor-rounded | 2026-06-01 | Accepted |
| [041](./041-recount-staff-absolute-stock-update.md) | Inventory | Staff-driven absolute stock recount (`recount` movement) | 2026-06-01 | Accepted |
| [042](./042-low-stock-detection-inventory-telegram.md) | Inventory | Reactive low-stock detection (`low_threshold` + `inventory` Telegram role) | 2026-06-01 | Accepted |
| [043](./043-web-bluetooth-escpos-printing.md) | Receipts | Client-side Web Bluetooth ESC/POS thermal printing | 2026-06-02 | Accepted |
| [044](./044-nightly-stock-recon-report-only.md) | Inventory | Nightly stock reconciliation: ledger is truth, drift reported not corrected | 2026-06-02 | Accepted |
| [045](./045-route-chunk-reload-boundary.md) | Arch | Route-level chunk-reload error boundary | 2026-06-03 | Accepted |
| [046](./046-action-cache-auth-before-lookup.md) | Pay | Action-cache auth runs before the idempotency lookup | 2026-06-07 | Accepted |
| [047](./047-phthalo-dark-design-system.md) | Design | Phthalo-dark design system + glare-gate fallback | 2026-06-18 | Accepted |
| [048](./048-inline-messaging-policy.md) | Design | Inline `FieldMessage` for sync validation; toasts for global/async | 2026-06-19 | Accepted |
| [049](./049-i18n-client-typed-dictionary.md) | i18n | Client-side typed i18n dictionary (EN/ID) | 2026-06-19 | Accepted |
| [050](./050-shift-lifecycle-state-machine.md) | Ops | Booth shift lifecycle as a state machine over `pos_shift_events` | 2026-06-19 | Superseded by ADR-053 (two-level booth state) |
| [051](./051-multi-outlet-tenancy-silo.md) | Strategic | Multi-outlet tenancy — silo deployment + `outlet_id` as the sole scoping column | 2026-06-21 | Accepted |
| [052](./052-owner-auth-telegram-otp.md) | Auth | Owner auth plane — Telegram-OTP authorises MANAGE | 2026-06-21 | Accepted |
| [053](./053-two-level-booth-state.md) | Ops | Two-level booth state (stored `is_open` + `pos_shifts` holder) | 2026-06-26 | Accepted |
| [054](./054-saas-control-plane-provisioning.md) | Strategic | Control-plane/data-plane split for multi-tenant SaaS; per-tenant provisioning spike | 2026-06-21 | Deferred (not scheduled) |

> **Note (2026-06-28):** the deferred SaaS ADR was originally filed as a second `053` (collision with the two-level booth-state ADR) and renumbered to **054**; all cross-references were swept. "ADR-053" now unambiguously means the two-level booth state ADR.

## Groups

- **Auth** — sessions, PINs, lockouts (ADR-001 through ADR-005)
- **Ops** — shifts, audit, refunds, vouchers (ADR-006 through ADR-010)
- **Pay** — Xendit, idempotency, currency, refund settlement (ADR-011 through ADR-015; ADR-036 extends; ADR-038 refund settlement; ADR-011 superseded by ADR-036); ADR-040 refund math
- **Stock** — products ↔ inventory, movements (ADR-016 through ADR-020)
- **Inventory** — recount, low-stock detection, nightly reconciliation (ADR-041, ADR-042, ADR-044)
- **Receipts** — receipt URL, numbering, tax, refund display (ADR-021 through ADR-024; ADR-039 refund display contract)
- **Sync** — offline, service worker, reconciliation (ADR-025, ADR-026)
- **WA** — WhatsApp manager approval (ADR-027 through ADR-030; ADR-027 superseded by ADR-035)
- **Time** — timestamps, retention, scheduled (ADR-031 through ADR-033; ADR-033 superseded by ADR-035)
- **Arch** — foundational architecture, route resilience (ADR-034, ADR-045)
- **Comms** — internal communications channel (ADR-035, ADR-037)
- **Design** — design system, inline validation messaging (ADR-047, ADR-048)
- **i18n** — client-side typed EN/ID dictionary (ADR-049)
- **Strategic** — multi-outlet tenancy, SaaS control-plane (ADR-051, ADR-054; see also ADR-000)

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
