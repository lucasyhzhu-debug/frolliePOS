# SCHEMA.md

**POS-internal schema.** Table shapes, field names, and `Id<>` types are internal implementation detail per [ADR-034](./ADR/034-deep-modules-surface-apis.md). They can evolve freely; external integration with Frollie Pro or future consumers happens via the contract in [`PUBLIC_API.md`](./PUBLIC_API.md), not by mirroring this schema.

This doc is the developer-facing reference for the POS Convex schema. Field naming uses `snake_case` per POS convention. For external API field naming (`camelCase`) and stable string identifiers, see `PUBLIC_API.md`.

## Module ownership (per ADR-034)

| Module | Tables owned |
|---|---|
| `auth/` | `staff`, `staff_sessions`, `pos_auth_attempts`, `registered_devices`, `pending_device_setups` |
| `catalog/` | `pos_products`, `pos_inventory_skus`, `pos_product_components` |
| `inventory/` *(v0.3)* | `pos_stock_movements`, `pos_stock_levels` (moved from `catalog/` in v0.3 per ADR-034) |
| `transactions/` *(v0.3)* | `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters` |
| `payments/` *(v0.3)* | `pos_xendit_invoices` |
| `vouchers/` *(v0.3)* | `pos_vouchers`, `pos_voucher_redemptions` |
| `approvals/` *(v0.3, extended v0.4)* | `pos_approval_requests` |
| `idempotency/` | `pos_idempotency` |
| `audit/` | `audit_log` |
| `telegram/` *(v0.4)* | `telegram_log` (debug-trail only), `telegramChats`, `telegramUpdates` |
| `settings/` *(v0.4)* | `pos_settings` |

> **Doc note (v0.3):** several table sections below were written ahead of time against the broader **v0.5 design** and are marked *(new in v0.5)* / *(rewritten in v0.5)*. The v0.3 milestone shipped a leaner subset of those tables. Where the section header carries a **"v0.3 shipped"** field table, that table is ground truth for what currently exists in code (`convex/<module>/schema.ts`); the surrounding v0.5 prose describes the planned expansion, not today's schema. The shipped-vs-planned divergences are also called out in `CHANGELOG.md` under the v0.3 entry.

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
| `receipt_number` | `string?` | `R-YYYY-NNNN`; allocated **only at `_confirmPaid`** ([ADR-023](./ADR/023-receipt-number-format.md)) |
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
| `confirmed_via` | `"webhook" \| "polling" \| "manual" \| null` | Confirmation provenance ([strategic foundations §8](./ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)) |
| `confirmed_mgr_approver_id` | `Id<"staff">?` | Manager who approved a `manual` confirm |
| `confirmed_manual_reason` | `string?` | Required for `manual` confirm |

Indexes:
- `by_status_created` on `[status, created_at]` (ADR-026 reconciliation)
- `by_receipt_number` on `receipt_number`
- `by_staff_created` on `[staff_id, created_at]`

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

### `pos_stock_movements` — v0.3 shipped *(owned by `inventory/`)*
Every stock change. Append-only in spirit ([ADR-020](./ADR/020-stock-movement-source-enum.md)). The v0.3 shape ships the `sale` source path only; `stock_in`, `spoilage`, and `adjustment` are reserved enum members wired up in v0.5/v0.6. Sale movements reference their originating transaction line; the `by_line_and_sku` index gives the ADR-026 reconciliation-dedup guard (no second decrement for the same line+SKU).

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_stock_movements">` | |
| `inventory_sku_id` | `Id<"pos_inventory_skus">` | |
| `qty` | `number` | Signed; **negative for sale** |
| `source` | `"sale" \| "stock_in" \| "spoilage" \| "adjustment"` | Only `sale` is written in v0.3 |
| `source_transaction_line_id` | `Id<"pos_transaction_lines">?` | Set for `sale` movements; the ADR-026 dedup key |
| `created_at` | `number` | |
| `recorded_by_staff_id` | `Id<"staff">?` | Staff who triggered the movement |

Indexes:
- `by_sku_created` on `[inventory_sku_id, created_at]`
- `by_line_and_sku` on `[source_transaction_line_id, inventory_sku_id]` (ADR-026 reconciliation dedup)

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
| `kind` | `"staff_pin_reset" \| "manual_payment_override"` | `manual_payment_override` added in v0.4 |
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
| `template_kind` | `string?` | Template used for outbound messages |
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

Indexes: `by_chatId` on `chatId`, `by_role_archived` on `[role, archivedAt]`.

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
| `updated_at` | `number` | |
| `updated_by` | `Id<"staff">?` | Optional — row may be updated by a system action |

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

### `pos_receipt_counters` — v0.3 shipped *(owned by `transactions/`)*
Atomic counter for `R-YYYY-NNNN` allocation ([ADR-023](./ADR/023-receipt-number-format.md)). The `next_number` is allocated atomically inside `_confirmPaid`.

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"pos_receipt_counters">` | |
| `year` | `number` | **WIB calendar year** (UTC+7, no DST) — not the UTC year. The new WIB year takes effect at 17:00 UTC on Dec 31; booth + accounting + customers all expect the WIB calendar |
| `next_number` | `number` | Monotonic; next NNNN to allocate |

Indexes: `by_year` on `year`.

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
