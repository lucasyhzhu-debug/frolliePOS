# SCHEMA.md

POS-specific tables and their relationship to the Frollie Pro schema. Read alongside `product_master/docs/SCHEMA.md`.

This schema reflects the v0.5 wireframe handoff registry — most notably the **Product ↔ Inventory separation** ([ADR-016](./ADR/016-product-inventory-separation.md)) and the new **approvals / idempotency / drafts** tables.

## Conventions

- Table names use `snake_case`.
- POS-specific tables prefixed `pos_` except the cross-cutting `staff`, `staff_sessions`, `registered_devices`, and `audit_log` (POS-owned today, available to Frollie Pro modules in the future).
- All tables have a Convex `_id` and `_creationTime`. Additional `created_at` / `updated_at` fields are added when business semantics differ from Convex internals (e.g. recording the time an action happened, not when the row was first inserted).
- Money stored as **integer rupiah** ([ADR-015](./ADR/015-idr-integer-rupiah.md)). Display formatting in `src/lib/format.ts`.
- Foreign keys named `<table>_id` and typed as `Id<"table_name">`.
- Enums use string literal unions in TypeScript, validated in Convex schema with `v.union(v.literal(...), ...)`.
- Timestamps are UTC ms (`Date.now()` server-side per [ADR-031](./ADR/031-convex-server-time-wins.md)). Display layer handles timezone.

## Tables read from Frollie Pro (existing, do not redefine)

### `products` (Frollie Pro)
POS does **not** use this directly any more — the POS-specific Product/Inventory split ([ADR-016](./ADR/016-product-inventory-separation.md)) lives in `pos_products` + `pos_inventory_skus`. The legacy `products` table remains in Frollie Pro for B2B/wholesale flows; future v1.1 may join from `pos_inventory_skus.sku_family` if Frollie Pro's catalog gains a stronger SKU model.

### `recipes`
Not used by POS in v1. Used in v1.1 for kitchen inventory decrement when the POS sales feed graduates.

## New tables added by POS

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

Indexes: `by_staff_active` on `[staff_id, ended_at]`, `by_device_active` on `[device_id, ended_at]`.

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

### `registered_devices`
Devices authorised to run the POS. Activated via one-time setup code from a manager ([strategic foundations §6](./ADR/000-strategic-foundations.md#6-device-registration-before-login-security-control)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"registered_devices">` | |
| `device_id` | `string` | UUIDv4 generated client-side, persisted in IndexedDB + localStorage |
| `label` | `string` | "Booth Phone 1", "Manager Tablet", etc. |
| `activated_by` | `Id<"staff">` | Manager who issued the setup code |
| `activated_at` | `number` | |
| `last_seen_at` | `number?` | |
| `active` | `boolean` | |

Indexes: `by_device_id` on `device_id` (unique).

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

### `pos_stock_levels`
Denormalised current stock for fast catalog rendering. Reconciled nightly from `pos_stock_movements`.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_stock_levels">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `on_hand` | `number` | Can go negative ([ADR-018](./ADR/018-negative-stock-allowed-flagged.md)) |
| `last_movement_id` | `Id<"pos_stock_movements">?` | For reconciliation audit |
| `updated_at` | `number` | |

Indexes: `by_sku` on `inventory_sku_id` (unique).

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

### `pos_transactions`
Core sale record.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_transactions">` | |
| `staff_id` | `Id<"staff">` | Creator |
| `device_id` | `string` | |
| `status` | `"draft" \| "awaiting_payment" \| "paid" \| "voided"` | Refund-derived statuses (`partial_refund`, `refunded`) are computed on read from `pos_refunds` per [ADR-008](./ADR/008-refunds-as-new-rows.md) |
| `subtotal` | `number` | Sum of line subtotals (pre-discount, pre-tax) |
| `line_discounts_total` | `number` | Sum of line-level discounts |
| `voucher_discount` | `number` | Cart-level voucher amount ([ADR-024](./ADR/024-discount-ordering-line-voucher-tax.md)) |
| `discount_source` | `"voucher_code" \| "manual_pct" \| "manual_amount" \| null` | At most one ([ADR-010](./ADR/010-no-voucher-stacking.md)) |
| `tax_amount` | `number` | Computed per line, summed |
| `total` | `number` | `subtotal - line_discounts_total - voucher_discount + tax_amount` |
| `flags` | `number` | Bitset; `NEG_STOCK = 1 << 0` ([ADR-018](./ADR/018-negative-stock-allowed-flagged.md)) |
| `payment_method` | `"qris" \| "bca_va" \| null` | |
| `xendit_invoice_id` | `string?` | Current invoice ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)) |
| `receipt_number` | `string?` | `R-YYYY-NNNN` allocated on transition to paid ([ADR-023](./ADR/023-receipt-number-format.md)) |
| `receipt_token` | `string?` | 32-byte URL-safe random ([ADR-021](./ADR/021-receipt-url-convex-http-action.md)) |
| `customer_phone` | `string?` | Optional, captured for WhatsApp receipt |
| `customer_name` | `string?` | Optional |
| `notes` | `string?` | Staff free-text |
| `voided_by` | `Id<"staff">?` | |
| `voided_at` | `number?` | |
| `created_at` | `number` | |
| `paid_at` | `number?` | |

