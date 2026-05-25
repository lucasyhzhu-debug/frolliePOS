# API Reference

Convex function inventory for Frollie POS. Updated as functions are implemented. This file describes the **planned v0.5 surface**; route stubs and scaffolding exist but most functions are not yet built.

## Conventions

- **Queries** (`q`) are reactive, read-only.
- **Mutations** (`m`) are transactional writes. **Every public mutation accepts `idempotencyKey: string`** ([ADR-013](./ADR/013-idempotency-keys.md)) — wrapped by the harness in `convex/idempotency.ts`.
- **Actions** (`a`) are non-transactional, used for external API calls (Xendit), argon2id hashing, scheduled jobs.
- **HTTP Actions** (`h`) are public endpoints (Xendit webhook, receipt page, approval landing data).
- `_internal` suffix denotes a function not callable from the client (internal call only).

## `auth.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `getActiveStaff` | `{ deviceId }` | `Staff[]` | For the staff-list login screen |
| q | `getSession` | `{ sessionId }` | `Session \| null` | Validates session is active |
| a | `verifyPinAction_internal` | `{ staffId, pin }` | `{ ok: true } \| { ok: false, lockedUntil?: number }` | argon2id verify + lockout counter ([ADR-002](./ADR/002-lockout-policy.md), [ADR-004](./ADR/004-pin-hashing-server-side.md)) |
| m | `loginWithPin` | `{ staffId, pin, deviceId, idempotencyKey }` | `{ sessionId, role }` | Calls verify action internally; writes `staff_sessions` row; logs `staff.login` or `staff.failed_pin`/`staff.locked_out` |
| m | `logout` | `{ sessionId, idempotencyKey }` | `void` | Sets `ended_at`, `end_reason: "manual_lock"`; logs `staff.logout` |

## `staff.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `listStaff` | `{ sessionId }` | `Staff[]` | Manager-only |
| m | `createStaff` | `{ name, role, pin, idempotencyKey }` | `Staff` | Manager-only; hashes PIN via internal action; logs |
| m | `updateStaff` | `{ id, patch, idempotencyKey }` | `Staff` | Manager-only; PIN reset uses `resetPin` separately |
| m | `resetPin` | `{ id, newPin, idempotencyKey }` | `void` | Manager-only; logs `staff.pin_reset` |
| m | `deactivateStaff` | `{ id, idempotencyKey }` | `void` | Soft delete |
| m | `generateDeviceSetupCode` | `{ idempotencyKey }` | `{ code, expiresAt }` | Manager-only; 6-digit, 1h TTL |
| m | `activateDevice` | `{ code, deviceLabel, idempotencyKey }` | `RegisteredDevice` | Public (pre-auth); consumes setup code |
| q | `listDevices` | `{ sessionId }` | `RegisteredDevice[]` | Manager-only |
| m | `deactivateDevice` | `{ id, idempotencyKey }` | `void` | Manager-only |

## `products.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `catalog` | `{}` | `{ products: Product[], skus: InventorySku[], components: ProductComponent[], stockLevels: StockLevel[], vouchers: Voucher[] }` | Single payload for catalog cache + offline support ([ADR-025](./ADR/025-service-worker-cache.md)). Available client-side for the cart-build flow even when offline |
| m | `upsertSku` | `{ patch, idempotencyKey }` | `InventorySku` | Manager-only ([ADR-016](./ADR/016-product-inventory-separation.md)) |
| m | `upsertProduct` | `{ patch, components, idempotencyKey }` | `Product` | Manager-only; updates `pos_products` + replaces `pos_product_components` for the product atomically |
| m | `deactivateProduct` | `{ id, idempotencyKey }` | `void` | Manager-only |

## `transactions.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `createDraft` | `{ sessionId, idempotencyKey }` | `Transaction` | New empty cart |
| m | `addLine` | `{ txId, productId, qty, idempotencyKey }` | `Transaction` | Snapshots price + name; logs `transaction.line_added` |
| m | `removeLine` | `{ txId, lineId, idempotencyKey }` | `Transaction` | Logs |
| m | `setLineQty` | `{ txId, lineId, qty, idempotencyKey }` | `Transaction` | Logs |
| m | `applyDiscount` | `{ txId, discountId, idempotencyKey }` | `Transaction` | Preset discount only (manager-required discounts route through approvals) |
| m | `applyVoucher` | `{ txId, code, idempotencyKey }` | `Transaction` | Validates voucher; logs `transaction.voucher_redeemed` |
| m | `removeDiscount` | `{ txId, idempotencyKey }` | `Transaction` | Logs |
| m | `setCustomerInfo` | `{ txId, phone?, name?, idempotencyKey }` | `Transaction` | Optional |
| m | `voidTransaction` | `{ txId, reason?, idempotencyKey }` | `void` | Pre-payment: inline. Post-payment: routes via approvals ([ADR-005](./ADR/005-manager-pin-one-off.md)). Logs `transaction.voided` |
| q | `getTransaction` | `{ txId }` | `Transaction & lines[]` | Full record |
| q | `getByNumber` | `{ receiptNumber }` | `Transaction \| null` | For internal lookup; receipt page uses token, not number |

