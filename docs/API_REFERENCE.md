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
| q | `staff.public.listActiveManagers` | `{ sessionId }` | `{ name, code }[]` | *(v0.5.0)* Session-gated (any role). Returns all active managers. Used by the booth manager-picker on the charge screen for manager-PIN override flows. Does not expose pin_hash. |
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
| m | `transactions.public.cancelAwaitingPayment` | `{ sessionId, txnId, idempotencyKey }` | `{ cancelled: true }` | *(v0.5.0)* Cancels an `awaiting_payment` transaction. Calls `_cancelPendingManualPaymentForTxn_internal` to mark any outstanding `manual_payment_override` approval as denied (system). Also cancels the active Xendit invoice locally. Logs `transaction.cancelled`. The charge screen calls this when the staff taps "Cancel payment". Staff session required (no manager gate). |
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

## `approvals.ts` *(v0.3 + v0.4 + v0.5.0 — Telegram approval surface)*

> **v0.4 generalization:** `pos_approval_requests` now supports multiple kinds (`staff_pin_reset`, `manual_payment_override`). The `kind` field in all return types is a discriminant. `getByToken` returns a discriminated union.
>
> **v0.5.0 additions:** per-token PIN attempt cap (`TOKEN_PIN_ATTEMPT_CAP = 5`); `cancelPendingRequest` manager mutation for stuck-approval cleanup; `failed_pin_attempts` field on `pos_approval_requests`.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `approvals.public.getByToken` | `{ rawToken: string }` | `StaffPinResetResult \| ManualPaymentOverrideResult \| null` | PUBLIC. Powers `/approve/:token` landing page. Discriminated by `kind`. Computes effective status (`pending \| resolved \| denied \| expired`) without mutating the DB. Token authorises VIEW only (ADR-029). |
| q | `approvals.public.getRequestStatus` | `{ requestId: Id<"pos_approval_requests"> }` | `{ status: "pending" \| "resolved" \| "denied" \| "expired" } \| null` | Reactive. Used by `useApproval` hook. Returns effective status by ID (no token required — caller already has the ID from `requestManualPaymentApproval`). |
| m | `approvals.public.cancelPendingRequest` | `{ sessionId, requestId, reason?, idempotencyKey }` | `{ ok: true }` | Manager-only *(v0.5.0)*. Transitions a `pending` request to `denied` with `denied_by_manager_id: "system"`. Used to clean up stuck approvals (e.g. after the charge screen is abandoned). Throws `APPROVAL_NOT_PENDING` if the request is not in `pending` state. |
| a | `approvals.actions.requestManualPaymentApproval` | `{ sessionId, txnId, reason, idempotencyKey }` | `{ requestId }` | Action (Node). Creates `manual_payment_override` approval request + sends Telegram card to `managers` role. Dedups on one live pending request per txnId. Requires txn in `awaiting_payment` state. Deletes request row on Telegram send failure (recovery pattern). |
| a | `approvals.actions.approveManualPayment` | `{ token, managerStaffCode, managerPin, idempotencyKey }` | `{ resolved: true }` | Action (Node). Validates token (constant-time compare) + argon2 manager PIN. Increments `failed_pin_attempts` on wrong PIN; auto-denies when cap (5) is reached. Runs `_onPaidManual_internal` (confirms payment) then `_markResolved_internal`. Source: `telegram_approval`. Locked-out managers can still approve. `managerStaffCode` *(v0.5.0)*: stable `S-NNNN` code used to identify the manager without a session. |
| a | `approvals.actions.denyRequest` | `{ token, managerStaffCode, managerPin, denyReason, idempotencyKey }` | `{ denied: true }` | Action (Node). Kind-agnostic deny — works for any pending request. Validates token + argon2 manager PIN. Commits `_markDenied_internal`. The denied transaction (if any) stays in its pre-denial state. |
| a | `approvals.actions.approveStaffPinReset` | `{ token, managerStaffCode, managerPin, newPin, idempotencyKey }` | `{ resolved: true }` | Action (Node). Off-booth PIN reset via Telegram link. Validates token + argon2 manager PIN + hashes new PIN. Commits via `_changePinCommit_internal` (source: `telegram_approval`). |
| a | `approvals.actions.notifyStaffLockout` | `{ staffId }` | `{}` | InternalAction. Fires on 3-strike lockout (scheduled by `_recordFailedAttempt_internal`). Mints token, creates `staff_pin_reset` request, sends Telegram card. Deduped — skips if a live pending request already exists. |

## `telegram.chatRegistry` *(v0.4 — manager admin surface; v0.5.0 split into public/internal)*

The `mgr*` functions are the **public** manager-session-gated surface. They live at `api.telegram.chatRegistry.public.mgr*` — NOT at `api.telegram.mgrAdmin.*`. The `chatRegistry.ts` monolith was split in v0.5.0 into `chatRegistry/public.ts` (public mutations below) and `chatRegistry/internal.ts` (`getChatIdByRole`, `seedChatFromEnv`, table management helpers).