Indexes:
- `by_status_date` on `[status, created_at]`
- `by_staff_date` on `[staff_id, created_at]`
- `by_receipt_number` on `receipt_number`
- `by_receipt_token` on `receipt_token`
- `by_xendit_invoice` on `xendit_invoice_id`

### `pos_transaction_lines` *(renamed from `pos_transaction_items` in v0.5)*
Line items. **Prices snapshotted at sale time** (never recomputed).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_transaction_lines">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `product_id` | `Id<"pos_products">` | Reference for reporting; do NOT join for price |
| `product_name_snapshot` | `string` | Product name at sale time |
| `product_pack_snapshot` | `string` | Pack label at sale time |
| `qty` | `number` | Integer pack units (e.g. 2 boxes of "Dubai 3pcs") |
| `unit_price` | `number` | Snapshot, integer rupiah |
| `line_subtotal` | `number` | `qty * unit_price` |
| `line_discount` | `number` | Per-line discount amount |
| `tax_rate` | `number` | Decimal, 0 today |
| `tax_amount` | `number` | Computed |
| `line_total` | `number` | `line_subtotal - line_discount + tax_amount` |
| `refunded_qty` | `number` | Denormalised, incremented by refund mutations ([ADR-008](./ADR/008-refunds-as-new-rows.md)) |

Indexes: `by_transaction` on `transaction_id`, `by_product_date` on `[product_id, _creationTime]` for reporting.

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

### `pos_xendit_invoices` *(new in v0.5 — audit)*
History of all Xendit invoices created for a transaction, including cancelled ones ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_xendit_invoices">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `xendit_invoice_id` | `string` | |
| `created_at` | `number` | |
| `cancelled_at` | `number?` | |
| `replaced_by` | `string?` | Subsequent Xendit invoice id |
| `status_at_cancel` | `string?` | Xendit-reported status at cancellation time |

Indexes: `by_transaction` on `transaction_id`, `by_xendit_invoice` on `xendit_invoice_id`.

