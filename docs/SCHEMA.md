# SCHEMA.md

**POS-internal schema.** Table shapes, field names, and `Id<>` types are internal implementation detail per [ADR-034](./ADR/034-deep-modules-surface-apis.md). They can evolve freely; external integration with Frollie Pro or future consumers happens via the contract in [`PUBLIC_API.md`](./PUBLIC_API.md), not by mirroring this schema.

This doc is the developer-facing reference for the POS Convex schema. Field naming uses `snake_case` per POS convention. For external API field naming (`camelCase`) and stable string identifiers, see `PUBLIC_API.md`.

## Module ownership (per ADR-034)

| Module | Tables owned |
|---|---|
| `outlets/` *(v2.0)* | `outlets`, `staff_outlet_access` |
| `migrations/` *(v2.0)* | `migration_state` |
| `auth/` | `staff`, `staff_sessions`, `pos_auth_attempts`, `registered_devices`, `pending_device_setups` |
| `catalog/` | `pos_products`, `pos_inventory_skus`, `pos_product_components` |
| `inventory/` *(v0.3, extended v0.5.2, v0.6)* | `pos_stock_movements`, `pos_stock_levels`, `pos_low_stock_alerts` *(v0.5.2)*, `pos_recount_state` *(v0.5.2)*, `pos_stock_drift_log` *(v0.6)* (moved from `catalog/` in v0.3 per ADR-034) |
| `transactions/` *(v0.3)* | `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters` |
| `payments/` *(v0.3)* | `pos_xendit_invoices` |
| `vouchers/` *(v0.3)* | `pos_vouchers`, `pos_voucher_redemptions` |
| `approvals/` *(v0.3, extended v0.4)* | `pos_approval_requests` |
| `idempotency/` | `pos_idempotency` |
| `audit/` | `audit_log` |
| `telegram/` *(v0.4)* | `telegram_log` (debug-trail only), `telegramChats`, `telegramUpdates` |
| `settings/` *(v0.4)* | `pos_settings` |
| `receipts/` *(v0.5.1 PR A)* | `pos_receipt_html_cache` |
| `refunds/` *(v0.5.1 PR B)* | `pos_refunds` |
| `ops/` *(v1.0.1)* | `pos_error_reports` (append-only launch-ops telemetry — NOT `audit_log`) |
| `api/v1/` *(v1)* | `api_tokens`, `api_rate_buckets`, `api_request_log` |
| `shifts/` *(v1.2 #6)* | `pos_shift_events` |

> **Doc note (v0.3):** several table sections below were written ahead of time against the broader **v0.5 design** and are marked *(new in v0.5)* / *(rewritten in v0.5)*. The v0.3 milestone shipped a leaner subset of those tables. Where the section header carries a **"v0.3 shipped"** field table, that table is ground truth for what currently exists in code (`convex/<module>/schema.ts`); the surrounding v0.5 prose describes the planned expansion, not today's schema. The shipped-vs-planned divergences are also called out in `CHANGELOG.md` under the v0.3 entry.

> **v0.5.3a note:** the reporting slice added **no** tables, indexes, or audit verbs. The history list, manager dashboard, and `shareReceipt` mutation are pure functions over the existing schema. `shareReceipt` writes one field (`pos_transactions.receipt_token`) on first share — the same write the v0.5.1 dormant `_lazyMintReceiptToken_internal` was designed for. The day-window query uses the existing `pos_transactions.by_status_created` index.

Cross-module direct `ctx.db` access is a CI lint block (see `tools/eslint-rules/no-cross-module-db-access.js`).

## Conventions

- Table names use `snake_case`.
- POS-specific tables prefixed `pos_` except the cross-cutting `staff`, `staff_sessions`, `registered_devices`, and `audit_log` (POS-owned today, available to Frollie Pro modules in the future).
- All tables have a Convex `_id` and `_creationTime`. Additional `created_at` / `updated_at` fields are added when business semantics differ from Convex internals (e.g. recording the time an action happened, not when the row was first inserted).
- Money stored as **integer rupiah** ([ADR-015](./ADR/015-idr-integer-rupiah.md)). Display formatting in `src/lib/format.ts`.
- Foreign keys named `<table>_id` and typed as `Id<"table_name">`.
- Enums use string literal unions in TypeScript, validated in Convex schema with `v.union(v.literal(...), ...)`.
- Timestamps are UTC ms (`Date.now()` server-side per [ADR-031](./ADR/031-convex-server-time-wins.md)). Display layer handles timezone.

(Existing per-table sections continue below — unchanged.)

### `outlets` *(v2.0 — owned by `outlets/`)*
Physical outlet (store/booth) registry. One row per outlet within this business's deployment silo ([ADR-051](./ADR/051-multi-outlet-tenancy-silo.md)). The hierarchy is: deployment = business; outlet row = physical location.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"outlets">` | |
| `name` | `string` | Display name e.g. `"Pakuwon"` |
| `code` | `string` | Short slug used in receipt numbers e.g. `"PKW"`. Immutable after first use — used as a prefix in `R-<code>-YYYY-NNNN`. |
| `active` | `boolean` | Soft delete |
| `created_at` | `number` | ms epoch |
| `created_by` | `Id<"staff"> \| null` | Manager who created the outlet; `null` for seed-created default outlet |

Indexes: `by_active` on `active`, `by_code` on `code` (unique).

### `staff_outlet_access` *(v2.0 — owned by `outlets/`)*
Join table granting a staff member access to a specific outlet. A manager with the future `owner` role bypasses this join (implicit access to all outlets).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"staff_outlet_access">` | |
| `staff_id` | `Id<"staff">` | |
| `outlet_id` | `Id<"outlets">` | |
| `granted_at` | `number` | ms epoch |
| `granted_by` | `Id<"staff"> \| null` | Manager who granted access; `null` for seed-created default rows |

Indexes: `by_staff` on `staff_id`, `by_outlet` on `outlet_id`, `by_staff_outlet` on `[staff_id, outlet_id]` (unique — prevents duplicate grants).

### `migration_state` *(v2.0 — owned by `migrations/`)*
Tracks the progress of the multi-step outlet backfill migration. One key per named migration step.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"migration_state">` | |
| `key` | `string` | Migration identifier e.g. `"backfillOutletId"` |
| `status` | `"running" \| "done"` | |
| `cursor` | `string?` | Convex pagination cursor for resumable paginated migrations |
| `processed_count` | `number?` | Running total of rows processed |
| `updated_at` | `number` | |

Indexes: `by_key` on `key` (unique).

---

### `staff`
Booth employees and managers.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"staff">` | |
| `name` | `string` | Display name |
| `pin_hash` | `string` | argon2id encoded string ([ADR-004](./ADR/004-pin-hashing-server-side.md)) |
| `role` | `"staff" \| "manager"` | Manager approves refunds, manual confirms, negative-stock confirms, voids, stock adjustments, on-device settings ([ADR-005](./ADR/005-manager-pin-one-off.md)) |
| `active` | `boolean` | Soft delete |
| `preferences` | `object?` | `{ founders_share_on: boolean }` (defaults true per [ADR-033](./ADR/033-founders-shift-summary-share.md)) |
| `created_at` | `number` | ms epoch |
| `last_login_at` | `number?` | |
| `must_change_pin` | `boolean?` | SEC-03 (v1.1). `true` on the bootstrap-seeded manager → FE forces a one-time rotation prompt after login. Cleared (`false`) by `_changePinCommit_internal` on any successful PIN change. Absent on existing rows = falsy. |
| `locale` | `"en" \| "id"` `?` | v1.2 #1 (i18n). Per-staff UI language preference. Absent ⇒ `"en"` English default (no migration; set by `setOwnLocale` mutation, Task 4). Projected by `getSession` → flows through `useSession` → consumed by `LocaleProvider`. |

Indexes: `by_active` on `active`, `by_role` on `role`.

### `staff_sessions`
Active and historical sessions. Multiple concurrent sessions allowed on the same device for shift overlap ([ADR-003](./ADR/003-shared-device-ephemeral-session.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"staff_sessions">` | |
| `staff_id` | `Id<"staff">` | |
| `device_id` | `string` | Registered device identifier |
| `started_at` | `number` | |
| `ended_at` | `number?` | Null while active |
| `end_reason` | `"manual_lock" \| "timeout" \| "force_logout"` \| null | |
| `outlet_id` | `Id<"outlets">?` | *(v2.0)* Resolved from the device's bound outlet at login. Window-tolerant: unbound devices get the default outlet. SESSION_NO_OUTLET throw deferred to Task 12 (enforce phase). |

Indexes: `by_staff_active` on `[staff_id, ended_at]`, `by_device_active` on `[device_id, ended_at]`, `by_outlet_active` on `[outlet_id, ended_at]` *(v2.0)*.

Stale sessions reaped nightly.

### `pos_auth_attempts`
PIN-failure counter for lockout policy ([ADR-002](./ADR/002-lockout-policy.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_auth_attempts">` | |
| `staff_id` | `Id<"staff">` | Counter is per staff, not per device |
| `fail_count` | `number` | Increments on wrong PIN, resets on success |
| `locked_until` | `number?` | ms epoch; non-null while locked |
| `last_attempt_at` | `number` | For visibility on dashboard |

Indexes: `by_staff` on `staff_id` (unique).

**SEC-01/07 (v1.1):** `_recordFailedAttempt_internal` is no longer `withIdempotency`-wrapped — the old client-key dedupe let a reused key freeze `fail_count` at 1 and defeat lockout. It now takes a `countTowardLockout: boolean`: booth misses pass `true` (counter increments, keyed on `staff_id`); off-booth Telegram-approve misses pass `false` (audited via `staff.failed_pin` but never written here — a leaked approval token must not DoS-lock a booth login; that path is bounded by the per-token cap instead).

### `pos_device_activation_attempts` *(v1.1 — SEC-04, owned by `staff/` via `auth/schema.ts`)*
Brute-force throttle for `/activate` device-setup-code entry.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_device_activation_attempts">` | |
| `key` | `string` | `device_id` for per-device rows, OR the sentinel `"__global__"` for the rolling-window ceiling (an attacker picks `device_id`, so per-device alone is bypassable — the global cap is load-bearing) |
| `fail_count` | `number` | Wrong-code count for this key |
| `window_start_at` | `number` | Global: rolling-window anchor (15-min window) |
| `locked_until` | `number?` | ms epoch; non-null while locked (per-device: 60s past 5 misses; global: 60s past 50 fails/window) |
| `last_attempt_at` | `number` | |

Indexes: `by_key` on `key`.

Written from the `activateDevice` ACTION's `_recordActivationFailure_internal` (a separate committed mutation — a throwing mutation would roll back the increment). Cleared per-device on successful activation. A global breach blocks the window but does NOT wipe `pending_device_setups` (avoids a re-issue DoS).

### `registered_devices`
Devices authorised to run the POS. Activated via one-time setup code from a manager ([strategic foundations §6](./ADR/000-strategic-foundations.md#6-device-registration-before-login-security-control)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"registered_devices">` | |
| `device_id` | `string` | UUIDv4 generated client-side, persisted in IndexedDB + localStorage |
| `label` | `string` | "Booth Phone 1", "Manager Tablet", etc. |
| `activated_by` | `Id<"staff">?` | Manager who issued the setup code. **Absent when activated via a Telegram-issued code** (no booth staff issuer) |
| `activated_at` | `number` | |
| `last_seen_at` | `number?` | |
| `active` | `boolean` | |
| `outlet_id` | `Id<"outlets">?` | *(v2.0)* Bound outlet. Set post-activation by `assignDeviceOutlet` (manager-PIN). Absent = unbound (device shows full roster; session writers use the default outlet as a window fallback until bound). The DEVICE_HAS_NO_OUTLET throw at login + the required-flip are deferred to Task 12 (enforce phase). |

Indexes: `by_device_id` on `device_id` (unique), `by_outlet_active` on `[outlet_id, active]` *(v2.0)*.

### `pending_device_setups`
One-time 6-digit device setup codes (1h TTL), minted by a booth manager or off-booth via Telegram `/activatepos` ([strategic foundations §6](./ADR/000-strategic-foundations.md#6-device-registration-before-login-security-control)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pending_device_setups">` | |
| `setup_code` | `string` | 6-digit code |
| `issued_by` | `Id<"staff">?` | Booth manager who minted the code. **Absent for Telegram-issued codes** |
| `issued_via` | `"booth_inline" \| "telegram"?` | Issuance-path discriminant. **Absent = legacy booth** rows |
| `issued_by_telegram` | `{ from_id?, chat_title }?` | Telegram issuer attribution; present only when `issued_via === "telegram"`. `from_id` omitted for anonymous group admins / channel posts |
| `expires_at` | `number` | 1h TTL |
| `consumed_at` | `number \| null` | Set when the code activates a device |

Indexes: `by_code` on `setup_code` (unique), `by_expires` on `expires_at`.

### `pos_inventory_skus` *(new in v0.5 — atoms)*
Singles only. What kitchen produces, what stock-in adds to ([ADR-016](./ADR/016-product-inventory-separation.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_inventory_skus">` | |
| `sku` | `string` | Slug, e.g. `"dubai"`, `"choco"`. Unique. |
| `name` | `string` | Display, e.g. `"Dubai cookie"` |
| `unit` | `"piece"` | Always `piece` in v1 |
| `low_threshold` | `number` | Triggers low-stock warnings |
| `initials` | `string?` | 2-char fast-visual-ID (e.g. `"Du"`). Falls back to deterministic hue+initials in UI |
| `hue` | `number?` | Deterministic colour for initial tile background |
| `photo_storage_id` | `Id<"_storage">?` | Optional uploaded photo |
| `active` | `boolean` | |
| `created_at` | `number` | |

Indexes: `by_sku` on `sku` (unique), `by_active` on `active`.

### `pos_stock_levels` — v0.3 shipped *(owned by `inventory/`)*
Denormalised current stock for fast catalog rendering. Reconciled nightly from `pos_stock_movements`. **Moved from `catalog/` to `inventory/` in v0.3** (ADR-034).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_stock_levels">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `on_hand` | `number` | Can go negative ([ADR-018](./ADR/018-negative-stock-allowed-flagged.md)) |
| `last_movement_id` | `string?` | **Kept as `v.string()` (not `Id<>`) in v0.3** — narrowing to `Id<"pos_stock_movements">` would risk schema-validation rejection on legacy dev rows. Reconcile at prod cutover (v1.0). Not written by any v0.3 code path. |
| `updated_at` | `number` | |

Indexes: `by_sku` on `inventory_sku_id`.

### `pos_products` *(rewritten in v0.5 — sellable pack-size units)*
Sellable products with pack-size pricing. Each product draws from one or more inventory SKUs via `pos_product_components`.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_products">` | |
| `sku_family` | `string` | e.g. `"dubai"` — informal grouping for display |
| `name` | `string` | e.g. `"Dubai"` |
| `pack_label` | `string` | e.g. `"3 pcs"`, `"8 pcs"`, `"4 pcs"` (for bundles) |
| `price_idr` | `number` | Integer rupiah ([ADR-015](./ADR/015-idr-integer-rupiah.md)) |
| `initials` | `string?` | 2-char ID e.g. `"D3"`. Falls back to `sku_family[0..2].upper()` |
| `hue` | `number?` | Deterministic background colour for initial tile |
| `photo_storage_id` | `Id<"_storage">?` | Optional uploaded photo |
| `active` | `boolean` | |
| `sort_order` | `number` | UI ordering on cart grid |
| `tax_rate` | `number` | Decimal, 0 today, 0.11 future per [strategic foundations §4](./ADR/000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp) |
| `created_at` | `number` | |
| `updated_at` | `number` | |

Indexes: `by_active_sort` on `[active, sort_order]`, `by_family` on `sku_family`.

### `pos_product_components` *(new in v0.5 — join table)*
Maps a sellable product to the inventory SKUs it consumes.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_product_components">` | |
| `product_id` | `Id<"pos_products">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `qty` | `number` | How many SKU units per product unit (Dubai 8pcs → 8) |

Indexes: `by_product` on `product_id`, `by_sku` on `inventory_sku_id`.

### `pos_transactions` — v0.3 shipped *(owned by `transactions/`)*
Core sale record. The v0.3 shape below is what ships in `convex/transactions/schema.ts`. The v0.5 design adds line-level discounts, manual discount sources, per-line tax aggregation, void provenance, receipt tokens, and customer fields — none of those columns exist yet.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_transactions">` | |
| `receipt_number` | `string?` | **`R-<outletcode>-YYYY-NNNN`** *(v2.0 — [ADR-039 amended](./ADR/051-multi-outlet-tenancy-silo.md))*; allocated **only at `_confirmPaid`** ([ADR-023](./ADR/023-receipt-number-format.md)). Pre-v2.0 rows carry `R-YYYY-NNNN` (no outlet prefix). |
| `outlet_id` | `Id<"outlets">?` | *(v2.0)* Derived from session at `commitCart` time. Optional in this additive phase; required-flip deferred to Task 12. |
| `status` | `"draft" \| "awaiting_payment" \| "paid" \| "cancelled"` | v0.3 states. v0.5 adds `"voided"` (refund-derived statuses computed on read per [ADR-008](./ADR/008-refunds-as-new-rows.md)) |
| `subtotal` | `number` | Sum of line subtotals (integer rupiah per [ADR-015](./ADR/015-idr-integer-rupiah.md)) |
| `voucher_code_snapshot` | `string?` | Snapshot of the applied voucher code |
| `voucher_discount` | `number` | `0` if no voucher ([ADR-010](./ADR/010-no-voucher-stacking.md): one voucher per txn) |
| `total` | `number` | `subtotal - voucher_discount` |
| `flags` | `number` | Bitset; `NEG_STOCK = 1 << 0` ([ADR-018](./ADR/018-negative-stock-allowed-flagged.md)); `PAYMENT_AMOUNT_MISMATCH = 1 << 2` (paid amount ≠ transaction total — honor-and-flag per [ADR-036](./ADR/036-xendit-dedicated-apis-inline.md)). See `transactions/flags.ts` |
| `staff_id` | `Id<"staff">` | Creator |
| `xendit_invoice_id_current` | `string?` | Denormalised pointer to the active invoice ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)). Canonical invoice store is `pos_xendit_invoices`. `null` for draft |
| `created_at` | `number` | Server-set ([ADR-031](./ADR/031-convex-server-time-wins.md)) |
| `paid_at` | `number?` | Set at `_confirmPaid` |
| `cancelled_at` | `number?` | |
| `cancelled_reason` | `string?` | |
| `confirmed_via` | `"webhook" \| "polling" \| "manual" \| "manual_bca" \| null` | Confirmation provenance ([strategic foundations §8](./ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)). `"manual_bca"` added v1.2 #10 — staff self-confirm of an out-of-band bank transfer (distinct from `"manual"` which is manager-PIN override). |
| `confirmed_mgr_approver_id` | `Id<"staff">?` | Manager who approved a `manual` confirm |
| `confirmed_manual_reason` | `string?` | Required for `manual` confirm |
| `receipt_token` | `string?` | *(v0.5.1 PR A)* 32-byte URL-safe base64url; unique-by-mint-entropy. Minted in `_confirmPaid` via `mintUrlSafeToken()` ([ADR-021](./ADR/021-receipt-url-convex-http-action.md)). Immutable once set; powers `/r/<token>` |

Indexes:
- `by_status_created` on `[status, created_at]` (ADR-026 reconciliation — kept; Public API uses it cross-outlet)
- `by_receipt_number` on `receipt_number`
- `by_staff_created` on `[staff_id, created_at]`
- `by_receipt_token` on `receipt_token` *(v0.5.1 PR A)*
- `by_outlet_status_created` on `[outlet_id, status, created_at]` *(v2.0 — primary per-outlet scan)*
- `by_outlet_paid_at` on `[outlet_id, paid_at]` *(v2.0)*

### `pos_transaction_lines` — v0.3 shipped *(owned by `transactions/`)*
Line items. **Prices snapshotted at sale time** (never recomputed). The v0.5 design adds per-line discounts, computed tax amount, line total, and `refunded_qty` — none of those columns exist in v0.3.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_transaction_lines">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `product_id` | `Id<"pos_products">` | Reference for reporting; do NOT join for price |
| `product_code_snapshot` | `string` | Stable product code at sale time |
| `product_name_snapshot` | `string` | Product name at sale time |
| `unit_price_snapshot` | `number` | Snapshot, integer rupiah |
| `tax_rate_snapshot` | `number` | Schema-ready ([strategic foundations §4](./ADR/000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp)); `0` today |
| `qty` | `number` | Integer pack units (e.g. 2 boxes of "Dubai 3pcs") |
| `line_subtotal` | `number` | `qty * unit_price_snapshot` |
| `refunded_qty` | `number?` | *(v0.5.1 PR B)* Denormalised count of units already refunded across all refund rows for this line; used by `lineRefundable(line)` to compute remaining refund capacity. Patched by `_commitRefund_internal` (refunds module) through `transactions/internal._patchLineRefundedQty_internal`. Optional because pre-v0.5.1 rows have `undefined`; `lineRefundedQty()` treats `undefined` as `0`. |

Indexes: `by_transaction` on `transaction_id`.

### `pos_payments`
Payment attempts. One transaction can have multiple if the first invoice expired or was cancelled+retried.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_payments">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `method` | `"qris" \| "bca_va"` | |
| `amount` | `number` | |
| `xendit_invoice_id` | `string` | |
| `xendit_invoice_url` | `string?` | For dashboard inspection |
| `xendit_qr_string` | `string?` | QRIS payload, base64 |
| `xendit_va_number` | `string?` | BCA VA account |
| `xendit_va_bank` | `string?` | Always "BCA" in v1 |
| `status` | `"pending" \| "paid" \| "expired" \| "failed" \| "cancelled"` | `cancelled` = explicitly cancelled-via-Xendit-API by retry ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)) |
| `expires_at` | `number` | 5 min from creation by default |
| `paid_at` | `number?` | |
| `confirmed_via` | `"webhook" \| "polling" \| "manual_override" \| null` | [strategic foundations §8](./ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern) |
| `confirmed_by` | `Id<"staff">?` | Manager id for `manual_override` |
| `manual_override_reason` | `string?` | Required for `manual_override` |
| `failure_reason` | `string?` | |
| `raw_callback` | `string?` | Last webhook payload JSON for debugging |

Indexes:
- `by_transaction` on `transaction_id`
- `by_xendit_invoice` on `xendit_invoice_id` (unique)
- `by_status_expires` on `[status, expires_at]` for cleanup

### `pos_xendit_invoices` — v0.3 shipped *(owned by `payments/`)*
History of all Xendit invoices created for a transaction, including cancelled ones ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md), adjusted by [ADR-036](./ADR/036-xendit-dedicated-apis-inline.md)). `by_xendit_invoice_id` is the webhook dedup index.

> **ADR-036 (2026-05-28):** `xendit_invoice_id` stores the QR Codes `id` for QRIS invoices and the FVA `id` for BCA VA invoices — it is the webhook match index in both cases. Two additive optional columns added: `receipt_id` and `payment_source`.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_xendit_invoices">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `xendit_invoice_id` | `string` | Dual-meaning: QR Codes `id` (QRIS) or FVA `id` (BCA VA). Webhook match key via `by_xendit_invoice_id` index |
| `xendit_idempotency_key` | `string` | `X-IDEMPOTENCY-KEY` sent to Xendit at creation; recorded for audit + retry traceability |
| `method` | `"QRIS" \| "BCA_VA"` | |
| `qr_string` | `string?` | QRIS payload (QRIS invoices only) |
| `va_number` | `string?` | BCA VA account number (BCA_VA invoices only) |
| `status_at_create` | `string` | Xendit-reported status at creation |
| `created_at` | `number` | |
| `cancelled_at` | `number?` | |
| `cancelled_reason` | `string?` | |
| `replaced_by_invoice_id` | `Id<"pos_xendit_invoices">?` | Points to the invoice that superseded this one on retry |
| `receipt_id` | `string?` | Bank RRN (Reference/Receipt Number) — join key to the Xendit settlement report for Frollie Pro reconciliation. Written on webhook by `_onPaidWebhook_internal` when `payment_detail.receipt_id` is present |
| `payment_source` | `string?` | Paying wallet or bank (e.g. `"DANA"`, `"OVO"`, `"BCA"`). Written on webhook when `payment_detail.source` is present |

Indexes: `by_transaction` on `transaction_id`, `by_xendit_invoice_id` on `xendit_invoice_id` (webhook dedup).

### `pos_refunds` — v0.5.1 PR B shipped *(owned by `refunds/`)*
Refund ledger ([ADR-008](./ADR/008-refunds-as-new-rows.md)). One row per refund event; multiple refunds against the same txn compose. Per-line subset embedded inline (no separate `pos_refund_lines` table — that was a pre-v0.5.1 design that didn't ship). Per-line `refund_amount` is computed via the ADR-040 single-floor helper `computeRefundAmount` at commit time and frozen on the row.

Both the booth-PIN (`commitRefundInline`) and Telegram-PIN (`approveRefund`) paths funnel through `_commitRefund_internal` — the single writer for this table (v0.5.0 cross-path-parity).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_refunds">` | |
| `transaction_id` | `Id<"pos_transactions">` | Original paid txn being refunded |
| `lines` | `Array<{ line_id: Id<"pos_transaction_lines">, qty: number, refund_amount: number }>` | Per-line subset. `qty` ≤ `lineRefundable(line)`; `refund_amount` is ADR-040 floor-rounded integer rupiah |
| `total_refund` | `number` | Sum of `lines[].refund_amount`, integer rupiah ([ADR-015](./ADR/015-idr-integer-rupiah.md)) |
| `reason` | `string` | Free-text supplied by staff at request time |
| `requested_by` | `Id<"staff">` | Staff who initiated the refund (session staff) |
| `approver_id` | `Id<"staff">` | Manager whose PIN authorised the refund (may equal `requested_by` if a manager is logged in at the booth) |
| `approval_source` | `"booth_inline" \| "telegram_approval"` | Which authorisation path was used |
| `approval_request_id` | `Id<"pos_approval_requests">?` | Set for `telegram_approval` path; absent for `booth_inline` |
| `settlement_status` | `"pending" \| "settled"` | ADR-038 two-stage bookkeeping. Inserted as `pending`; flipped to `settled` by `markRefundSettled` (manager-session, NOT PIN) |
| `settled_by` | `Id<"staff">?` | Manager who marked the refund settled; set together with `settled_at` |
| `settled_at` | `number?` | ms epoch when `markRefundSettled` ran |
| `created_at` | `number` | Server-set per [ADR-031](./ADR/031-convex-server-time-wins.md) |

Indexes:
- `by_transaction` on `transaction_id` (receipt rendering — list all refunds for a txn)
- `by_settlement_status` on `[settlement_status, created_at]` (composite — powers `/mgr/refunds-pending` FIFO list)

### `pos_stock_movements` — v0.3 shipped *(owned by `inventory/`)*
Every stock change. Append-only in spirit ([ADR-020](./ADR/020-stock-movement-source-enum.md)). The v0.3 shape ships the `sale` source path only; `stock_in`, `spoilage`, and `adjustment` are reserved enum members wired up in v0.5/v0.6. Sale movements reference their originating transaction line; the `by_line_and_sku` index gives the ADR-026 reconciliation-dedup guard (no second decrement for the same line+SKU).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_stock_movements">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `qty` | `number` | Signed; **negative for sale** |
| `source` | `"sale" \| "stock_in" \| "spoilage" \| "adjustment" \| "refund" \| "recount"` | `sale` (v0.3), `refund` (v0.5.1 PR B), `recount` *(v0.5.2 — staff absolute recount per [ADR-041](./ADR/041-recount-staff-absolute-stock-update.md); signed delta = `entered − before`)*, `spoilage` *(v0.6 — manager-PIN-gated spoilage write-off; signed-negative SKU decrement)*. `stock_in` / `adjustment` reserved |
| `source_transaction_line_id` | `Id<"pos_transaction_lines">?` | Set for `sale` movements; the ADR-026 dedup key |
| `spoilage_reason` | `string?` | *(v0.6)* Required free-text reason when `source === "spoilage"`; ≤ 200 chars. Absent for all other sources. |
| `spoilage_event_id` | `string?` | *(v0.6)* Groups multi-line spoilage events into one logical event (a single spoilage submission can write off multiple SKUs; all rows share the same `spoilage_event_id`). Absent for non-spoilage sources. |
| `created_at` | `number` | |
| `recorded_by_staff_id` | `Id<"staff">?` | Staff who triggered the movement |

Indexes:
- `by_sku_created` on `[inventory_sku_id, created_at]`
- `by_line_and_sku` on `[source_transaction_line_id, inventory_sku_id]` (ADR-026 reconciliation dedup)

### `pos_low_stock_alerts` *(v0.5.2 — owned by `inventory/`, ADR-042)*

Dedup flag for the reactive low-stock alert. The threshold is NOT here — it lives on the catalog-owned `pos_inventory_skus.low_threshold`. The row's existence is the flag.

| Field | Type | Note |
|---|---|---|
| `_id` | `Id<"pos_low_stock_alerts">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `alerted_at` | `number` | ms epoch; when the alert first fired. Row's existence is the flag — no `updated_at`. |

Index: `by_sku` on `inventory_sku_id`.

Lifecycle: Inserted by `_checkLowStock_internal` when `on_hand < low_threshold` and no flag exists. **Deleted** (not patched) when `on_hand` climbs back to/above threshold — re-arms the alert.

### `pos_recount_state` *(v0.5.2 — owned by `inventory/`, ADR-041)*

Per-outlet singleton holding the timestamp of the most recent recount. Drives the hourly recount nudge banner on the home screen. **v2.0:** scoped to `outlet_id`; reads via `by_outlet` index.

| Field | Type | Note |
|---|---|---|
| `_id` | `Id<"pos_recount_state">` | |
| `last_recount_at` | `number` | ms epoch. Actor identity lives on the matching `audit_log` row (`stock.recount`). |
| `outlet_id` | `Id<"outlets">?` | *(v2.0)* Outlet scope. Optional during additive phase. |

Indexes: `by_outlet` on `outlet_id` *(v2.0)*.

### `pos_stock_drift_log` *(v0.6 — owned by `inventory/`, [ADR-044](./ADR/044-nightly-stock-reconciliation.md))*

Nightly drift detector output. One row per drifted SKU per cron run when `pos_stock_levels.on_hand` (the denormalised cache) diverges from on-the-fly reconstruction across `pos_stock_movements`. Append-only by convention; resolution patches `resolved_at` / `resolved_by_staff_id` / `resolution_note` in place but never deletes.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_stock_drift_log">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `sku_code` | `string` | Snapshot of `pos_inventory_skus.sku` at detection time — survives SKU renames |
| `cached_on_hand` | `number` | `pos_stock_levels.on_hand` at detection time |
| `reconstructed_on_hand` | `number` | Sum of all `pos_stock_movements.qty` for the SKU at detection time |
| `delta` | `number` | `cached_on_hand − reconstructed_on_hand`; non-zero by construction |
| `detected_at` | `number` | ms epoch; when the nightly cron observed the drift |
| `resolved_at` | `number?` | Set when a manager marks the drift resolved; absent = open |
| `resolved_by_staff_id` | `Id<"staff">?` | Manager who resolved |
| `resolution_note` | `string?` | Optional free-text explanation |

Indexes:
- `by_sku_detected` on `[inventory_sku_id, detected_at]` (per-SKU history)
- `by_unresolved` on `[resolved_at]` (open-drift list — filter `resolved_at === undefined` in JS post-collect; see the optional-field gotcha noted on `telegramChats`)

### `pos_drafts` *(new in v0.5)*
Saved cart state with TTL ([ADR-032](./ADR/032-saved-drafts-purge-24h.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_drafts">` | |
| `staff_id` | `Id<"staff">` | |
| `payload` | `string` | JSON-serialised cart state |
| `customer_phone` | `string?` | |
| `customer_name` | `string?` | |
| `created_at` | `number` | |
| `expires_at` | `number` | `created_at + 24h`. Reaped daily. |

Indexes: `by_staff_date` on `[staff_id, created_at]`, `by_expires` on `expires_at`.

### `pos_discounts`
Discount configurations created by management.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_discounts">` | |
| `name` | `string` | "Grand Opening 10%", etc. |
| `type` | `"percentage_cart" \| "fixed_cart" \| "percentage_item" \| "fixed_item"` | v1 ships `percentage_cart` only |
| `value` | `number` | Percentage as decimal (0.10) or integer rupiah |
| `requires_manager` | `boolean` | Manual / ad-hoc always true |
| `active` | `boolean` | |
| `created_by` | `Id<"staff">` | |
| `created_at` | `number` | |

Indexes: `by_active` on `active`.

### `pos_vouchers` — v0.3 shipped *(owned by `vouchers/`)*
Voucher codes. Static, manager-managed. v0.3 carries the discount inline on the voucher (`type` + `value`) rather than via a separate `pos_discounts` row; the `pos_discounts` table is a v0.5 concept and is not yet created.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_vouchers">` | |
| `code` | `string` | UPPERCASE, immutable |
| `type` | `"percentage" \| "amount"` | |
| `value` | `number` | Percentage `0-100`, or rupiah amount |
| `min_cart_value` | `number?` | Subtotal threshold to qualify |
| `max_redemptions` | `number?` | Null = unlimited |
| `used_count` | `number` | Incremented atomically with redemption insert |
| `expires_at` | `number?` | Null = no expiry |
| `active` | `boolean` | |
| `created_at` | `number` | |
| `created_by_staff_id` | `Id<"staff">?` | Optional — vouchers created via the Convex dashboard (v0.3–v0.5 manager workflow) have no staff context |

Indexes: `by_code` on `code`, `by_active_expires` on `[active, expires_at]`.

### `pos_voucher_redemptions` — v0.3 shipped *(owned by `vouchers/`)*
Append-only. One row per redemption. `by_transaction` enforces the one-voucher-per-txn rule ([ADR-010](./ADR/010-no-voucher-stacking.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_voucher_redemptions">` | |
| `voucher_id` | `Id<"pos_vouchers">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `code_snapshot` | `string` | Voucher code at redemption time |
| `discount_amount` | `number` | Snapshot of discount applied |
| `redeemed_at` | `number` | |

Indexes: `by_voucher` on `voucher_id`, `by_transaction` on `transaction_id`.

### `pos_approval_requests` — v0.4 updated *(owned by `approvals/`)*
Each row = one off-booth approval request ([ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md), [ADR-035](./ADR/035-telegram-as-internal-comms.md)). v0.3 shipped with a single `kind` (`staff_pin_reset`). **v0.4 generalises the table**: `kind` gains `manual_payment_override`; the `subject_staff_id` field becomes optional (back-compat for `staff_pin_reset`); generic entity pointer fields (`requester_staff_id`, `entity_type`, `entity_id`, `context`, `reason`) are added for non-PIN kinds per [ADR-030](./ADR/030-approval-audit-captures-full-context.md); `status` gains `"denied"` with corresponding denial provenance fields; Telegram linkage columns are added. The capability token remains collapsed onto this row (`token_hash` + `token_expires_at`); `pos_approval_tokens` does not exist.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_approval_requests">` | |
| `kind` | `"staff_pin_reset" \| "manual_payment_override" \| "refund" \| "spoilage"` | `manual_payment_override` added in v0.4; `refund` added in v0.5.1 PR B; `spoilage` added in v0.6 (off-booth spoilage approval) |
| `requester_staff_id` | `Id<"staff">?` | Staff who triggered the request; optional because `staff_pin_reset` is system-triggered |
| `entity_type` | `string?` | Generic entity pointer — entity being approved (e.g. `"pos_transactions"`). Non-PIN kinds |
| `entity_id` | `string?` | Stringified `_id` of the entity being approved |
| `subject_staff_id` | `Id<"staff">?` | Staff whose PIN is being reset (`staff_pin_reset` only; now optional for back-compat) |
| `context` | `any?` | Per-kind context object. Validated by `APPROVAL_KINDS[kind]` in `_createRequest_internal` (single writer); `v.any()` in schema is unavoidable for a shared column |
| `reason` | `string?` | Human-readable reason supplied by the requester |
| `triggered_by_event` | `string` | `"auth_lockout"` for `staff_pin_reset`; arbitrary string for other kinds |
| `triggered_at` | `number` | |
| `token_hash` | `string` | `sha256(rawToken)` hex; raw token only ever in the URL. SHA-256 (deterministic, not argon2id) — index lookup requires determinism; tokens are high-entropy (32 bytes) so salt-less hashing is fine ([ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md), [ADR-004](./ADR/004-pin-hashing-server-side.md)) |
| `token_expires_at` | `number` | `triggered_at + 60min` ([ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md)) |
| `status` | `"pending" \| "resolved" \| "denied" \| "expired"` | `"denied"` added in v0.4 |
| `notified_at` | `number?` | Stamped when the Telegram notification went out |
| `resolved_at` | `number?` | |
| `resolved_by_manager_id` | `Id<"staff">?` | Manager who approved (PIN authorises ACT per [ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md)) |
| `denied_at` | `number?` | Set when manager denies the request *(v0.4)* |
| `denied_by_manager_id` | `Id<"staff"> \| "system" \| undefined` | Manager who denied *(v0.4)*; `"system"` sentinel used for auto-denies (PIN-cap trip, txn cascade) *(v0.5.0)* |
| `deny_reason` | `string?` | Required denial reason *(v0.4)* |
| `failed_pin_attempts` | `number?` | Per-token PIN attempt counter; absent = 0. Request is auto-denied when value reaches `TOKEN_PIN_ATTEMPT_CAP` (5). Counts ALL manager PIN failures on this token — legitimate fumbles included. *(v0.5.0)* |
| `notification_channel` | `"telegram"?` | Notification path used; `"telegram"` is the only supported literal *(v0.4)* |
| `telegram_message_id` | `number?` | Telegram message ID of the approval notification; patched after send *(v0.4)* |
| `telegram_chat_id` | `string?` | Telegram chat the notification was sent to; patched after send *(v0.4)* |

Indexes: `by_token_hash` on `token_hash`, `by_status_triggered` on `[status, triggered_at]`, `by_subject_staff` on `subject_staff_id`, `by_kind_status` on `[kind, status]` *(v0.4)*.

### `pos_idempotency` *(new in v0.5)*
Mutation dedupe table ([ADR-013](./ADR/013-idempotency-keys.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_idempotency">` | |
| `key` | `string` | Client-generated UUIDv4 |
| `mutation_name` | `string` | For debugging |
| `staff_id` | `Id<"staff">?` | Optional — pre-auth mutations (e.g. activateDevice) leave it unset |
| `response_blob` | `string` | JSON-serialised response |
| `expires_at` | `number` | `created_at + 24h` |

Indexes: `by_key` on `key` (unique), `by_expires` on `expires_at`.

### `telegram_log` *(owned by `telegram/` — debug-trail only)*
POC debug-trail for inbound/outbound Telegram messages. **Not** the webhook dedupe source (that is `telegramUpdates`) and **not** the approval linkage (that is `pos_approval_requests.telegram_message_id`). Written opportunistically; do not build logic on top of it.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"telegram_log">` | |
| `direction` | `"out" \| "in"` | |
| `template_kind` | `string?` | Template used for outbound messages. Known kinds (matches `sendTemplate`'s `kind` union in `convex/telegram/send.ts`): `staff_pin_reset`, `manual_payment_override`, `refund`, `founders_summary`, `recount_event`, `low_stock_alert`, `spoilage` *(v0.6 — approval template, URL button to `/approve/:token`)*, `stock_drift_alert` *(v0.6 — informational nightly drift notice; no URL button)* |
| `payload_json` | `string` | Full message payload JSON |
| `update_id` | `number?` | Telegram update ID (inbound) |
| `callback_data` | `string?` | Callback query data (inbound) |
| `from_user` | `string?` | Sender username/name (inbound) |
| `message_id` | `number?` | Telegram message ID |
| `created_at` | `number` | |

Indexes: `by_update_id` on `update_id`, `by_created_at` on `created_at`.

### `telegramChats` — v0.4 shipped *(owned by `telegram/`)*
Self-registration registry. One row per Telegram chat that has sent `/register@<bot>`. Ported from the canonical `convex-telegram-bot-starter` ([ADR-035](./ADR/035-telegram-as-internal-comms.md)). Used to identify which group is the managers' group when dispatching approval notifications.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"telegramChats">` | |
| `chatId` | `string` | Telegram chat ID |
| `chatType` | `"private" \| "group" \| "supergroup"` | |
| `title` | `string` | Chat display name |
| `role` | `string?` | Logical role (e.g. `"managers"`, `"founders"`) — set via bot command post-registration |
| `registeredBy` | `number?` | Telegram user ID of the registering user |
| `registeredAt` | `number` | |
| `lastSeenAt` | `number` | Updated on every inbound message from this chat |
| `archivedAt` | `number?` | Set when the chat is deregistered; non-null = archived |
| `lastError` | `{ at: number, message: string }?` | Last send error for this chat; cleared on next success |

Indexes: `by_chatId` on `chatId`, `by_role` on `[role]`. The active-only filter on `archivedAt === undefined` happens in JS post-collect — the Convex optional-field filter gotcha (see MEMORY.md) means `.eq("archivedAt", undefined)` diverges between convex-test and prod, so the bare-`by_role` + JS-post-filter pattern is the proven-safe lookup. A compound `by_role_archived` index existed pre-v0.5.1 but was dropped once the test was rewritten to mirror prod.

### `telegramUpdates` — v0.4 shipped *(owned by `telegram/`)*
Webhook dedupe table. One row per processed Telegram update ID. Prevents double-processing Telegram retries before the bot responds 200. Insert-before-process; row persists forever (low volume, no reap needed for v1).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"telegramUpdates">` | |
| `updateId` | `number` | Telegram `update_id` |
| `receivedAt` | `number` | |

Indexes: `by_update_id` on `updateId`.

### `pos_settings` — v0.4 shipped *(owned by `settings/`)*
Single-row settings table. v0.4 ships one field (`founders_summary_enabled`); v0.5 extends with business config (booth name, receipt copy, etc.). **Read-time default:** `settings/public.getSettings` returns `founders_summary_enabled: true` when the row is absent — no seeded row required at startup. Prevents first-cron throw on a fresh deployment.

> **v0.5 planned expansion:** business_name, booth_name, address, phone, email, npwp, is_pkp, header_copy, footer_copy, ig_qr_enabled, receipt_token_salt. None of those columns exist in v0.4.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_settings">` | One row only (singleton pattern) |
| `founders_summary_enabled` | `boolean` | Controls whether shift-end summary is shared to Founders group. Read-time default `true` when row absent ([ADR-033](./ADR/033-founders-shift-summary-share.md)) |
| `receipt_business_name` | `string?` | *(v0.5.3b)* Receipt header business name (e.g. `"Frollie"`). Read-time default applied by `_getSettings_internal` when absent |
| `receipt_address` | `string?` | *(v0.5.3b)* Receipt header address line |
| `receipt_contact` | `string?` | *(v0.5.3b)* Receipt header contact (phone / website) |
| `receipt_instagram_handle` | `string?` | *(v0.5.3b)* IG handle for the receipt footer (e.g. `"@frollie"`) |
| `receipt_footer_text` | `string?` | *(v0.5.3b)* Free-text footer line on the receipt (e.g. "Terima kasih") |
| `receipt_logo_storage_id` | `Id<"_storage">?` | *(v0.5.3b)* Optional uploaded logo (Convex storage). Rendered as `<img>` above the header text when present. Set via `generateLogoUploadUrl` → `updateReceiptConfig` |
| `txn_ticker_enabled` | `boolean?` | *(v1.0.2)* Writable via the manager-session toggle on `/mgr/telegram-chats` (`settings.setTxnTickerEnabled`). Read-time default `true` when absent. Dashboard edit remains a break-glass kill-switch. |
| `manual_bca_enabled` | `boolean?` | *(v1.2 #10)* Shows/hides the "Bank transfer (manual)" tender on the charge screen. Read-time default `true` when absent (`MANUAL_BCA_DEFAULTS`, `settings/internal.ts`). |
| `manual_bca_bank_name` | `string?` | *(v1.2 #10)* Display label for the bank. Read-time default `"BCA"` when absent. |
| `manual_bca_account_name` | `string?` | *(v1.2 #10)* Account holder name shown to staff for verification. Read-time default `"PT Malo Group Bahagia"` when absent. |
| `manual_bca_account_number` | `string?` | *(v1.2 #10)* Account number shown to staff — stored as a **string** (leading-zero safe, never coerced). Read-time default `"6044830994"` when absent. |
| `outlet_device_id` | `string?` | *(v1.2 — **RETIRED in v2.0**)* Was the designated booth outlet device_id for the PR #124 SOP gate. **Replaced by `registered_devices.outlet_id` + `assignDeviceOutlet`.** Existing rows are ignored; `settings.outletStatus` and `staff.setOutletDevice` have been deleted. |
| `outlet_id` | `Id<"outlets">?` | *(v2.0)* Scopes this settings row to a specific outlet. `_getSettings_internal` takes an `outletId?` arg and reads `by_outlet`. Pre-v2.0 singleton row has no `outlet_id` and is the fallback. |
| `updated_at` | `number` | |
| `updated_by` | `Id<"staff">?` | Optional — row may be updated by a system action |

### `pos_settlements`
Per-day payout aggregate ([strategic foundations §7](./ADR/000-strategic-foundations.md#7-settlement-as-a-second-stage-record), [ADR-012](./ADR/012-settlements-visible-to-staff-and-managers.md) + amendment). **Corrected 2026-06-08 (v0.7): there is no Xendit 'settlement object' — a row is our own per-day aggregate keyed by `settlement_key`, dual-source (manual + nightly poll), poll-wins-on-conflict.** See [ADR-012 amendment](./ADR/012-settlements-visible-to-staff-and-managers.md#amended-2026-06-08-v07) + [`docs/xendit-reference/settlement-reconciliation.md`](./xendit-reference/settlement-reconciliation.md). All money integer rupiah (ADR-015).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_settlements">` | |
| `settlement_key` | `string` | `settle-YYYY-MM-DD` — unique upsert key (one row per settlement day) |
| `settlement_date` | `string` | `YYYY-MM-DD` (WIB calendar) |
| `gross_amount` | `number` | Collected sales total for the day |
| `mdr_amount` | `number` | Xendit's total deductions = `gross - net` (poll path uses Xendit's `net_amount` directly). **Note:** the *total* deduction — the MDR fee **plus** any VAT/withholding on that fee — not strictly the MDR. UI label "Biaya Xendit". Relevant if PKP/PPN flips (rule #3). |
| `net_amount` | `number` | What hits BCA (`gross - mdr`) |
| `transaction_count` | `number` | |
| `source` | `"xendit_poll" \| "manual"` | Row origin: nightly poll or manual manager entry |
| `entered_by` | `Id<"staff">?` | Set for `source="manual"` only (the recording manager) |
| `last_synced_at` | `number?` | Set on each `xendit_poll` upsert (poll only) |
| `bca_account_destination` | `string?` | Last 4 digits for verification (ADR-012) |
| `payload` | `string?` | Raw aggregated rows JSON (poll); debug + future match-back |
| `synced_to_frollie_pro_at` | `number?` | Dormant v1.1 hook |
| `created_at` | `number` | |

Indexes: `by_settlement_date` on `settlement_date`, `by_settlement_key` on `settlement_key`.

### `pos_receipt_counters` — v0.3 shipped *(owned by `transactions/`)*
Atomic counter for `R-<outletcode>-YYYY-NNNN` allocation ([ADR-023](./ADR/023-receipt-number-format.md), [ADR-051](./ADR/051-multi-outlet-tenancy-silo.md)). The `next_number` is allocated atomically inside `_confirmPaid`. **v2.0:** re-keyed to `(outlet_id, year)`; old `by_year` index kept for backward compat during additive phase; `by_outlet_year` is the live index.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_receipt_counters">` | |
| `year` | `number` | **WIB calendar year** (UTC+7, no DST) — not the UTC year. The new WIB year takes effect at 17:00 UTC on Dec 31; booth + accounting + customers all expect the WIB calendar |
| `next_number` | `number` | Monotonic; next NNNN to allocate |
| `outlet_id` | `Id<"outlets">?` | *(v2.0)* Scopes the counter to a specific outlet. Optional during additive phase. |

Indexes: `by_year` on `year` (legacy — kept during additive phase), `by_outlet_year` on `[outlet_id, year]` *(v2.0 — primary)*.

### `pos_receipt_html_cache` *(v0.5.1 PR A — owned by `receipts/`)*
Per-token cache of rendered receipt HTML. 24h TTL with lazy regenerate on miss (no reaper cron — Convex storage is cheap; lazy is always correct). One row per `receipt_token`. Cache is purged on refund commit in PR B so the receipt re-projects refund state ([ADR-039](./ADR/039-receipt-after-refund.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_receipt_html_cache">` | |
| `token` | `string` | Matches `pos_transactions.receipt_token` |
| `html` | `string` | Fully-rendered receipt HTML |
| `expires_at` | `number` | `now + 24h`, server-set |

Indexes: `by_token` on `token`.

### `pos_error_reports` *(v1.0.1 — owned by `ops/`)*

Launch-day error/crash telemetry from the `POST /ops/error` pipe (client crashes, unhandled errors, payment/mutation failures, and backend action/webhook failures). **Append-only telemetry — this is NOT `audit_log`** ([ADR-007](./ADR/007-audit-log-append-only.md)): it is operational crash/error capture with dedup + storm-cap, not a business audit trail, and lives in its own `ops/` module table. One row per ingested report; rows that clear the dedup/storm-cap gate fire a `system_error` Telegram alert to the `ops` role and set `alerted = true`.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_error_reports">` | |
| `kind` | `"crash" \| "unhandled" \| "payment" \| "mutation" \| "backend"` | Source class: `crash` = RouteErrorBoundary trip; `unhandled` = `window.onerror` / `unhandledrejection`; `payment` = payment-path failure (FE or BE); `mutation` = sale-flow mutation failure (FE); `backend` = BE action/webhook processing failure |
| `message` | `string` | Truncated server-side to `MESSAGE_MAX` |
| `stack` | `string?` | Truncated server-side to `STACK_MAX` |
| `route` | `string?` | Route where the error fired |
| `staff_code` | `string?` | Logged-in staff code, if any |
| `device_id` | `string?` | Reporting device |
| `online` | `boolean?` | `navigator.onLine` at report time |
| `app_version` | `string?` | Bundle version (`__APP_VERSION__`) |
| `signature` | `string` | Pure `hash(kind + route + normalized message)` — dedup key |
| `alerted` | `boolean` | Did this row trigger a Telegram `system_error` send? |
| `created_at` | `number` | Server time ([ADR-031](./ADR/031-convex-server-time-wins.md)) |

Indexes: `by_signature_created` on `[signature, created_at]` (dedup + storm-cap window lookup), `by_created` on `created_at`.

### `audit_log`
Append-only log of every state-changing action ([ADR-007](./ADR/007-audit-log-append-only.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"audit_log">` | |
| `actor_id` | `Id<"staff"> \| "system"` | |
| `action` | `string` | See enum below |
| `entity_type` | `string` | `transaction`, `payment`, `refund`, `stock_movement`, `approval_request`, etc. |
| `entity_id` | `string?` | Stringified `_id` of the affected entity |
| `before_state` | `string?` | JSON snapshot before change |
| `after_state` | `string?` | JSON snapshot after change |
| `device_id` | `string?` | Where the action executed |
| `mgr_approver_id` | `Id<"staff">?` | Manager who approved (for actions routed via WA approval) |
| `source` | `"booth_inline" \| "wa_approval" \| "telegram_approval" \| "system" \| "reaper"` | Routing path for the action ([ADR-030](./ADR/030-approval-audit-captures-full-context.md)). `telegram_approval` added in v0.4; `wa_approval` retained for back-compat |
| `reason` | `string?` | For overrides, refunds, adjustments |
| `metadata` | `string?` | JSON: e.g. `{ approval_request_id, token_consumed_at }` |
| `created_at` | `number` | |

Indexes:
- `by_actor_date` on `[actor_id, created_at]`
- `by_entity` on `[entity_type, entity_id]`
- `by_action_date` on `[action, created_at]`
- `by_source_date` on `[source, created_at]`

Audit action enum (v1):

```
staff.login
staff.logout
staff.failed_pin
staff.locked_out
staff.pin_reset
staff.shift_summary_shared
staff.created
device.deactivated          # device.activated + device.setup_code_issued documented in the v0.5.7 block below
device.activation_throttled # v1.1 SEC-04 — global activation rate-limit breach (source: system)
seed.reset
seed.launch_catalog         # one-shot prod catalog seed (v1.0 launch — _seedLaunchCatalog_internal)
transaction.created
transaction.line_added
transaction.line_removed
transaction.line_qty_changed
transaction.discount_applied
transaction.voucher_redeemed
transaction.saved_as_draft
transaction.draft_resumed
transaction.draft_discarded
transaction.voided
payment.initiated
payment.invoice_cancelled
payment.confirmed_webhook
payment.confirmed_polling
payment.confirmed_manual_override
payment.expired
payment.failed
refund.initiated
refund.approved
refund.completed
refund.failed
stock.received
stock.adjusted
stock.spoilage
stock.returned
stock.recon_drift
stock.recon_drift_resolved
stock.recon_skip
spoilage.requested
spoilage.approval_resolved
spoilage.denied
approval.created
approval.approved
approval.denied
approval.expired
approval.cancelled
discount.created
discount.edited
voucher.created
voucher.edited
voucher.deactivated
settlement.synced
settings.updated
receipt.token_minted
```

**Audit actions actually emitted as of v0.3 (verified against `convex/`).** `audit_log.action` is a free `v.string()`, so the enum above is the planned v1 vocabulary; the strings below are what v0.3 mutations/actions write today. New-in-v0.3 strings supersede some planned placeholders (e.g. `transaction.committed` is emitted, not the planned `transaction.created`; `payment.confirmed` carries the path in `confirmed_via`, not the planned per-path `payment.confirmed_webhook` etc.).

```
# transactions/
transaction.committed       # draft → awaiting_payment (cart committed)
transaction.cancelled       # awaiting_payment/draft → cancelled (also draft delete)
transaction.resumed         # draft pulled back into an active cart (row deleted, not a void)
payment.confirmed           # _confirmPaid (path recorded in confirmed_via: webhook|polling|manual)
payment.confirmed_on_terminal # paid webhook/poll arrived for a cancelled/terminal txn — alert, no auto-flip (manager reconciles)
# payments/
payment.invoice_created     # Xendit invoice created (QRIS or BCA VA)
payment.invoice_cancelled   # prior invoice cancelled on cart-edit retry (ADR-014)
# inventory/
stock.sale_movement         # signed-negative SKU decrement on sale
stock.recount               # _recordRecount — staff absolute recount; source=booth_inline; metadata={ before, after, delta } (v0.5.2, ADR-041)
stock.low_stock_alerted     # _checkLowStock_internal — fires when on_hand crosses below low_threshold; source=system; metadata={ on_hand, low_threshold } (v0.5.2, ADR-042)
stock.low_threshold_set     # setLowThreshold — manager-gated threshold edit on pos_inventory_skus; source=booth_inline; metadata={ low_threshold } (v0.5.2)
# vouchers/
voucher.redeemed            # voucher applied + used_count incremented
voucher.over_redeemed       # redemption pushed used_count past max_redemptions (flagged, not blocked)
# auth/ + seed/
staff.locked_out            # 3-strike lockout (ADR-002)
staff.pin_changed           # self change via auth.changePin
staff.pin_reset             # manager reset via resetStaffPin / approveStaffPinReset
staff.bootstrapped          # seed-created staff
# approvals/
approval.created            # pos_approval_requests row inserted (system actor)
approval.notified           # Telegram lockout link sent (system actor)
approval.notification_failed # Telegram send failed; pending row deleted, trail kept (system actor)
approval.resolved           # manager approved off-booth PIN reset (wa_approval source)
# refunds/ (v0.5.1 PR B)
refund.requested            # _createRequest_internal (kind=refund) — Telegram approval request created (source=system)
refund.committed            # _commitRefund_internal — pos_refunds row inserted, stock re-credited, receipt cache purged. Source = approvalSource arg (booth_inline | telegram_approval). Exactly one per committed refund (entity_type=pos_refunds)
refund.approval_resolved    # Emitted when an approval request of kind=refund is marked resolved on the Telegram path (_markResolved_internal). Entity_type=pos_approval_requests. The corresponding refund.committed is emitted separately by the refund commit funnel — verbs are distinct (C2, v0.5.1 PR B post-review) so dashboards count refunds without double-counting Telegram-path rows.
refund.denied               # _markDenied_internal via denyRequest (kind=refund) — manager denied the off-booth refund request (source=telegram_approval)
refund.settled              # markRefundSettled — pending → settled bookkeeping flip (ADR-038, manager-session gated, source=booth_inline)
# v0.5.3b admin slice (all source=booth_inline)
staff.updated               # updateStaffName / setStaffRole — metadata={ field:"name"|"role", role? } (manager-session for name; manager-PIN for role)
staff.locale_set            # setOwnLocale (v1.2 #1) — staff-session, self-only; metadata={ locale:"en"|"id" }; source=booth_inline
staff.created               # createStaff action — manager-PIN gated; new staff row inserted with role + pin_hash
staff.deactivated           # deactivateStaff — manager-PIN gated; soft-delete via active=false
product.created             # createProduct action — manager-PIN gated; metadata={ name, price_idr }
inventory_sku.created       # v0.5.5. New inventory SKU created (standalone Add SKU
                            #   on /mgr/products OR the bundled "Also create matching SKU" checkbox during
                            #   Add Product). Source: `booth_inline`. Metadata: `{ sku, name, low_threshold }`
                            #   (bundled-create path also carries `via:"create_product_bundled"`).
product.updated             # updateProductMeta (session) / updateProductPricing (PIN) / setProductComponents (session) / bundled create_product (PIN, v0.5.5) — metadata variants: { field:"meta"|"pricing"|... } | { components_changed:true, count[, sku_id, qty, via:"create_product_bundled"] } | { price_idr:{ from, to } }
product.archived            # archiveProduct — manager-session; soft-delete via active=false
settings.founders_summary_toggled  # (v0.4) setFoundersSummaryEnabled — manager-session; metadata={ enabled: boolean }; source=booth_inline
settings.txn_ticker_toggled        # setTxnTickerEnabled (v1.0.2) — manager-session; metadata={ enabled: boolean }; source=booth_inline
settings.receipt_updated    # updateReceiptConfig — manager-session; metadata={ logo_changed: boolean }; triggers _purgeAllReceiptCache_internal
settings.manual_bca_updated # (v1.2 #10) settings.internal._updateManualBcaConfig_internal — INTERNAL ONLY (ops/dashboard; no public writer — the settlement account is not client-editable); actor_id=system; metadata={ enabled: boolean, via: "backend" }; source=system
settings.outlet_device_set  # (v1.2) RETIRED in v2.0 — was staff.setOutletDevice; replaced by device.assignOutlet below
# v2.0 outlet management
device.assignOutlet         # assignDeviceOutlet (staff/actions.ts) — manager-PIN gated; binds registered_devices.outlet_id to a specific outlet; ends all existing sessions on the device when re-assigning; source=booth_inline; metadata={ device_id, outlet_id, outlet_name }
staff.grantOutletAccess     # grantOutletAccess (staff/actions.ts) — manager-PIN gated; inserts staff_outlet_access row (idempotent); source=booth_inline; metadata={ staff_id, outlet_id }
staff.revokeOutletAccess    # revokeOutletAccess (staff/actions.ts) — manager-PIN gated; deletes staff_outlet_access row; source=booth_inline; metadata={ staff_id, outlet_id }
# v0.6 vouchers admin slice (manager-PIN gated; source=booth_inline)
voucher.created             # createVoucher — new voucher row; metadata={ code, type, value }
voucher.edited              # updateVoucher — metadata captures changed fields
voucher.deactivated         # deactivateVoucher — soft-delete via active=false
# v0.6 spoilage slice
stock.spoilage              # _commitSpoilage_internal — one verb per spoilage event (single audit row even when multiple SKUs written off); metadata carries line breakdown + spoilage_event_id; source = booth_inline | telegram_approval
spoilage.requested          # _createRequest_internal (kind=spoilage) — Telegram approval request created (source=system) via KIND_AUDIT
spoilage.approval_resolved  # _markResolved_internal — emitted when a kind=spoilage approval is resolved on the Telegram path; the corresponding stock.spoilage is emitted separately by the commit funnel (verb-distinct pattern, mirrors refund.committed / refund.approval_resolved); source=telegram_approval, via KIND_AUDIT
spoilage.denied             # _markDenied_internal via denyRequest (kind=spoilage) — manager denied off-booth spoilage; source=telegram_approval, via KIND_AUDIT
# v0.6 stock reconciliation cron (ADR-044)
stock.recon_drift           # nightly recon cron — one row per drifted SKU per run; metadata={ sku_code, cached_on_hand, reconstructed_on_hand, delta }; actor=system
stock.recon_drift_resolved  # resolveDrift mutation — manager-session bookkeeping ack; patches pos_stock_drift_log row in place
stock.recon_skip            # nightly recon cron — one row per cron run that didn't send; metadata.reason ∈ "no_drift" | "role_unbound" | "send_failed"; actor=system
# v0.5.7 device activation (two issuance paths)
device.setup_code_issued    # issueDeviceSetupCode helper. Booth path: source=booth_inline, actor=issuing manager, metadata={ issued_via:"booth_inline" }. Telegram path (/activatepos): source=system (NOT telegram_approval — no PIN/approval gate), actor_id="system", metadata={ issued_via:"telegram", telegram_from_id?, chat_title }
device.activated            # device activated by consuming a setup code. ALWAYS source=booth_inline (activation is a physical booth act); metadata.activated_via ∈ "booth_inline" | "telegram"; actor_id="system" when the code was Telegram-issued
# v0.7 settlements (pos_settlements; single writer _upsertSettlementDay_internal)
settlement.upserted             # one row inserted OR a non-supersede patch (poll-over-poll, manual-over-manual). Covers manual entries too — distinguish via metadata.source="manual". source=booth_inline (manual) | system (poll); metadata={ settlement_date, source, net_amount }
settlement.poll_superseded_manual # a nightly xendit_poll overwrote a prior manual row (poll-wins-on-conflict). source=system; metadata={ settlement_date, source:"xendit_poll", net_amount }
settlement.sync_skipped         # _auditSyncSkip_internal — sync cron ran and found zero settled rows (expected pre-KYB). actor=system; source=system; no entity_id; metadata={ reason, ... }
```

## Relationship to Frollie Pro tables

| Frollie Pro table | POS read | POS write | Notes |
|---|---|---|---|
| `products` | future (v1.1) | no | Frollie Pro retains for B2B/wholesale; POS uses `pos_products` |
| `recipes` | future (v1.1) | no | For kitchen decrement on sales feed |
| `kitchen_inventory` | no | future (v1.1) | Decremented via recipe lookup from POS sales |
| `packaging` | no | no | Out of scope |
| `orders` | no | no | Frollie Pro's order entity is B2B/wholesale, separate concept |

### `api_tokens` *(v1 — Public API, owned by `api/v1/`)*
Opaque bearer tokens for the external API. SHA-256 hashed at rest; auth = hash incoming token → `by_hash` indexed lookup (no plaintext stored). See [ADR-034](./ADR/034-deep-modules-surface-apis.md).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"api_tokens">` | |
| `hash` | `string` | `sha256Hex(rawToken)` — plaintext never stored |
| `label` | `string` | Human note for ops e.g. `"frollie-pro-prod"` |
| `scope` | `"frollie_pro_full"` | Literal union retained for forward-compat; one value in v1 |
| `endpointAllowList` | `string[]` | e.g. `["/api/v1/transactions", "/api/v1/refunds"]` |
| `rateLimitRpm` | `number` | Default 60 |
| `issuedAt` | `number` | ms epoch |
| `expiresAt` | `number` | ms epoch; mandatory, ≤ 365d from issuance |
| `rotatedFrom` | `Id<"api_tokens">?` | Prior token replaced by this rotation |
| `revokedAt` | `number?` | ms epoch; non-null = revoked |

Indexes: `by_hash` on `hash`.

### `api_rate_buckets` *(v1 — Public API, owned by `api/v1/`)*
Per-token RPM counter. One row per `(token_id, minute-window)` pair; count incremented on every request within the window.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"api_rate_buckets">` | |
| `token_id` | `Id<"api_tokens">` | |
| `window_start` | `number` | ms epoch floored to the minute |
| `count` | `number` | Requests in this window |

Indexes: `by_token_window` on `[token_id, window_start]`.

### `api_request_log` *(v1 — Public API, owned by `api/v1/`)*
Append-only access log — one row per API request (success AND failure, including unauthenticated attempts where `token_id` is null). This is NOT `audit_log` — [ADR-007](./ADR/007-audit-log-append-only.md) covers state-changing mutations only; reads/pulls go here. The token IS the caller (look up `api_tokens.label` for a human name).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"api_request_log">` | |
| `token_id` | `Id<"api_tokens">?` | Null when auth failed before a token resolved |
| `endpoint` | `string` | `"/api/v1/transactions"` \| `"/api/v1/refunds"` |
| `http_status` | `number` | `200`/`400`/`401`/`429`/`500` |
| `error_code` | `string?` | Contract §4 error code, when non-200 |
| `returned_count` | `number?` | Rows in the response page (200 only) |
| `cursor_in` | `string?` | Request cursor (opaque), if any |
| `cursor_out` | `string?` | `nextCursor` returned, if any |
| `at` | `number` | Server `Date.now()` |

Indexes: `by_token_at` on `[token_id, at]`, `by_at` on `at`.

### `pos_shift_events` *(v1.2 #6 — owned by `shifts/`)*

Single source of truth for booth shift state. One row per shift lifecycle event. State is derived by reading the latest event for a given `device_id`; there is no separate "current state" row.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_shift_events">` | |
| `device_id` | `string` | Registered device identifier — matches `registered_devices.device_id` |
| `type` | `"start_of_day" \| "lock" \| "resume" \| "signoff_close" \| "handover_out" \| "handover_in" \| "manager_takeover"` | Shift lifecycle event type |
| `staff_id` | `Id<"staff">` | Staff member who triggered the event |
| `shift_started_at` | `number` | UTC ms when this staff member's active shift segment began |
| `shift_ended_at` | `number \| null` | UTC ms when this shift segment ended; null while open |
| `steps` | `Array<{ key: string, label: string, type: "instruction" \| "count", confirmed_at: number }>` | SOP checklist steps completed during the event |
| `count_changed` | `number \| null` | Number of stock counts that differed from expected (for `start_of_day`/`signoff_close`; null for other types) |
| `takeover` | `boolean \| null` | Set `true` **only** on a `manager_takeover` event (a manager unlocked a LOCKED booth and displaced the prior staff); null for every other event type, including normal handovers |
| `outgoing_uncounted` | `boolean \| null` | True when the outgoing staff did not complete their count SOP; null for non-handover types |
| `stale_autoclose` | `boolean \| null` | Persisted `true` on the `signoff_close` event that `completeStartOfDay` auto-writes when it finds a non-closed shift left over from a **prior WIB day** (forgot-to-close). That auto-close still fires the displaced shift's Founders summary (spec §2). Null on all normally-recorded events. |
| `linked_event_id` | `Id<"pos_shift_events"> \| null` | Pairs `handover_out` ↔ `handover_in` events; null for unpaired event types |
| `summary` | `{ durationMs: number, totalSalesIdr: number, txnCount: number, manualBcaCount: number, manualBcaTotalIdr: number } \| null` | Shift summary snapshot written on `signoff_close` / `handover_out`; null for open-type events |
| `created_at` | `number` | Server UTC ms ([ADR-031](./ADR/031-convex-server-time-wins.md)) |

Indexes:
- `by_device_created` on `[device_id, created_at]` — primary lookup: latest event for a device
- `by_staff_started` on `[staff_id, shift_started_at]` — staff shift history

Audit verbs (written to `audit_log`; source `booth_inline` unless noted):

```
shift.start_of_day      # staff started the booth (first event of the day)
shift.signoff           # staff completed end-of-shift SOP (signoff_close)
shift.handover_out      # outgoing staff completed handover-out SOP
shift.handover_in       # incoming staff completed handover-in SOP (links to handover_out)
shift.manager_takeover  # manager overrode a stale or uncounted shift
shift.lock              # staff locked the booth mid-shift
shift.resume            # staff resumed an interrupted shift
```

## Future migrations (documented for awareness)

**v1.1: Sales feed to kitchen inventory.** Scheduled Convex action runs every 15 min, reads `pos_stock_movements` of `source: "sale"` since the last checkpoint, joins `pos_inventory_skus.sku_family` → `products.sku` (Frollie Pro) → `recipes`, decrements `kitchen_inventory` rows. Idempotent via a `processed_pos_movement_ids` checkpoint table.

**v1.2: PPN activation.** When Frollie crosses PKP threshold, set `pos_settings.is_pkp = true` and flip default `tax_rate` to `0.11` on new products. Existing transactions retain their snapshot rate. Receipt template auto-shows the tax line.

**Future: Multi-stall.** Add `stall_id` to `pos_transactions`, `pos_stock_levels`, `pos_stock_movements`. Add `stalls` table. Add `pos_stock_transfers` for inter-stall moves. Not in v1.

## Data integrity rules enforced in mutations

1. `pos_transaction_lines.unit_price` MUST equal the product's price at the time of insertion. Never recompute.
2. `pos_transactions.total = subtotal - line_discounts_total - voucher_discount + tax_amount` (ADR-024). **v0.3 simplification:** with PPN=0 and no line-level discounts yet, only `subtotal`, `voucher_discount`, and `total` are stored, and the implemented invariant is `total = subtotal - voucher_discount`. The `line_discounts_total` / `tax_amount` columns land when line discounts and PPN activate (see Future migrations).
3. `pos_refunds.amount` ≤ `pos_transactions.total - sum(prior_succeeded_refunds.amount)`.
4. `pos_payments.status` transitions: `pending → paid | expired | failed | cancelled`. No backwards.
5. `pos_transactions.status` transitions:
   - `draft → awaiting_payment | voided`
   - `awaiting_payment → paid | voided`
   - `paid` is terminal (refund-derived statuses computed on read)
6. `audit_log` rows are never updated or deleted.
7. `staff_sessions.started_at` is server-set only.
8. `pos_vouchers.used_count` updates atomically with `pos_voucher_redemptions` inserts (single mutation).
9. `pos_stock_movements` reconciliation double-decrements are prevented by the `by_line_and_sku` index on `(source_transaction_line_id, inventory_sku_id)` — `_recordSaleMovement_internal` checks it before inserting a `sale` movement (ADR-026). *(v0.3 shipped this index-guard rather than the originally-planned `(ref_type, ref_id, inventory_sku_id)` unique constraint.)*
10. `pos_approval_tokens.consumed_at` MUST be set before any state mutation triggered by the approval — gates token re-use.
11. `pos_idempotency` keyed mutation responses MUST be byte-identical on replay (return stored `response_blob` verbatim).