## `drafts.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `save` | `{ txId, idempotencyKey }` | `Draft` | Snapshots cart state + customer info; sets `expires_at = +24h` |
| m | `resume` | `{ draftId, idempotencyKey }` | `{ txId, priceChanges: PriceChange[] }` | Creates a new draft transaction from saved state; re-prices against current catalog; deletes the draft row |
| m | `discard` | `{ draftId, idempotencyKey }` | `void` | Logs `transaction.draft_discarded` |
| q | `list` | `{ sessionId }` | `Draft[]` | All drafts for the current staff + today |
| a | `reaper_scheduled` | `{}` | `{ deleted: number }` | Scheduled daily; deletes expired drafts ([ADR-032](./ADR/032-saved-drafts-purge-24h.md)) |

## `payments.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| a | `initiatePayment` | `{ txId, method, idempotencyKey }` | `{ paymentId, qrString?, vaNumber?, expiresAt }` | Creates Xendit invoice; if a prior invoice exists, cancels it first ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)); logs `payment.initiated` |
| a | `pollPaymentStatus` | `{ paymentId }` | `{ status }` | Server-verified via Xendit API |
| m | `confirmByPolling_internal` | `{ paymentId, idempotencyKey }` | `void` | Internal, called after server verifies via polling; logs `payment.confirmed_polling` |
| m | `confirmByManualOverride` | `{ paymentId, reason, idempotencyKey }` | `void` | Routes through approvals ([ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md)). On approve: flips status + logs `payment.confirmed_manual_override` with approving mgr id |
| q | `getPayment` | `{ paymentId }` | `Payment` | |
| q | `getActivePayment` | `{ txId }` | `Payment \| null` | Latest non-expired/non-cancelled |

## `refunds.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `initiate` | `{ txId, amount, isPartial, lines?, reasonCode, reasonNotes?, idempotencyKey }` | `{ refundId, approvalRequestId }` | Creates `pos_refunds` (`status: pending`) + an approval request ([ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md)) |
| a | `executeAfterApproval_internal` | `{ refundId }` | `void` | Called by approvals.approve when refund is approved; calls Xendit refund API |
| m | `markComplete_internal` | `{ refundId, xenditRefundId }` | `void` | Called from webhook handler; writes positive `pos_stock_movements` ([ADR-019](./ADR/019-refund-re-credits-stock.md)); logs `refund.completed` |
| q | `list` | `{ range?, sessionId }` | `Refund[]` | Manager-only or own-only depending on session |
| q | `get` | `{ refundId, sessionId }` | `Refund & lines[]` | |

## `stock.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `stockIn` | `{ items: [{ skuId, qty }], source, notes?, idempotencyKey }` | `StockMovement[]` | One mutation, N movements. Queues offline. Logs `stock.received` |
| m | `adjust` | `{ skuId, newQty, notes, idempotencyKey }` | `{ approvalRequestId }` | Routes through approvals ([ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md)). On approve: writes `stock_in_adjustment` movement |
| m | `recordSpoilage` | `{ skuId, qty, notes, idempotencyKey }` | `{ approvalRequestId }` | Same approval routing. On approve: writes negative `spoilage` movement |
| q | `getLevels` | `{}` | `StockLevel[]` | All SKUs with current `on_hand` |
| q | `getMovements` | `{ skuId?, range? }` | `StockMovement[]` | |
| a | `reconcileLevels_scheduled` | `{}` | `{ drift: number }` | Nightly. Recomputes `pos_stock_levels.on_hand` from movements; flags drift |

## `vouchers.ts` / `discounts.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `listActiveVouchers` | `{}` | `Voucher[]` | Manager dashboard |
| q | `validateVoucher` | `{ code, cartTotal }` | `{ valid: boolean, voucher?: Voucher, reason?: string }` | Called from `applyVoucher`; server-side re-validation on offline-sync also goes through this |
| m | `createVoucher` | `{ code, discountId, expiresAt?, maxRedemptions?, minCartValue?, idempotencyKey }` | `Voucher` | Manager-only |
| m | `deactivateVoucher` | `{ id, idempotencyKey }` | `void` | Manager-only |
| q | `listDiscounts` | `{}` | `Discount[]` | Active discounts (for cart UI) |
| m | `createDiscount` | `{ name, type, value, requiresManager, idempotencyKey }` | `Discount` | Manager-only |
| m | `editDiscount` | `{ id, patch, idempotencyKey }` | `Discount` | Manager-only |

