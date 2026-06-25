# API Reference

Convex function inventory for Frollie POS, updated as functions ship. The backend is organized by **domain module** per [ADR-034](./ADR/034-deep-modules-surface-apis.md) — section headers below name the logical surface (e.g. `auth`, `transactions`), but the code lives in `convex/<module>/{public,internal,actions,schema}.ts`, not flat files. Surfaces through **v0.5.3a are shipped** (auth, staff, transactions + reporting, payments, refunds, inventory, vouchers, approvals, telegram, receipts, settings, dashboard); sections marked *planned* are not yet built. When a section and the code disagree, the code wins — flag the drift.

## Conventions

- **Queries** (`q`) are reactive, read-only.
- **Mutations** (`m`) are transactional writes. **Every public mutation accepts `idempotencyKey: string`** ([ADR-013](./ADR/013-idempotency-keys.md)) — wrapped by the harness in `convex/idempotency/`.
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
| a | `auth.actions.createStaff` | `{ idempotencyKey, sessionId, name, role, pin, managerPin }` | `{ _id, name, role }` | *(v0.5.3b)* Manager-PIN gated (now requires `managerPin` arg). Hashes the new staff PIN via argon2id; logs `staff.created`. |

### Helpers

| Helper | Notes |
|---|---|
| `verifyManagerPinOrThrow(ctx, { sessionId, managerPin, idempotencyKey })` | *(v0.5.3b)* Single manager-PIN funnel at `convex/auth/verifyPin.ts`. Resolves the session, requires manager role, argon2-verifies the supplied PIN under that manager's identity, and threads ADR-002 lockout counting onto the manager (not the session staff). Used by every PIN-gated v0.5.3b admin write (`createStaff`, `setStaffRole`, `deactivateStaff`, `createProduct`, `updateProductPricing`). Sibling `verifyPinOrThrow` is the manager-by-staff_code variant used by `commitRefundInline` / `approveManualPayment` where the manager identity is independent of the session. |
| `_endShiftSession_internal` *(internalMutation, v1.2 #6)* | Ends a single `staff_sessions` row (`{ ended_at: Date.now(), end_reason }`); `endReason ∈ {"manual_lock", "force_logout"}`. The ADR-034 session-end channel for the shift lifecycle mutations (`endOfDay`/`handover` → `force_logout`; `lock` → `manual_lock`) — replaces a direct `ctx.db.patch` on the auth-owned table. No idempotency wrapper (the calling mutation owns the key). |

## `staff.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `listStaff` | `{ sessionId }` | `Staff[]` | Manager-only. *(v0.5.3b)* Server-side projection strips `pin_hash` before returning — the admin UI never sees the hash even via reactive subscription. |
| q | `staff.public.listActiveManagers` | `{ sessionId }` | `{ name, code }[]` | *(v0.5.0)* Session-gated (any role). Returns all active managers. Used by the booth manager-picker on the charge screen for manager-PIN override flows. Does not expose pin_hash. |
| m | `updateStaff` | `{ id, patch, idempotencyKey }` | `Staff` | *(planned)* Manager-only; PIN reset uses `resetPin` separately |
| m | `resetPin` | `{ id, newPin, idempotencyKey }` | `void` | Manager-only; logs `staff.pin_reset` |
| m | `generateDeviceSetupCode` | `{ idempotencyKey }` | `{ code, expiresAt }` | Manager-only (booth, manager-session); thin wrapper over `issueDeviceSetupCode` helper. 6-digit, 1h TTL; `issued_via: "booth_inline"`. |
| m | `activateDevice` | `{ code, deviceLabel, idempotencyKey }` | `RegisteredDevice` | Public (pre-auth); consumes setup code. `activated_via` mirrors the code's `issued_via`; `actor_id: "system"` when the code was Telegram-issued (no booth staff). |
| q | `listDevices` | `{ sessionId }` | `RegisteredDevice[]` | Manager-only |
| m | `deactivateDevice` | `{ id, idempotencyKey }` | `void` | Manager-only |

### Device-setup-code helpers (`staff/internal.ts`) *(v0.5.7)*

Single-writer for `pending_device_setups`, shared by the booth mutation and the off-booth Telegram `/activatepos` path.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| helper | `issueDeviceSetupCode(ctx, opts)` | `{ issuedBy?, issuedVia, issuedByTelegram? }` | `{ code, expiresAt }` | Plain async fn (not a registered function). Mints the 6-digit code (1h TTL), inserts the `pending_device_setups` row, emits `device.setup_code_issued`. Single writer for the table — both `generateDeviceSetupCode` (booth) and the Telegram path call through here. Booth: `issuedVia: "booth_inline"`, `actor` = manager. Telegram: `issuedVia: "telegram"`, `actor_id: "system"`, `source: "system"` (no PIN/approval gate, so NOT `telegram_approval`). |
| i | `_issueDeviceSetupCodeFromTelegram_internal` | `{ issuedByTelegram }` | `{ code, expiresAt }` | internalMutation wrapper around `issueDeviceSetupCode`, called by the `/activatepos` Telegram action so the code is minted in a transaction. |

### v0.5.3b admin (`staff/actions.ts` + `staff/public.ts`)

In-app staff admin (`/mgr/staff`). PIN-gated mutations live in `actions.ts` so they can `verifyManagerPinOrThrow` (argon2 = action-only); session-only mutations live in `public.ts`. Action-level idempotency via `withActionCache` + a derived `${idempotencyKey}:commit` key on the internal writer.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| a | `staff.actions.setStaffRole` | `{ idempotencyKey, sessionId, staffId, role, managerPin }` | `{ ok: true }` | Manager-PIN gated. Promotes/demotes a staff member. `LAST_ACTIVE_MANAGER` guard lives in `_setStaffRoleCommit_internal` so the read+patch is atomic. Logs `staff.updated` (`field: "role"`). |
| a | `staff.actions.deactivateStaff` | `{ idempotencyKey, sessionId, staffId, managerPin }` | `{ ok: true }` | Manager-PIN gated. Soft-deletes a staff member. `SELF_DEACTIVATE` + `LAST_ACTIVE_MANAGER` guards in `_deactivateStaffCommit_internal`. Logs `staff.deactivated`. |
| m | `staff.public.updateStaffName` | `{ idempotencyKey, sessionId, staffId, name }` | `{ ok: true }` | Manager-session gated, NO PIN — names are low-sensitivity metadata. 1–60 chars after trim. Logs `staff.updated` (`field: "name"`). |

## `catalog.ts` (`products.ts`)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `catalog` | `{}` | `{ products: Product[], skus: InventorySku[], components: ProductComponent[], stockLevels: StockLevel[], vouchers: Voucher[] }` | Single payload for catalog cache + offline support ([ADR-025](./ADR/025-service-worker-cache.md)). Available client-side for the cart-build flow even when offline. Filters `active: true`. |
| m | `upsertSku` | `{ patch, idempotencyKey }` | `InventorySku` | *(planned)* Manager-only ([ADR-016](./ADR/016-product-inventory-separation.md)) |

### v0.5.3b admin (`catalog/actions.ts` + `catalog/public.ts`)

In-app product admin (`/mgr/products`). Same PIN-vs-session tiering as staff admin: money fields (price + tax_rate) are PIN-gated; metadata / components / archive are session-only. Snapshot-on-line rule (CLAUDE.md #1) means pricing edits never rewrite past `pos_transaction_lines`.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `catalog.public.listAllProducts` | `{ sessionId }` | `{ products: (Doc<"pos_products"> & { photo_url: string \| null })[], skus: Doc<"pos_inventory_skus">[], components: Doc<"pos_product_components">[] }` | Manager-session. Includes inactive (archived) products — distinct from public `catalog` which filters `active: true`. **v1.2 #3:** each product carries server-resolved `photo_url` (`ctx.storage.getUrl`, `null` when no photo). |
| m | `catalog.public.generateProductPhotoUploadUrl` | `{ idempotencyKey, sessionId }` | `{ uploadUrl }` | **v1.2 #3.** Manager-session, NO PIN. Mints a Convex storage upload URL for a product photo (mirrors `settings.generateLogoUploadUrl`). Client POSTs a downscaled square webp, then folds the returned `storageId` into `updateProductMeta`. `withIdempotency` + authCheck-before-cache. |
| a | `catalog.actions.createInventorySku` | `{ idempotencyKey, sessionId, managerPin, sku, name, low_threshold, code?, initials?, hue? }` | `{ skuId }` | Manager-PIN gated (identity/structure write — CLAUDE.md #22). `withActionCache` wraps PIN verify + inner mutation. Inner receives `${idempotencyKey}:commit` for crash-retry idempotency. Errors: `INVALID_PIN`, `LOCKED_OUT:<secs>`, `SESSION_INVALID`, `NOT_MANAGER`, `SKU_EXISTS`, `CODE_EXISTS`, `SKU_INVALID`, `NAME_INVALID`, `LOW_THRESHOLD_INVALID`. Audit: `inventory_sku.created` (source `booth_inline`). |
| a | `catalog.actions.createProduct` | `{ idempotencyKey, sessionId, managerPin, sku_family, name, pack_label, price_idr, tax_rate, sort_order, initials?, hue?, withInventorySku?, inventorySkuLowThreshold?, inventorySkuComponentQty? }` | `{ productId, inventorySkuId?, skuCreated?, componentQty? }` | Manager-PIN gated. Mints a new product row; component wiring is a separate call (`setProductComponents`) unless `withInventorySku === true`, in which case the same Convex transaction also creates-or-links a matching `pos_inventory_skus` row (slug = `sku_family.toLowerCase()`) and inserts a `pos_product_components` row at `qty = inventorySkuComponentQty`. New errors: `SKU_FAMILY_NOT_SLUGGABLE`, `QTY_INVALID`, `LOW_THRESHOLD_INVALID`. Bundled reuse of an archived SKU throws `SKU_INACTIVE` (matches `setProductComponents`). Bundled path also emits `inventory_sku.created` (only if newly inserted) + `product.updated` (`{ components_changed: true, count: 1, sku_id, qty, via: "create_product_bundled" }` — reuses the components verb rather than a bespoke one). Logs `product.created`. |
| i | `catalog.internal._createInventorySkuCommit_internal` | `{ idempotencyKey, sku, name, low_threshold, code?, initials?, hue? }` | `{ skuId }` | Single-writer mutation for `createInventorySku`. `withIdempotency`-wrapped on the `:commit`-derived key. Validates slug, name, threshold; throws `SKU_EXISTS` / `CODE_EXISTS` on duplicates. Inserts the row + `inventory_sku.created` audit in one transaction. **No `pos_stock_levels` seed** — `upsertStockLevel` lazy-inits on first movement. |
| a | `catalog.actions.updateProductPricing` | `{ idempotencyKey, sessionId, managerPin, productId, price_idr, tax_rate }` | `{ ok: true }` | Manager-PIN gated. Changes `price_idr` and/or `tax_rate`. Snapshot rule: past lines unchanged. Logs `product.updated` (`field: "pricing"`). |
| m | `catalog.public.updateProductMeta` | `{ idempotencyKey, sessionId, productId, name, pack_label, sort_order, sku_family?, initials?, hue?, photo_storage_id?: Id<"_storage"> \| null }` | `{ ok: true }` | Manager-session, NO PIN. Edits non-money metadata. 1–80 chars on name. **v1.2 #3:** `photo_storage_id` — `undefined`=keep, `null`=remove (field deleted, no blob delete), id=set. Logs `product.updated` (`field: "meta"`, `photo_changed: boolean`). |
| m | `catalog.public.setProductComponents` | `{ idempotencyKey, sessionId, productId, components: { inventory_sku_id, qty }[] }` | `{ ok: true }` | Manager-session, NO PIN. Replace-set: validates every row (qty integer > 0, SKU exists + active) BEFORE any delete/insert (fail-before-write atomicity), then deletes existing component rows via `by_product` index and inserts the new set. Logs `product.updated` (`components_changed: true`). |
| m | `catalog.public.archiveProduct` | `{ idempotencyKey, sessionId, productId }` | `{ ok: true }` | Manager-session, NO PIN. Soft-delete (`active: false`). Disappears from public `catalog`; remains in `listAllProducts`. Historical lines unaffected (snapshot rule #1). Logs `product.archived`. |

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

## `refunds/` *(v0.5.1 PR B — shipped surface)*

Refund ledger + settlement surface. Both authorisation paths (booth-PIN inline, Telegram-PIN off-booth) funnel through the single internal writer `_commitRefund_internal` (v0.5.0 cross-path-parity). The `approveRefund` action lives in `convex/approvals/actions.ts` (not `refunds/`) because it is dispatched from the `/approve/:token` flow — listed here for completeness.

Stale pre-v0.5.1 design (Xendit refund API, `pos_refund_lines`, `reason_code` enum, `status: pending|succeeded|failed`) did **not** ship — refunds are manager-authorised, server-side bookkeeping with manual money movement tracked via `settlement_status`.

### Public

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `refunds.public.listTodaysRefundable` | `{ sessionId }` | `Doc<"pos_transactions">[]` | Session-gated. Today's paid txns (since 00:00 WIB via `wibDayWindow`), newest-first. Older txns are unreachable in v0.5.1 — refund window is intentionally small. Cross-module read routed through `transactions/internal._listPaidTxnsSince_internal` per ADR-034. |
| q | `refunds.public.listForTransaction` | `{ sessionId, transactionId }` | `{ txn, lines: (Line & { refundable: number })[], refunds: Refund[] } \| { txn: null, lines: [], refunds: [] }` | Session-gated. Aggregate for the refund form: txn + lines (each annotated with `refundable = lineRefundable(line)`) + existing refunds. Returns the empty-state shape (`null` txn) for not-found / not-paid so the caller renders an empty state rather than throws. |
| m | `refunds.public.markRefundSettled` | `{ sessionId, idempotencyKey, refundId }` | `{ settled_by: Id<"staff">, settled_at: number }` | **Manager-session gated, NOT PIN** (ADR-038, CLAUDE.md rule #22). Flips `settlement_status: pending → settled`, sets `settled_by` + `settled_at` together. Idempotent — a second call on an already-settled refund returns the original settler/timestamp without re-patching or re-auditing. `authCheck` runs before the idempotency cache lookup so a non-manager replay cannot read back the cached response. Logs `refund.settled` (source=`booth_inline`). |
| q | `refunds.public.listPendingSettlement` | `{ sessionId }` | `Doc<"pos_refunds">[]` | **Manager-session gated.** Refunds with `settlement_status: "pending"`, oldest-first via the `by_settlement_status` composite index. Powers `/mgr/refunds-pending` so managers sweep outstanding refund money-movements in FIFO order. |

### Actions (Node runtime)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| a | `refunds.actions.commitRefundInline` | `{ sessionId, idempotencyKey, transactionId, lines: { line_id, qty }[], reason, managerStaffCode, managerPin }` | `{ refundId: Id<"pos_refunds">, total_refund: number }` | Booth-PIN refund commit. Action-level idempotency (`_lookup_internal` → `_writeCache_internal`). Session establishes "someone is logged in"; the manager identity is supplied independently as `managerStaffCode` (stable `S-NNNN` external surface, never `_id`) — same pattern as `approveManualPayment`. argon2-verifies the manager PIN via `verifyPinOrThrow`; wrong PIN counts toward THIS manager's ADR-002 lockout, not the session staff's. On success, delegates to `_commitRefund_internal` with `approvalSource: "booth_inline"`. Session staffer recorded as `requested_by`; manager recorded as `approver_id` (may equal `requested_by` if the manager is logged in). |
| a | `refunds.actions.requestRefundApproval` | `{ sessionId, idempotencyKey, transactionId, lines: { line_id, qty }[], reason }` | `{ requestId: Id<"pos_approval_requests"> }` | Off-booth refund approval (Telegram path). Structural sibling of `requestManualPaymentApproval`. Steps: action-level idempotency pre-check → resolve session (no PIN at this stage) → `_computeRefundPreview_internal` (validates + computes preview for Telegram card) → dedup via `_findPendingRefundForTxn_internal` (one live pending refund per txn) → mint 32-byte URL-safe token (only SHA-256 hash persisted, ADR-029) → `_createRequest_internal` with `kind: "refund"` and `RefundContext` payload → `sendTemplate` Telegram card (deletes the request row on send failure so the next attempt retries cleanly) → `_markNotified_internal` + best-effort `_linkTelegramMessage_internal` → write idempotency cache. Errors surface the same TXN_NOT_REFUNDABLE / LINE_NOT_FOUND codes as the booth path. |
| a | `approvals.actions.approveRefund` | `{ token, managerStaffCode, managerPin, idempotencyKey }` | `{ refundId: Id<"pos_refunds">, total_refund: number }` | **Lives in `convex/approvals/actions.ts`, not `refunds/`.** The `/approve/:token` PIN-submit endpoint for `kind: "refund"`. Verifies token (constant-time SHA-256 compare) + argon2 manager PIN; increments `failed_pin_attempts` on wrong PIN with auto-deny at `TOKEN_PIN_ATTEMPT_CAP` (5). On success, dispatches to `_commitRefund_internal` with `approvalSource: "telegram_approval"` + the originating `approval_request_id`, then `_markResolved_internal` flips the request. KIND_AUDIT.refund.resolved = `"refund.committed"` by design (one verb for both paths). |

### Internal (single-writer + cross-module read surface — see `convex/refunds/internal.ts` for full signatures)

| Helper | Notes |
|---|---|
| `_commitRefund_internal` | **The single writer for `pos_refunds`.** Both `commitRefundInline` and `approveRefund` funnel here. Pipeline: validate txn paid + per-line qty ≤ `lineRefundable(line)` → compute per-line `refund_amount` via ADR-040 `computeRefundAmount` → insert `pos_refunds` (`settlement_status: "pending"`) → patch each `line.refunded_qty += qty` via `transactions/internal._patchLineRefundedQty_internal` → re-credit stock via `inventory/internal._refundReCredit_internal` (positive `pos_stock_movements`, `source: "refund"`, ADR-019) → purge cached receipt HTML via `receipts/internal._purgeReceiptCache_internal` (ADR-039) → audit `refund.committed` with source = `approvalSource` arg. Errors: `TXN_NOT_REFUNDABLE`, `LINE_NOT_FOUND`, `REFUND_QTY_INVALID`, `REFUND_QTY_EXCEEDS_REFUNDABLE`. |
| `_computeRefundPreview_internal` | Pure-read preview: validates txn + line ids, returns `{ receipt_number, lines: [{ line_id, product_name, refund_qty, refund_amount }], total_refund }`. Used by `requestRefundApproval` to populate the Telegram card's `RefundContext` (and by extension the `/approve/:token` UI). No DB writes. Surfaces the same error codes as `_commitRefund_internal` so callers see one error surface across paths. |
| `_listForTransaction_internal` | Cross-module read used by the receipts module to render the refund block + status header on `/r/<token>` (ADR-039). Returns refund rows for a txn (`by_transaction` index). |
| `_findPendingRefundForTxn_internal` | Telegram-path dedup guard. Returns the existing live pending refund `requestId` for a txn (via `approvals/internal._listPendingByKind_internal` — refunds never reads `pos_approval_requests` directly per ADR-034). |

## Inventory (v0.5.2)

Public surface for the FPOS-internal inventory slice — stock-check screen, staff absolute recount, manager threshold edit, hourly recount nudge. Lives in `convex/inventory/public.ts` (queries) + `convex/inventory/actions.ts` (recount action). See [ADR-041](./ADR/041-recount-staff-absolute-stock-update.md) (recount source) and [ADR-042](./ADR/042-low-stock-detection-inventory-telegram.md) (reactive low-stock check reuses catalog `low_threshold`).

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| a | `inventory.actions.recordRecount` | `{ idempotencyKey, sessionId, counts: { skuId, entered }[] }` | `{ ok: true, changed: number }` | Records an absolute recount; for each changed SKU writes a signed-delta `recount` movement (`entered − before`), patches `pos_stock_levels.on_hand`, stamps `pos_recount_state.last_recount_at`, schedules manager Telegram notice via `_dispatchRecountNotice_internal`, and runs `_checkLowStock_internal` per touched SKU. Audits `stock.recount` (`source: booth_inline`, metadata `{ before, after, delta }`). Staff-allowed (no manager-PIN gate — always-notify Telegram is the control). |
| m | `inventory.public.setLowThreshold` | `{ idempotencyKey, sessionId, skuId, lowThreshold }` | `{ ok: true }` | Manager-gated. Updates catalog-owned `pos_inventory_skus.low_threshold` via `catalog/internal._setLowThreshold_internal` (cross-module seam per ADR-034). Audits `stock.low_threshold_set` (`source: booth_inline`, metadata `{ low_threshold }`). |
| q | `inventory.public.listInventory` | `{ sessionId }` | `Array<{ skuId, name, on_hand, low_threshold, status: "ok" \| "low" \| "negative" }>` | Session-gated. One row per active SKU. Powers `/stock`. |
| q | `inventory.public.getSkuDetail` | `{ sessionId, skuId }` | `{ name, on_hand, low_threshold, movements }` | Session-gated. `movements` is up to 30 most-recent `pos_stock_movements` rows for the SKU in DESC order. Powers `/stock/:skuId`. |
| q | `inventory.public.getRecountState` | `{ sessionId }` | `{ last_recount_at: number \| null }` | Session-gated. Reads the `pos_recount_state` singleton. Powers the hourly recount-nudge banner on the home screen. |

## `stock.ts`

> **v0.5.2 note:** This block describes the v0.5 *planned* stock-in/adjust/spoilage surface. v0.5.2 ships only the inventory-slice queries above (`listInventory`, `getSkuDetail`, `getRecountState`) plus `recordRecount` + `setLowThreshold`. The `stockIn` / `adjust` / `recordSpoilage` mutations below are scoped to v0.5.2b (FPro-driven) and v0.6.

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

## `telegram/activatePos.ts` *(v0.5.7 — `/activatepos` device activation)*

Off-booth device-setup-code minting. A manager sends `/activatepos` in the `managers`-role chat; the bot replies with a 6-digit setup code (1h TTL) + the `<POS_BASE_URL>/activate` link. Registered in the `convex/http.ts` webhook command registry.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| factory | `buildActivatePosCommand(scheduler)` | `scheduler` | command descriptor | Factory that returns the webhook command entry (matcher accepts a bare `/activatepos` or the `/activatepos@<bot_username>` form). Schedules `handleActivatePos`. |
| internal a | `handleActivatePos` | `{ chatId, chatTitle, fromId? }` | `void` | internalAction. Chat-role gated to `managers` (resolves the managers-bound chat id and compares; ignores other chats; silent no-op if no chat bound). Calls `staff/internal._issueDeviceSetupCodeFromTelegram_internal` to mint the code, then replies via `sendTelegramHtml`. Audit `device.setup_code_issued` with `actor_id: "system"` + `source: "system"`. |

## `audit.ts`

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `audit.public.list` | `{ sessionId, limit?, action? }` | `(Doc<"audit_log"> & { actor_name: string })[]` | Manager-only. *(v0.5.8)* Returns rows enriched with server-derived `actor_name` (was raw `Doc<"audit_log">[]`; label pattern per ADR-034 / v0.5.3a). `limit` clamped to 500; `action` filters by exact verb. |
| internal helper | `logAudit` | (inside other mutations) | | Required to be called from every state-changing mutation ([ADR-007](./ADR/007-audit-log-append-only.md)). `audit_log.action` is a free `v.string()` — no code enum to keep in sync; canonical verb vocab lives in `docs/SCHEMA.md`. |

**v0.5.3b verbs added:** `staff.created`, `staff.updated`, `staff.deactivated`, `product.created`, `product.updated`, `product.archived`, `settings.receipt_updated`.

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

## `settlements/` *(v0.7 — Xendit settlement reconciliation)*

Per-day payout aggregate. No Xendit "settlement object"/webhook — dual-source (manual + nightly poll), poll-wins-on-conflict. See [ADR-012 amendment](./ADR/012-settlements-visible-to-staff-and-managers.md#amended-2026-06-08-v07).

### Public

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `settlements.public.listSettlements` | `{ sessionId, fromDate?, toDate? }` | `Doc<"pos_settlements">[]` | **Role-agnostic** ([ADR-012](./ADR/012-settlements-visible-to-staff-and-managers.md)) — any valid session passes; absent/ended session throws `SESSION_INVALID`. Newest `settlement_date` first; optional `YYYY-MM-DD` inclusive range pushed into `by_settlement_date` index. |

### Actions (Node runtime)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| a | `settlements.actions.enterSettlementManually` | `{ idempotencyKey, sessionId, settlementDate, grossAmount, mdrAmount, transactionCount, bcaAccountLast4, managerPin }` | `Id<"pos_settlements">` | **Manager-PIN** gated (ADR-022 tiering). The verified launch path while KYB pending. `net = gross - mdr` computed server-side (ADR-031/-015). `withActionCache` (auth-before-cache, ADR-046) + keyed-upsert idempotency. Errors: `DATE_INVALID`, `AMOUNT_INVALID`, `NET_INVALID`, `LAST4_INVALID`, `MANAGER_SESSION_REQUIRED`, `SESSION_INVALID`, `NOT_MANAGER`, `INVALID_PIN`, `LOCKED_OUT:<secs>`. |

### Internal (single-writer + sync — see `convex/settlements/` for full signatures)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `settlements.internal._upsertSettlementDay_internal` | `{ settlement_date, gross_amount, mdr_amount, net_amount, transaction_count, source, entered_by?, bca_account_destination?, payload? }` | `Id<"pos_settlements">` | **Single writer.** Upserts one row per day (key `settle-<date>`). Poll-wins-on-conflict: poll-over-manual flips source + audits `settlement.poll_superseded_manual`; else `settlement.upserted`. Server time inside (ADR-031). |
| m | `settlements.internal._auditSyncSkip_internal` | `{ reason, metadata? }` | `void` | Audits `settlement.sync_skipped` when a sync run finds zero settled rows (expected pre-KYB). No entity_id; actor=system. |
| a | `settlements.cronActions.syncSettlements` | `{}` | `{ ok, days } \| { skipped: "no_settlements" }` | V8-safe inner action. Calls `GET /transactions` (LOOKBACK_DAYS=7), `parseListTransactions` + `aggregateSettledByDate`, upserts one row per WIB settlement day. On-demand callable. |
| a | `settlements.cronActions.syncSettlementsResilient` | `{ attempt? }` | `{ ok, days } \| { skipped } \| { ok, retried, nextAttempt }` | **Cron entry-point** (`settlement-sync`, 20:30 UTC / 03:30 WIB). Wraps `syncSettlements` with shared `cronRetry` policy (linear back-off, `RESILIENT_MAX_ATTEMPTS`). |

## `shifts/` *(v1.2 #6 / ADR-053 — two-level booth state)*

Booth shift state is **two stored levels** ([ADR-053](./ADR/053-two-level-booth-state.md), supersedes ADR-050). Level 1: `outlets.is_open` (SOP gate). Level 2: `pos_shifts` active holder row. `pos_shift_events` is legacy read-only.

### Public (`convex/shifts/shifts.ts`)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| m | `shifts.shifts.openBooth` | `{ idempotencyKey, sessionId, steps, openCount? }` | `{ ok: true; shiftId }` | **Requires outlet closed** (`OUTLET_ALREADY_OPEN`). Sets `outlets.is_open = true` (Level 1) AND inserts a `pos_shifts` row (Level 2) atomically. The SOD SOP checklist is submitted here. Audits `outlet.opened` + `shift.start`. |
| m | `shifts.shifts.startShift` | `{ idempotencyKey, sessionId }` | `{ ok: true; shiftId }` | Creates a new `pos_shifts` row when the outlet is already open (subsequent staff after a handover or lock). Level 2 only. Audits `shift.start`. |
| m | `shifts.shifts.endOfDay` | `{ idempotencyKey, sessionId, steps, closeCount? }` | `{ ok: true; durationMs }` | **Requires outlet open + active shift holder** (`OUTLET_NOT_OPEN`, `NO_ACTIVE_SHIFT`). Ends the `pos_shifts` row, sets `outlets.is_open = false`. Builds summary via `_buildSignoffSummary_internal`. Audits `outlet.closed` + `shift.end`. Schedules `_sendSignoffSummary` → managers Telegram. |
| m | `shifts.shifts.handover` | `{ idempotencyKey, outSessionId, inSessionId, steps, closeCount?, openCount? }` | `{ ok: true; shiftId }` | Person-to-person transfer: ends the outgoing `pos_shifts` row (schedules `_sendSignoffSummary`), inserts a new row for the incoming staff. No intermediate `handover_pending` state. Audits `shift.handover`. |
| m | `shifts.shifts.lock` | `{ idempotencyKey, sessionId }` | `{ ok: true }` | Ends the session (`manual_lock`). The `pos_shifts` row is **unchanged** — the holder row stays active. The locked staff re-authenticates and calls `startShift` / `recordResume` to get a new session. Audits `shift.lock`. |
| m | `shifts.shifts.recordResume` | `{ idempotencyKey, sessionId }` | `{ ok: true }` | Session-based resume by the same staff after a lock. Audits `shift.resume`. |
| q | `shifts.shifts.loginContext` | `{ deviceId: string }` | `{ isOpen: boolean; activeShift: { staffId, staffName, startedAt } \| null }` | Reactive query for the login gate. Returns Level 1 + Level 2 state so the FE can derive: closed/open-no-holder/open-with-holder/locked. |

### Actions (Node runtime — `convex/shifts/actions.ts`)

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| a | `shifts.actions.managerOverride` | `{ idempotencyKey, deviceId, managerStaffId, managerPin }` | `{ ok: true }` | **Manager-PIN gated** (argon2id, ADR-046). Force-ends the stranded `pos_shifts` row without creating a new session. The original staffer (or manager) re-authenticates via standard login. Errors: `NOT_MANAGER`, `INVALID_PIN`, `LOCKED_OUT:<secs>`. Audits `shift.manager_override`. |
| a | `shifts.actions.managerSkipOpen` | `{ idempotencyKey, sessionId, managerPin }` | `{ ok: true; shiftId }` | **Manager-session + PIN** (ADR-046). Opens the booth without the full SOP checklist. Equivalent to `openBooth` but PIN-gated. Audits `outlet.opened` + `shift.start`. |

### Internal (helpers — `convex/shifts/internal.ts` + `convex/shifts/shiftsInternal.ts`)

| Helper | Notes |
|---|---|
| `_buildSignoffSummary_internal` | Aggregates sales + manual-BCA for the window `[shiftStartMs, endMs]` using `transactions/internal`. Returns `{ durationMs, totalSalesIdr, txnCount, manualBcaCount, manualBcaTotalIdr }`. |
| `_shiftStartAnchor_internal` | Recovers the most recent shift-START event from the legacy `pos_shift_events` table (used for historical/migration reads only). Returns `{ shift_started_at, staff_id }` or `null`. |
| `_recordShiftEvent_internal` | Legacy writer for `pos_shift_events` (migration backfill path only). |
| `_getActiveShift_internal` | Returns the active `pos_shifts` row for an outlet (`ended_at == null`). Used by signoff/handover/override. |
| `_startShift_internal` | Inserts a new `pos_shifts` row + audits `shift.start`. Single writer for Level 2. |
| `_endShift_internal` | Patches `ended_at` + `end_reason` + `summary` on a `pos_shifts` row. |
| `_managerOverrideCommit_internal` | Atomic commit for `managerOverride`: fetch active shift by outlet → set `ended_at` + `end_reason: "manager_override"` → audit. No new session created. |
| `_managerSkipOpenCommit_internal` | Atomic commit for `managerSkipOpen`: set `outlets.is_open = true` + insert `pos_shifts` row + audit. |

### Actions (Node runtime — internal helpers)

| Helper | Notes |
|---|---|
| `_sendSignoffSummary` | Deferred internal action. Resolves staff name + BCA items, sends `staff_shift_signoff` template to per-outlet managers Telegram. Scheduled by `endOfDay` and `handover` out-half. |

### Pure helpers (`convex/shifts/lib.ts`)

| Function | Signature | Notes |
|---|---|---|
| `computeShiftHoursMs` | `(shiftStartedAt: number, endedAt: number) → number` | `max(0, endedAt - shiftStartedAt)`. |
| `resolveStaffName` | `(names, staffId, fallback?) → string` | Looks up display name in a `_listStaffNames_internal` result set. |

## `settings.ts` *(v0.4 + v0.5.3b)*

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `settings.public.getSettings` | `{}` | `{ founders_summary_enabled: boolean, txn_ticker_enabled: boolean }` | Public-readable. Returns `true` if the `pos_settings` row is absent (default-on). |
| m | `settings.public.setFoundersSummaryEnabled` | `{ idempotencyKey, sessionId, enabled }` | `{ ok: true }` | Manager-only. Upserts the `pos_settings` singleton. Logs `settings.founders_summary_toggled`. |
| m | `settings.public.setTxnTickerEnabled` | `{ idempotencyKey, sessionId, enabled }` | `{ ok: true }` | Manager-session. Flips `pos_settings.txn_ticker_enabled`; audit `settings.txn_ticker_toggled`. |

### Receipt branding (v0.5.3b)

In-app receipt config (`/mgr/receipt`). All three are manager-session gated — receipt branding is curation, not a money move (CLAUDE.md #9). The update path purges the receipt HTML cache (`_purgeAllReceiptCache_internal`) so customers see new branding on the next `/r/<token>` view.

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `settings.public.getReceiptConfig` | `{ sessionId }` | `{ business_name, address, contact, instagram_handle, footer_text, logo_storage_id, logo_url }` | Manager-session. Resolves `logo_url` from the storage id via `ctx.storage.getUrl` so the form can preview without a second round-trip. |
| m | `settings.public.generateLogoUploadUrl` | `{ idempotencyKey, sessionId }` | `{ uploadUrl }` | Manager-session. Returns a short-lived Convex storage upload URL. Cached by idempotency key so a retry returns the same target. |
| m | `settings.public.updateReceiptConfig` | `{ idempotencyKey, sessionId, business_name, address, contact, instagram_handle, footer_text, logo_storage_id? }` | `{ ok: true }` | Manager-session. Upserts the `pos_settings` singleton with `receipt_*` fields. Each user-supplied string bounded to 120 chars (`FIELD_TOO_LONG:<key>` on overflow). Calls `_purgeAllReceiptCache_internal` AFTER the patch so a partial failure doesn't blow the cache. Logs `settings.receipt_updated`. |

## `idempotency.ts` *(new in v0.5 — mutation harness)*

Not a public surface — provides the wrappers used by every public mutation and PIN-gated action. See [ADR-013](./ADR/013-idempotency-keys.md). Exposes:

| Helper | Notes |
|---|---|
| `withIdempotency(handler)` | Wraps a **mutation** handler; checks `pos_idempotency` for the key; replays stored response or executes + stores. Pair with `authCheck` so unauthorised retries don't read cached success (see `docs/PATTERNS/idempotency-dual-call-authcheck.md`). |
| `withActionCache(ctx, { key, mutationName }, fn)` | *(v0.5.3b)* Action-level cache at `convex/idempotency/action.ts`. Wraps an **action** body that itself ends in an idempotent `runMutation` (the canonical pattern: PIN-verify in the action, then dispatch to an internal mutation with a derived `${key}:commit` key — see `staff/actions.ts`, `catalog/actions.ts`, `refunds/actions.ts`). Survives the auth-before-cache rule because the PIN verification runs inside `fn` before the cache write. |
| `purgeExpired_scheduled` | Scheduled action; deletes `pos_idempotency` rows past `expires_at` |

## HTTP actions

| Type | Path | Method | Notes |
|---|---|---|---|
| h | `/xendit/webhook` | POST | Verifies `x-callback-token` header; routes by event type (`invoice.paid`, `refund.succeeded`, `settlement.completed`); returns 200 fast, processes idempotently |
| h | `/r/:receiptToken` | GET | Public receipt HTML render ([ADR-021](./ADR/021-receipt-url-convex-http-action.md)); reads `pos_transactions` by `receipt_token`; expired HTML cache regenerates and re-caches |

## `receipts.ts` *(v0.5.1 PR A + v0.5.3b + v0.5.4)*

### HTTP

#### `GET /r/:token`
Returns the HTML receipt page for the txn with matching `receipt_token`. 200 + cached HTML on hit, 200 + freshly rendered + cached on miss, 404 + Indonesian "Struk tidak ditemukan" page on unknown token or non-paid txn status.

Routed via `pathPrefix: "/r/"` in `convex/http.ts`; handler is `handleReceiptRoute` (`convex/receipts/http.ts`).

**v0.5.3b:** `template.ts` now reads receipt branding (business name, address, contact, instagram handle, footer text, logo) from `pos_settings._getSettings_internal` instead of hardcoded consts. `_purgeAllReceiptCache_internal` is invoked from `settings.updateReceiptConfig` so a branding change flushes the 24h cache for all txns.

### Queries

| Type | Name | Args | Returns | Notes |
|---|---|---|---|---|
| q | `receipts.public.getReceiptForPrint` | `{ sessionId, txnId }` | `{ viewModel, status, statusLabel } \| null` | **v0.5.4.** Session-gated, role/today-scoped — mirrors `transactions.getTransactionDetail` (staff: server-today only; manager: any day). Returns the same `ReceiptViewModel` that backs `/r/<token>` plus a pre-derived `statusLabel` (from the now-exported `template.STATUS_LABELS`), so the Web Bluetooth print path (ADR-043) consumes the server-side money/line math instead of re-deriving it. Returns `null` for not-found / not-paid / out-of-scope. Routes the cross-module txn read through `transactions/internal` per ADR-034. **Returns NO token or URL** (ADR-021) — the digital-receipt QR token is minted separately via `transactions.shareReceipt`. Read-only; not audited. |

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