### `pos_refunds`
Refund operations ([ADR-008](./ADR/008-refunds-as-new-rows.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_refunds">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `payment_id` | `Id<"pos_payments">` | The successful payment being refunded |
| `refunded_by` | `Id<"staff">` | Staff who initiated |
| `approved_by` | `Id<"staff">` | Manager who approved (PIN re-entered or via WA) |
| `approval_request_id` | `Id<"pos_approval_requests">?` | Set when approval came via WA flow |
| `amount` | `number` | |
| `reason_code` | `"customer_changed_mind" \| "wrong_item" \| "damaged" \| "out_of_stock" \| "duplicate_charge" \| "other"` | |
| `reason_notes` | `string?` | Required when `reason_code = "other"` |
| `is_partial` | `boolean` | True if not refunding the full transaction |
| `xendit_refund_id` | `string?` | Set after API call |
| `status` | `"pending" \| "succeeded" \| "failed"` | |
| `created_at` | `number` | |
| `completed_at` | `number?` | When Xendit confirmed |
| `failure_reason` | `string?` | |

Indexes: `by_transaction` on `transaction_id`, `by_status` on `status`.

### `pos_refund_lines`
Line-level refund detail for partial refunds. Empty for full refunds.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_refund_lines">` | |
| `refund_id` | `Id<"pos_refunds">` | |
| `transaction_line_id` | `Id<"pos_transaction_lines">` | |
| `qty_refunded` | `number` | Cannot exceed `pos_transaction_lines.qty - pos_transaction_lines.refunded_qty` |
| `amount` | `number` | Per-line refund amount |

Indexes: `by_refund` on `refund_id`.

### `pos_stock_movements`
Every stock change. Append-only in spirit ([ADR-020](./ADR/020-stock-movement-source-enum.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_stock_movements">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `qty` | `number` | Signed (negative for sale/spoilage, positive for stock-in/refund) |
| `source` | `"sale" \| "stock_in_kitchen" \| "stock_in_adjustment" \| "stock_in_return" \| "refund" \| "spoilage"` | |
| `ref_id` | `string?` | `transaction_line_id` for sales, `refund_line_id` for refunds |
| `ref_type` | `"transaction_line" \| "refund_line" \| null` | |
| `staff_id` | `Id<"staff">` | |
| `approved_by` | `Id<"staff">?` | Required for `adjustment` and `spoilage` |
| `notes` | `string?` | Required for `adjustment` and `spoilage` |
| `created_at` | `number` | |

Indexes:
- `by_sku_date` on `[inventory_sku_id, created_at]`
- `by_source_date` on `[source, created_at]`
- **Unique constraint** on `[ref_type, ref_id, inventory_sku_id]` where `ref_id` is non-null ([ADR-026](./ADR/026-reconciliation-on-reload.md))

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

### `pos_vouchers`
Voucher codes. Static, manager-managed.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_vouchers">` | |
| `code` | `string` | Uppercase, unique |
| `discount_id` | `Id<"pos_discounts">` | |
| `expires_at` | `number?` | Null = no expiry |
| `max_redemptions` | `number?` | Null = unlimited |
| `used_count` | `number` | Incremented atomically with redemption insert |
| `min_cart_value` | `number?` | Subtotal-after-line-discount threshold |
| `active` | `boolean` | |
| `created_by` | `Id<"staff">` | |
| `created_at` | `number` | |

Indexes: `by_code` on `code` (unique), `by_active` on `active`.

### `pos_voucher_redemptions`
Append-only. One row per redemption.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_voucher_redemptions">` | |
| `voucher_id` | `Id<"pos_vouchers">` | |
| `transaction_id` | `Id<"pos_transactions">` | |
| `redeemed_by` | `Id<"staff">` | |
| `discount_amount` | `number` | Snapshot of discount applied |
| `redeemed_at` | `number` | |

Indexes: `by_voucher` on `voucher_id`, `by_transaction` on `transaction_id`.

### `pos_approval_requests` *(new in v0.5 — WA approval)*
Each row = one manager-PIN gate request ([ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md), [ADR-030](./ADR/030-approval-audit-captures-full-context.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_approval_requests">` | |
| `kind` | `"refund" \| "manual_confirm" \| "negative_stock" \| "void" \| "stock_adjustment" \| "spoilage"` | |
| `requester_staff_id` | `Id<"staff">` | |
| `entity_id` | `string` | Stringified id of the target entity (txn id, payment id, etc.) |
| `payload` | `string` | JSON: human-readable summary shown on the WA landing page |
| `reason_provided` | `string?` | Staff-typed reason |
| `status` | `"pending" \| "approved" \| "denied" \| "expired" \| "cancelled"` | |
| `decided_by_mgr_id` | `Id<"staff">?` | |
| `decided_at` | `number?` | |
| `audit_log_id` | `Id<"audit_log">?` | Linked on approve/deny |
| `created_at` | `number` | |

Indexes: `by_status` on `status`, `by_requester_date` on `[requester_staff_id, created_at]`.

### `pos_approval_tokens` *(new in v0.5)*
Capability URLs for WA approval landings ([ADR-028](./ADR/028-approval-token-single-use-60min.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_approval_tokens">` | |
| `token` | `string` | 32-byte URL-safe random; unique |
| `request_id` | `Id<"pos_approval_requests">` | |
| `expires_at` | `number` | `created_at + 60min` |
| `consumed_at` | `number?` | Single-use |
| `consumed_by_mgr_id` | `Id<"staff">?` | |

Indexes: `by_token` on `token` (unique), `by_request` on `request_id`, `by_expires` on `expires_at`.

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

### `pos_settings` *(new in v0.5 — singleton)*
Business config that appears on receipts and elsewhere.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_settings">` | One row only |
| `business_name` | `string` | "Frollie Indonesia" |
| `booth_name` | `string` | "Frollie · Kota Kasablanka L1" |
| `address` | `string` | |
| `phone` | `string` | |
| `email` | `string` | |
| `npwp` | `string?` | Tax id; null until PKP |
| `is_pkp` | `boolean` | Triggers PPN default-flip ([strategic foundations §4](./ADR/000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp)) |
| `header_copy` | `string` | Top of receipt |
| `footer_copy` | `string` | Bottom of receipt |
| `ig_qr_enabled` | `boolean` | Show IG-handle QR on receipt |
| `receipt_token_salt` | `string` | Server-only |
| `updated_at` | `number` | |
| `updated_by` | `Id<"staff">` | |

### `pos_settlements`
Daily settlement records from Xendit ([strategic foundations §7](./ADR/000-strategic-foundations.md#7-settlement-as-a-second-stage-record), [ADR-012](./ADR/012-settlements-visible-to-staff-and-managers.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_settlements">` | |
| `xendit_settlement_id` | `string` | |
| `settlement_date` | `string` | ISO date |
| `gross_amount` | `number` | |
| `mdr_amount` | `number` | Xendit's fee |
| `net_amount` | `number` | What hits BCA |
| `transaction_count` | `number` | |
| `bca_account_destination` | `string` | Last 4 digits for verification |
| `payload` | `string` | Raw Xendit payload JSON |
| `synced_to_frollie_pro_at` | `number?` | Future v1.1 hook |
| `created_at` | `number` | |

Indexes: `by_settlement_date` on `settlement_date`, `by_xendit_id` on `xendit_settlement_id`.

### `pos_receipt_counters` *(new in v0.5)*
Atomic counter for `R-YYYY-NNNN` allocation ([ADR-023](./ADR/023-receipt-number-format.md)).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_receipt_counters">` | |
| `year` | `number` | Unique |
| `next` | `number` | Next NNNN to allocate |

Indexes: `by_year` on `year` (unique).

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
| `source` | `"booth_inline" \| "wa_approval" \| "system" \| "reaper"` | Routing path for the action ([ADR-030](./ADR/030-approval-audit-captures-full-context.md)) |
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
device.activated
device.deactivated
device.setup_code_issued
seed.reset
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
```

## Relationship to Frollie Pro tables

| Frollie Pro table | POS read | POS write | Notes |
|---|---|---|---|
| `products` | future (v1.1) | no | Frollie Pro retains for B2B/wholesale; POS uses `pos_products` |
| `recipes` | future (v1.1) | no | For kitchen decrement on sales feed |
| `kitchen_inventory` | no | future (v1.1) | Decremented via recipe lookup from POS sales |
| `packaging` | no | no | Out of scope |
| `orders` | no | no | Frollie Pro's order entity is B2B/wholesale, separate concept |

## Future migrations (documented for awareness)

**v1.1: Sales feed to kitchen inventory.** Scheduled Convex action runs every 15 min, reads `pos_stock_movements` of `source: "sale"` since the last checkpoint, joins `pos_inventory_skus.sku_family` → `products.sku` (Frollie Pro) → `recipes`, decrements `kitchen_inventory` rows. Idempotent via a `processed_pos_movement_ids` checkpoint table.

**v1.2: PPN activation.** When Frollie crosses PKP threshold, set `pos_settings.is_pkp = true` and flip default `tax_rate` to `0.11` on new products. Existing transactions retain their snapshot rate. Receipt template auto-shows the tax line.

**Future: Multi-stall.** Add `stall_id` to `pos_transactions`, `pos_stock_levels`, `pos_stock_movements`. Add `stalls` table. Add `pos_stock_transfers` for inter-stall moves. Not in v1.

## Data integrity rules enforced in mutations

1. `pos_transaction_lines.unit_price` MUST equal the product's price at the time of insertion. Never recompute.
2. `pos_transactions.total = subtotal - line_discounts_total - voucher_discount + tax_amount`. Validated on every write.
3. `pos_refunds.amount` ≤ `pos_transactions.total - sum(prior_succeeded_refunds.amount)`.
4. `pos_payments.status` transitions: `pending → paid | expired | failed | cancelled`. No backwards.
5. `pos_transactions.status` transitions:
   - `draft → awaiting_payment | voided`
   - `awaiting_payment → paid | voided`
   - `paid` is terminal (refund-derived statuses computed on read)
6. `audit_log` rows are never updated or deleted.
7. `staff_sessions.started_at` is server-set only.
8. `pos_vouchers.used_count` updates atomically with `pos_voucher_redemptions` inserts (single mutation).
9. `pos_stock_movements` unique constraint on `(ref_type, ref_id, inventory_sku_id)` prevents reconciliation double-decrements.
10. `pos_approval_tokens.consumed_at` MUST be set before any state mutation triggered by the approval — gates token re-use.
11. `pos_idempotency` keyed mutation responses MUST be byte-identical on replay (return stored `response_blob` verbatim).
