# 000. Strategic foundations

**Date:** 2026-05-21
**Status:** Accepted (consolidated from original ADRs 001-014 during v0.5 backend-handoff merge)

This document consolidates the **strategic decisions** that pre-date the v0.5 implementation-focused ADR registry (ADR-001 through ADR-033). These decisions concern deployment model, vendor selection, platform, scope, security posture, and operational pattern — the kind of choices an engineer would otherwise have to reverse-engineer from the absence of alternatives in the codebase.

Each section ends with a one-line link to the implementation ADRs it ties into.

---

## 1. Shared Convex project with `product_master`

**Decision.** POS uses the same Convex project as `product_master` ([github.com/lucasyhzhu-debug/product_master](https://github.com/lucasyhzhu-debug/product_master)). POS-specific tables (`pos_*`, `staff`, `staff_sessions`, `audit_log`) live alongside Frollie Pro tables in one deployment. POS reads `products` directly. Future sales feed writes to Frollie Pro tables via Convex mutations.

**Why.** Treating POS as a new revenue channel inside Frollie Pro's data model — not a sibling system. Money flows from Xendit to the same BCA account that funds the rest of Frollie's operations, so a single source of truth for product, recipe, and inventory data avoids sync drift at the boundary.

**Alternatives considered.**
- **Separate Convex project + scheduled sync.** Cleaner isolation, smaller blast radius. Rejected: doubles the schema management surface, introduces eventual-consistency bugs at the sync boundary, requires building and maintaining a sync job. Engineering cost outweighs the isolation benefit at this stage.
- **Separate project + cross-project HTTP calls.** Rejected: Convex's value is reactive sync; cross-project calls break that and re-introduce REST-style fragility.

**Consequences.**
- *Easier:* schema compatibility automatic. Sales feed becomes a Convex mutation, not a sync pipeline. Manager dashboard can query across POS and Frollie Pro tables in one query.
- *Harder:* blast radius shared. A broken POS deploy can break product_master queries if schema validation fails. Mitigation: schema migrations go through PR review with the Frollie Pro maintainer (see `docs/WORKFLOW.md`).
- *Reversal cost:* moderate. Migrating POS to its own Convex project means re-pointing the deployment URL, copying current state, and rebuilding the sync job. A weekend, not a month.

**Related:** ADR-007 (audit log lives in this same project), ADR-016 (Product↔Inventory tables added to this project).

---

## 2. Xendit as sole payment aggregator (with BCA VA over static display)

**Decision.** Xendit is the only payment aggregator for v1. All QRIS and BCA Virtual Account flows go through Xendit's Invoice API. No fallback aggregator. No direct bank integration. Static BCA account display ("transfer here, then tap paid") is **not** supported — all non-QRIS bank transfers use Xendit BCA VA.

**Why.** PoC already validated with Xendit; team has familiarity; one API covers both QRIS and BCA VA. Static BCA requires staff to verify payment manually by watching the bank app — terrible for reconciliation, audit, and fraud surface.

**Alternatives considered.**
- **Midtrans.** Comparable feature set, slightly older API ergonomics. Rejected: no PoC, no team familiarity, no compelling reason to switch.
- **DOKU / Faspay / direct BCA + BI QRIS.** Rejected: BI's QRIS merchant registration is operationally heavy; direct BCA needs merchant agreement + certification. Aggregators absorb this exact friction.
- **Multi-aggregator setup.** Rejected: complexity not justified by current volumes. Single point of failure is acceptable at one stall.
- **Static BCA only.** Rejected: manual verification creates a fraud surface (staff has incentive to mark "paid" prematurely) and audit log can't prove the transfer matched the transaction.
- **Both VA and static, customer choice.** Rejected: two confirmation paths means two bug surfaces. Marginal customer convenience doesn't outweigh complexity.

**Consequences.**
- *Easier:* one webhook, one secret, one dashboard, one reconciliation surface.
- *Harder:* Xendit outage = no payments. Acceptable for one stall; manager-PIN manual-confirm path (ADR-005, ADR-027 WhatsApp approval) is the escape hatch.
- *MDR:* ~0.7% for QRIS, ~IDR 4,000 flat for BCA VA. Settled T+1 to the configured BCA account.
- *Reversal:* trivial to add static BCA later (new payment method + manual confirm flow). Swapping to Midtrans = ~2 weeks of integration work plus refund-history reconciliation.

**Related:** ADR-011 (Xendit Invoice API surface), ADR-012 (settlements model), ADR-014 (single invoice per transaction + explicit cancellation on retry), ADR-027 (WhatsApp manual-approval for the long-tail webhook-fail case).

---

## 3. PWA, not native Android

**Decision.** POS is a Progressive Web App installable on the staff Android device via Chrome's "Add to Home Screen." No Play Store submission, no native code, no app review cycle.

**Why.** Stack mirrors Frollie Pro (React 19 + TypeScript). Native means a second codebase or a React Native rebuild for no clear upside on an internal tool. Vercel deploys push updates instantly.

**Alternatives considered.**
- **Native Android (Kotlin).** Rejected: separate codebase, separate hire or learning curve, Play Store cycle.
- **React Native or Capacitor wrapper.** Rejected: extra build complexity, marginal benefits (push notifications, native APIs) not required for v1.
- **Browser-only, no install.** Rejected: home-screen install gives fullscreen launch, dedicated icon, no chrome controls competing for taps — meaningful UX uplift for zero engineering cost.

**Consequences.**
- *Easier:* one codebase. Deploy to Vercel pushes updates instantly. No app review. Staff updates by reloading.
- *Harder:* Android Chrome quirks. PWA install prompt timing is browser-controlled (won't always show on first load). Bluetooth printer support via Web Bluetooth has compatibility gaps with some printer models — ship without printer in v1, validate Bluetooth in v1.1 lab.
- *Breaks if:* Google deprecates PWA install on Android. Unlikely; PWAs are core to Chrome's strategy.
- *Reversal:* wrapping the PWA with Capacitor for a native shell is a 1-2 week project if needed later.

**Implementation notes.**
- `public/manifest.webmanifest` defines app metadata (name, icons, theme color, `display: standalone`).
- Service worker registered via `vite-plugin-pwa` (`vite.config.ts`).
- Install prompt triggered after first successful login via `beforeinstallprompt` — one-time banner: "Install Frollie POS to your home screen."
- Android Chrome target: 100+ (released 2022). Realistic for any mid-range phone bought in the last 3 years.

**Related:** ADR-025 (service worker cache policy), ADR-026 (reconciliation on reload).

---

## 4. PPN schema present, value zero until PKP

**Decision.** All `pos_transaction_lines` carry `tax_rate` and `tax_amount` fields from day one. Default `tax_rate = 0` since Frollie is below the PKP (Pengusaha Kena Pajak / VAT-registered enterprise) threshold. When Frollie crosses the threshold, flip the default to `0.11` and backfill the receipt template's PPN-aware flag — no schema migration.

**Why.** Indonesian tax law turns PPN (11% VAT) on at the PKP threshold. Adding tax columns later means a migration on every historical row. Zero today, 0.11 when registered, no schema change.

**Alternatives considered.**
- **Defer the tax columns until PKP triggers.** Rejected: forces a future migration over the entire transaction history at exactly the moment the business is dealing with PKP registration — bad time to do schema work.
- **Compute tax on the fly from product.tax_category.** Rejected: doesn't capture the historical tax rate. A sale receipt must reproduce the tax that applied *at the time of sale*, not what currently applies.

**Consequences.**
- *Easier:* receipt template shows tax line only when `tax_amount > 0`. Reporting queries already group by tax for future audits.
- *Harder:* schema carries dormant fields for the first months/year. Negligible cost.
- *Trigger:* when Frollie's rolling 12-month revenue crosses the PKP threshold (currently IDR 4.8B per year), manager flips `pos_settings.is_pkp = true` and updates default `tax_rate`. Existing data untouched; new sales pick up the new default.

**Related:** ADR-024 (discount ordering: line → voucher → tax, which assumes tax is the last application).

---

## 5. Finished goods only — no kitchen inventory in v1

**Decision.** POS tracks stock at finished-product level only. The kitchen's raw ingredients (flour, sugar, butter, chocolate, etc.), packaging, and work-in-progress are out of scope. Staff bring physical units from the kitchen to the booth and tap "Stock In"; that's the only stock-add path.

**Why.** Simple, single-stall model. Frollie Pro will own kitchen inventory in v1.1 when the POS sales feed graduates to decrement `kitchen_inventory` via recipe lookup. v1 just needs to know what's on the shelf.

**Alternatives considered.**
- **Full kitchen inventory in POS.** Rejected: massively expanded scope, duplicates what Frollie Pro is built for, and creates two sources of truth.
- **Recipe-based decrement from day one.** Rejected: requires Frollie Pro's recipe table to be POS-aware before the sales feed exists. Premature integration.
- **Track packaging alongside finished goods.** Rejected: packaging is a Frollie Pro concern (see Frollie Pro's `packaging` table) and packaging consumption per sale is constant — easier to subtract at month-end accounting than per-sale.

**Consequences.**
- *Easier:* one `pos_inventory_skus` table (the atoms — singles). One `pos_products` table (sellable pack sizes). One join (`pos_product_components`). Stock-in only at SKU level.
- *Harder:* stock variance between cumulative stock-in and cumulative sales must be reconciled manually if it drifts. Adjustment requires manager PIN.
- *Upgrade path (v1.1):* a scheduled Convex action reads `pos_stock_movements` of type `sale` since the last checkpoint, joins to `products → recipes`, and decrements `kitchen_inventory` rows in Frollie Pro. Idempotent via a `processed_pos_movement_ids` checkpoint table.

**Related:** ADR-016 (Product↔Inventory separation, the schema realisation of "finished goods" plus pack-size pricing), ADR-018 (negative-stock allowed + flagged), ADR-020 (stock movement source enum).

---

## 6. Device registration before login (security control)

**Decision.** Each device that runs the POS must be activated by a manager-issued one-time setup code before any staff can log in. Activation creates a `registered_devices` row binding the device's client-generated UUID to a manager-approved entry. Setup code: 6 digits, single-use, 1-hour TTL.

**Why.** A 4-digit PIN on its own is a weak credential (ADR-001). If a staff PIN leaks (shoulder-surfed, written down, shared casually), anyone with the PIN could open the POS on their own phone and transact as that staff member. Restricting login to registered devices closes that surface — the PIN only works on devices a manager has explicitly authorised.

**Alternatives considered.**
- **No device registration.** Rejected: PIN alone is too weak for transaction-capable auth.
- **MDM-style device enrolment (Intune, Jamf, etc.).** Rejected: overkill for one stall and one device.
- **Browser fingerprinting.** Rejected: fragile, breaks on browser update, privacy concerns.
- **Tie sessions to IP.** Rejected: mall WiFi changes IPs; cellular fails entirely.
- **TOTP / hardware key.** Rejected: too much friction for the operational pattern (3 staff overlapping shifts on one phone).

**Consequences.**
- *Easier:* even if a PIN leaks, the attacker also needs physical access to a registered device. Loss of a device is recoverable: manager deactivates the row in dashboard; future logins from that device id are rejected with "Device deactivated."
- *Harder:* new device setup requires a manager action. Acceptable — device additions are rare (replacing a broken phone).
- *Edge case:* if a manager loses their device and no other manager is available, recovery requires a super-admin escape hatch (a setup code generated via a Convex CLI action). Documented but not in the dashboard UI.
- *Reversal:* trivial — remove the device check from auth flow. Existing registered devices keep working.

**Implementation notes.**
- Device id: `crypto.randomUUID()`, persisted in `localStorage` (faster than IndexedDB for this single value) and IndexedDB (backup).
- Setup code lifecycle: manager dashboard generates → 6-digit code displayed for 60 seconds with copy button → manager hands to staff or types into target device → POS shows "Activate Device" screen → staff enters code → server validates (unused, unexpired) → creates `registered_devices` row → client persists `device_id`.

**Related:** ADR-001 (PIN auth — the credential this control hardens), ADR-002 (lockout policy — counters are device-aware).

---

## 7. Settlement as a second-stage record

**Decision.** Settlements (Xendit's daily payout records) are modelled as their own entity (`pos_settlements`), separate from individual payments. Net amounts after MDR are stored. Daily settlement IDs are deduped on Xendit's settlement webhook. Visible to staff and managers.

**Why.** A sale's payment confirmation (webhook says paid) and the actual money landing in the BCA account are two distinct events, typically T+1 apart. Conflating them in `pos_payments` would lose the timing dimension that matters for reconciliation, refund timing, and staff trust ("did my shift's sales actually hit the bank?").

**Alternatives considered.**
- **One `pos_payments` row per sale, with a `settled_at` field added.** Rejected: many-to-one between payments and settlements (one settlement bundles many payments) doesn't fit. And Xendit groups payments into settlements after the fact based on payout batching.
- **Only show net amounts on sale, hide MDR entirely.** Rejected: accounting needs gross + MDR separately for tax + bookkeeping. Settlement view exposes both.
- **Admin-only visibility.** Rejected: staff care that their shift's sales hit the bank (see ADR-012 — visibility flipped to staff + managers).

**Consequences.**
- *Easier:* `pos_settlements` queryable on its own. Settlement view (staff + manager) reads from this table directly. Reconciliation against bank statements is one CSV export.
- *Harder:* must keep `pos_payments` ↔ `pos_settlements` join (`transaction_ids` array or a settlement_id back-reference on payments) — both directions get used.
- *Future v1.1:* `synced_to_frollie_pro_at` field hooks the sales feed into Frollie Pro's accounting layer.

**Related:** ADR-011 (Xendit Invoice API + settlement webhook), ADR-012 (settlements visible to staff + managers).

---

## 8. Three-path payment confirmation (operational pattern)

> **Amended by [ADR-036](./036-xendit-dedicated-apis-inline.md)** (2026-05-28): polling leg retired for QRIS and BCA VA — confirmation paths for these methods are webhook (primary) + manager-PIN manual override (fallback).

**Decision.** Payment is confirmed via one of three sources, in priority order: **webhook** (primary, Xendit POSTs to `convex/xendit/webhook.ts`), **polling** (fallback — frontend polls `GET /v2/invoices/{id}` every 2s for up to 60s, server re-verifies with Xendit before flipping status), or **manual override** (last resort — manager-PIN re-entry with reason, no Xendit re-verification, heavy audit logging). Each path stores a distinct `confirmed_via` value on `pos_payments`.

**Why.** Webhooks usually arrive in 1-3 seconds but occasionally delay 10-30 seconds (Xendit queue, network conditions). Rarely they fail entirely. Staff cannot be left holding up the counter line waiting for a webhook that might be late — but they also cannot confirm payment based on hearing the customer's bank app go "ding" without verification. Three paths closes the gap.

**Alternatives considered.**
- **Webhook only.** Rejected: leaves staff stuck when webhooks delay or fail. Operationally unworkable.
- **Polling only.** Rejected: wastes API calls, adds load, slower than webhook in the common case.
- **Webhook + polling, no manual override.** Rejected: the long-tail case where neither works (rare but real) needs a path. Without it, a successful customer payment can't be reconciled in the POS, and they leave annoyed.
- **Auto-confirm after timeout.** Rejected: fraud surface. Staff would learn to "wait it out" and confirm without verifying. Manual override forces a manager touch and an audit reason.

**Consequences.**
- *Easier:* 99% of payments confirm via webhook in <3 seconds, indistinguishable from instant. Long-tail cases still resolve.
- *Harder:* three confirmation code paths means three places to test. Mitigation: shared `confirmPayment(paymentId, source, actorId, reason?)` helper enforces invariants; the three paths just differ in how they decide to call it. Webhook handler must be idempotent (same `xendit_invoice_id` can fire twice).
- *Manual override governance:* daily dashboard surfaces manual-override count per staff. Sustained high rate triggers manager investigation. Manager PIN gating is the strongest single control.
- *Reversal:* trivial — paths can be turned off independently.

**Related:** ADR-005 (manager-PIN is one-off, not a mode — applies to manual override), ADR-013 (idempotency keys on every mutation), ADR-026 (reconciliation on reload covers the device-restart edge case during a pending payment), ADR-027 (WhatsApp manager-approval is the v0.4 evolution — the manual-override "manager standing at the booth" assumption is replaced by a WA broadcast to any manager anywhere).

---

## What's deliberately not in this document

These decisions from the original 14 ADRs are **fully absorbed** by the v0.5 33-ADR registry — no separate strategic note needed:

| Original | Now covered by |
|---|---|
| 004 WhatsApp wa.me receipts | ADR-027 (`WhatsApp approval via staff's own WA`) — same wa.me model, generalised from receipts to any manager-approval gate |
| 005 PIN-based auth | ADR-001, ADR-002, ADR-003, ADR-004, ADR-005 (full auth stack) |
| 006 Partial offline | ADR-025 (service worker cache policy), ADR-026 (reconciliation on reload) |
| 007 Append-only audit log | ADR-007 (`Audit log is append-only, server-timestamped`) |
| 008 Refunds as separate entity | ADR-008 (`Refunds are new rows, not status mutations`), ADR-019 (refund re-credits stock) |

If a future change reopens any of these, restore the dedicated ADR rather than amending this consolidated doc.