> **v0.5.0 note:** callers referencing `api.telegram.chatRegistry.mgrListChats` (v0.4 path) must be updated to `api.telegram.chatRegistry.public.mgrListChats`.

> **v0.5.0 note:** `sendTemplate` accepts an optional `chatIdOverride` arg for directing a message to a specific chat ID rather than routing by role. Useful for test messages and direct-to-chat dispatch.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `mgrListChats` | `{ sessionId, includeArchived?: boolean }` | `Doc<"telegramChats">[]` | Manager-only query (at `api.telegram.chatRegistry.public.mgrListChats`). Lists all registered Telegram chats. `includeArchived` defaults to `false`. Archived filtering done in JS post-fetch (not an index filter — see Convex optional-field gotcha). |
| m | `mgrAssignRole` | `{ idempotencyKey, sessionId, chatId, role?: string \| null, forceReassign?, restoreIfArchived? }` | `{ ok: true }` | Manager-only. Assigns a role (`"managers"` or `"founders"`) to a registered chat. Pass `role: null` to clear. `forceReassign: true` moves the role from a prior holder. `restoreIfArchived: true` un-archives the chat during assignment. |
| m | `mgrArchiveChat` | `{ idempotencyKey, sessionId, chatId }` | `{ ok: true }` | Manager-only. Archives the chat (removes from active role routing, clears its role). Archived rows remain visible with `includeArchived: true`. |
| m | `mgrRestoreChat` | `{ idempotencyKey, sessionId, chatId }` | `{ ok: true }` | Manager-only. Restores an archived chat (does not re-assign a role; use `mgrAssignRole` next). |
| a | `mgrSendTest` | `{ sessionId, chatId }` | `void` | Action (Node). Manager-only. Sends a test message to the specified chat. Writes `lastError` on failure, clears it on success. Auth gated via `_requireManagerSession_internal` (actions cannot call `ctx.db` directly). |

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

## `settings.ts` *(v0.4)*

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `settings.public.getSettings` | `{}` | `{ founders_summary_enabled: boolean }` | Public-readable. Returns `true` if the `pos_settings` row is absent (default-on). |
| m | `settings.public.setFoundersSummaryEnabled` | `{ sessionId, enabled }` | `{ ok: true }` | Manager-only. Upserts the `pos_settings` singleton. Logs `settings.founders_summary_toggled`. |

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

## `receipts.ts` *(v0.5.1 PR A)*

### HTTP

#### `GET /r/:token`
Returns the HTML receipt page for the txn with matching `receipt_token`. 200 + cached HTML on hit, 200 + freshly rendered + cached on miss, 404 + Indonesian "Struk tidak ditemukan" page on unknown token or non-paid txn status.

Routed via `pathPrefix: "/r/"` in `convex/http.ts`; handler is `handleReceiptRoute` (`convex/receipts/http.ts`).

### Internal (not callable from public clients)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| internal q | `_buildViewModel_internal` | `{ transactionId }` | `ReceiptViewModel \| null` | Builds the view model by routing through `transactions/internal._getPaidTxnWithLinesForReceipt_internal` + `payments/internal._getPaidInvoiceForTxn_internal` (ADR-034). Returns null if txn missing or not paid; throws `PAID_TXN_MISSING_PAID_AT` on data-corruption case. PR A returns `refunds: []`; PR B populates from `refunds/internal._listForTransaction_internal`. |
| internal q | `_renderReceiptByToken_internal` | `{ token }` | `{ html } \| null` | Routes through `transactions/internal._getPaidTxnWithLinesByToken_internal` (single txn+lines aggregate read) + payments invoice helper, then renders inline. |
| internal q | `_getCachedReceipt_internal` | `{ token }` | `{ html } \| null` | Returns cached HTML row if present and not expired, else null. (`expires_at` filter applied internally; not part of the response shape.) |
| internal m | `_writeCacheEntry_internal` | `{ token, html }` | `void` | Idempotent upsert; sets `expires_at = now + 24h`. |
| internal m | `_purgeReceiptCache_internal` | `{ transactionId }` | `void` | PR A: throws `"PR A stub — PR B replaces"`. No callers in PR A. PR B replaces with real cache delete by txn lookup. The throw catches premature wire-up in CI rather than leaving stale "LUNAS" receipts cached for 24h post-refund. |
| internal m | `_lazyMintReceiptToken_internal` | `{ transactionId, actor }` | `{ token }` | Dormant in v0.5.1. Mints a token for tokenless paid txns (pre-v0.5.1 rows). Idempotent (returns existing token if set, no audit row on idempotent path). Throws `TXN_NOT_FOUND` / `TXN_NOT_PAID`. Routes the patch through `transactions/internal._ensureReceiptTokenForPaidTxn_internal` (ADR-034). Audit-logs `receipt.token_minted` (source: `booth_inline`, metadata: `{ lazy: true }`) on fresh mint only. |

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