## `approvals.ts` *(new in v0.5 — central WA approval surface)*

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `create_internal` | `{ kind, requesterStaffId, entityId, payload, reason? }` | `{ requestId, token, waShareUrl }` | Called by the action that needs approval (refund.initiate, payment.confirmByManualOverride, stock.adjust, stock.recordSpoilage, transactions.voidTransaction post-payment). Creates `pos_approval_requests` + `pos_approval_tokens`; returns the pre-filled `wa.me/?text=...` URL for the staff's share sheet |
| q | `getByToken` | `{ token }` | `{ status, request?: ApprovalRequest, expired?: boolean, consumed?: boolean }` | PUBLIC. Powers the `/approve/:token` landing page. No auth |
| m | `approve` | `{ token, mgrPin }` | `{ ok: true, executedAt: number } \| { ok: false, reason: string }` | PUBLIC. Verifies token (unused, unexpired) + verifies PIN belongs to manager-role staff ([ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md)); consumes token; executes the action (per `request.kind`); writes audit row with `source: "wa_approval"`, `mgr_approver_id` ([ADR-030](./ADR/030-approval-audit-captures-full-context.md)) |
| m | `deny` | `{ token, mgrPin, reason? }` | `void` | Same verification path; sets status to `denied`; logs `approval.denied` |
| m | `cancel` | `{ requestId, sessionId, idempotencyKey }` | `void` | Staff can cancel their own pending request from `/wait/:requestId`. Invalidates token |
| q | `listPending` | `{ sessionId }` | `ApprovalRequest[]` | Manager home shows pending approvals |
| a | `expireScheduled` | `{}` | `{ expired: number }` | Scheduled; marks expired requests + tokens |

## `audit.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `list` | `{ filter, range, limit, sessionId }` | `AuditLog[]` | Manager-only; dashboard surface |
| internal helper | `logAudit` | (inside other mutations) | | Required to be called from every state-changing mutation ([ADR-007](./ADR/007-audit-log-append-only.md)) |

## `dashboard.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `today` | `{ sessionId }` | `TodayStats` | Gross, net, count, avg ticket, top SKUs, method split, refund count, manual-override count |
| q | `last7Days` | `{ sessionId }` | `DailyStats[]` | |
| q | `byStaff` | `{ range, sessionId }` | `StaffStats[]` | Sales, refund rate, discount usage, manual-override count |
| q | `stockSummary` | `{}` | `StockSummary` | Current SKU levels, low-threshold flags, product availability rollup |
| q | `negStockFlags` | `{ range, sessionId }` | `Transaction[]` | Transactions with NEG_STOCK flag set, awaiting reconciliation |
| q | `refundsList` | `{ range, sessionId }` | `Refund[]` | |
| q | `vouchersUsage` | `{ range, sessionId }` | `VoucherUsage[]` | |
| a | `exportCsv` | `{ kind: "transactions" \| "refunds" \| "settlements", range }` | `{ csvUrl }` | Returns signed download URL |

## `settlements.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `ingest_internal` | `{ xenditPayload }` | `Settlement` | Called from webhook |
| a | `pollDaily_scheduled` | `{}` | `{ count }` | Scheduled 06:00 Jakarta |
| q | `list` | `{ range }` | `Settlement[]` | Visible to staff + managers ([ADR-012](./ADR/012-settlements-visible-to-staff-and-managers.md)) |

## `settings.ts` *(new in v0.5)*

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `get` | `{}` | `PosSettings` | Public-readable singleton (used by receipt rendering) |
| m | `update` | `{ patch, idempotencyKey }` | `PosSettings` | Manager-only; logs `settings.updated`; on-device edit routes through approvals ([ADR-005](./ADR/005-manager-pin-one-off.md)) |

## `idempotency.ts` *(new in v0.5 — mutation harness)*

Not a public surface — provides the `withIdempotency()` wrapper used by every public mutation. See [ADR-013](./ADR/013-idempotency-keys.md). Exposes:

| Helper | Notes |
|---|---|
| `withIdempotency(handler)` | Wraps a mutation handler; checks `pos_idempotency` for the key; replays stored response or executes + stores |
| `purgeExpired_scheduled` | Scheduled action; deletes `pos_idempotency` rows past `expires_at` |

## HTTP actions

| Type | Path | Method | Notes |
|---|---|---|---|
| h | `/xendit/webhook` | POST | Verifies `x-callback-token` header; routes by event type (`invoice.paid`, `refund.succeeded`, `settlement.completed`); returns 200 fast, processes idempotently |
| h | `/r/:receiptToken` | GET | Public receipt HTML render ([ADR-021](./ADR/021-receipt-url-convex-http-action.md)); reads `pos_transactions` by `receipt_token`; expired HTML cache regenerates and re-caches |

## `convex/xendit/` internal helpers

| Module | Helper | Notes |
|---|---|---|
| `invoice.ts` | `createInvoice({ amount, txId, method, customerInfo? })` | Xendit Invoice API call |
| `invoice.ts` | `cancelInvoice({ invoiceId })` | Cancellation on retry ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)) |
| `polling.ts` | `fetchInvoiceStatus({ invoiceId })` | `GET /v2/invoices/{id}` with secret key |
| `refund.ts` | `executeRefund({ invoiceId, amount, reason })` | Xendit refund API call |
| `webhook.ts` | (HTTP action above) | Webhook routing |

## `seed.ts` (dev only)

| Type | Name | Notes |
|---|---|---|
| m | `reset` | Wipes POS tables; reseeds: 5 staff (PIN `0000`), 1 manager (PIN `9999`), 5 inventory SKUs (dubai/choco/matcha/lotus/brownie), 7 products covering the wireframe catalog. Throws in prod |
