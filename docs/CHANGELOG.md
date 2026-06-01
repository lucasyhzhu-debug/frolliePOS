# Changelog

All notable changes to Frollie POS. Format follows Frollie Pro's conventions.

## v0.5.2 — FPOS-internal inventory slice (unreleased)

FPOS-internal inventory slice: a stock-check screen, a staff absolute-recount flow, and reactive low-stock alerting to a new `inventory` Telegram group. Scopes out FPro-driven stock-in/out — that work moved to v0.5.2b once the cross-deployment integration pattern (ADR-043, to be drafted) lands.

### Frontend
- New `/stock` inventory list (per-SKU on-hand + low/negative status).
- New `/stock/recount` — staff submit absolute counts; client renders signed-delta preview.
- New `/stock/:skuId` SKU detail with movement history; manager-gated `low_threshold` edit.
- Hourly recount-nudge banner on home, driven by `pos_recount_state.last_recount_at`.

### Backend
- New `pos_stock_movements.source` literal: `recount` (signed delta = `entered − before`, ADR-041). Staff-allowed — distinct from manager-PIN-gated `adjustment`.
- New tables: `pos_low_stock_alerts` (dedup flag, ADR-042) + `pos_recount_state` (singleton, ADR-041).
- New `convex/inventory/` surface: `recordRecount` action, `setLowThreshold` mutation, `listInventory` / `getSkuDetail` / `getRecountState` queries.
- New `_checkLowStock_internal` reactive check, called from `_recordSaleMovement_internal` and `recordRecount`; SKU-deduped via `pos_low_stock_alerts.by_sku`; scheduled Telegram dispatch via fail-isolated `_dispatchLowStockAlert_internal`.
- New audit verbs: `stock.recount`, `stock.low_stock_alerted`, `stock.low_threshold_set`.
- New Telegram role: `inventory` (operations chat receiving recount notices + low-stock alerts). Added to `KNOWN_TELEGRAM_ROLES`.
- Catalog cross-module seams: `_getSkusByIds_internal` + `_setLowThreshold_internal` per ADR-034.

### ADRs
- [ADR-041](./ADR/041-recount-staff-absolute-stock-update.md) — recount vs adjust distinction (`recount` is a new `pos_stock_movements.source`; staff-allowed; always-notify Telegram is the control).
- [ADR-042](./ADR/042-low-stock-detection-inventory-telegram.md) — reactive low-stock detection reuses catalog `pos_inventory_skus.low_threshold`; no threshold duplication on the new `pos_low_stock_alerts` table.

### Deploy notes
- No frontend/backend deploy ordering changes — backend additive.
- One new Telegram role to bind post-deploy: `inventory` (via `/mgr/telegram-chats`). Until bound, low-stock + recount dispatches will audit `telegram.skipped` (`metadata.reason: "role_unbound"`) and continue silently.

## v0.5.1c — Housekeeping (2026-06-01)

Pure refactors lifted from the v0.5.1b triple-review + `/simplify xhigh` "deferred" bucket. Three crisp items, three commits, no behaviour change.

- **Shared `sha256Hex` helper** at `convex/lib/tokenHash.ts` ("use node"). Approval-token and refund-token hashing (ADR-029) was duplicated byte-for-byte between `convex/approvals/actions.ts` and `convex/refunds/actions.ts`. Single source of truth for the security primitive; future kind additions (kind #4 in v0.6) import rather than copy.
- **`upsertStockLevel(ctx, skuId, delta, now)` helper** in `convex/inventory/internal.ts`. Three existing `pos_stock_levels` upsert sites (sale-decrement, manager-adjust, refund re-credit) collapsed to a single helper. v0.5.2 inventory plan adds two more upsert sites (recount + low-stock delta) — landing the helper now avoids writing those duplications in the first place. ADR-018 invariant (negative `on_hand` allowed, flagged on transactions) preserved — the helper does not block negatives. `.first()` retained over `.unique()` for zero-behaviour-change.
- **Collapsed `Approve()` terminal-state dispatch** in `src/routes/approve/index.tsx`. Six near-identical `CheckCircle2`/`XCircle` blocks (three kinds × resolved + denied) replaced by a per-kind `{ resolvedMsg, deniedMsg, deniedExtra? }` config table. The system auto-revoke special case (`deny_reason === "too_many_pin_attempts"`) and the `denierLabel` fallback chain are preserved byte-for-byte. Kind #4 (v0.6 spoilage/void) will add one TerminalCopy entry instead of two CheckCircle2/XCircle blocks.

Net diff: ~+9 LOC across three files (helpers cost more lines than they save on this small N, but the drift hazard is what was bought down). Tests: 658/658 still passing; no test changes required.

Deferred to v0.6 (when kind #4 reveals the seam): 3-way variant unification in `/approve` (PinReset/ManualPayment/Refund variants share ~330 lines each), `_computeRefundPreview` ↔ `_commitRefund` dual-loop helper, `replayCachedOr<T>` action-envelope helper.

## v0.5.1 — Refunds + customer receipts (2026-06-01)

### PR A — receipt subsystem (shipped 2026-06-01)

- Every paid sale now produces a shareable signed-URL receipt at `/r/<token>` (ADR-021, ADR-022). 32-byte URL-safe token minted in `_confirmPaid` via the shared `mintUrlSafeToken()` helper.
- Hardcoded receipt template per ADR-039 §4 (Indonesian language, teal accent, 🍪 emoji as logo placeholder, Instagram CTA). NPWP + tax disclaimers omitted (PPN 0 until PKP registration). Refund block stubbed (empty `refunds[]`) — populated in PR B.
- Template lives at `convex/receipts/template.ts` (Convex-side), NOT `src/lib/receipt-template.ts` as the spec originally listed — the renderer is invoked by an httpAction and Convex code cannot import from `src/`. `src/lib/format.ts` `rp()` negative-amount handling is the only frontend-side receipt-related change, deferred to PR B.
- 24h HTML cache with lazy regenerate on miss; no reaper cron. Convex storage is cheap; lazy is always correct.
- Status guard on `/r/<token>`: returns 404 for non-paid txns (defence-in-depth against manual DB patches).
- New audit verb `receipt.token_minted` (for the dormant lazy-mint helper used by future v0.5.3 history surface).
- Extracted shared `mintUrlSafeToken(bytes=32)` to `convex/lib/tokens.ts` (used by approvals + receipts). Implemented with Web Crypto (`globalThis.crypto.getRandomValues`) so the module is V8-safe — `node:crypto.randomBytes` would have broken `npx convex codegen` because Convex statically bundles every module under V8 first.
- ESLint `OWNERSHIP` map gains `pos_receipt_html_cache: "receipts"`. (Initial implementation allowlisted the `receipts` module for aggregate cross-module reads; the v0.5.1 PR A triple-review pulled it back inside ADR-034 boundaries — see refactor bullet below — and the allowlist exemption was removed.)
- Refactor: `_confirmPaid_internal` mints `receipt_token` inline via the shared helper rather than threading a caller-minted token through every call site (the V8-safe tokens.ts unblocked this simpler design vs. the plan's original arg-threading approach).
- Refactor (in response to triple-review): receipts module no longer reaches into `pos_transactions` / `pos_transaction_lines` / `pos_xendit_invoices` directly. Reads route through `transactions/internal._getPaidTxnWithLinesForReceipt_internal`, `transactions/internal._getPaidTxnWithLinesByToken_internal`, and `payments/internal._getPaidInvoiceForTxn_internal` per ADR-034. The lazy-mint patch routes through `transactions/internal._ensureReceiptTokenForPaidTxn_internal`. ESLint ALLOWLIST `receipts` entry removed. `payment_method` is now read from `pos_xendit_invoices.method` (mapped `"QRIS"` → `"QRIS"`, `"BCA_VA"` → `"BCA VA"`) instead of hardcoded `"QRIS"` — BCA VA receipts now display correctly. RRN (`receipt_id`) is surfaced when present.

### Post-triple-review simplify pass

- `/r/<token>` httpAction: trailing-slash tolerance (`/r/abc/` resolves to `"abc"` — Telegram + iOS Share Sheet commonly append trailing slashes); cache-write failure no longer escalates a renderable receipt into a 500 (try/catch + log); inline `"private, max-age=300"` replaced with the named `CACHE_CONTROL_VALUE` constant.
- `_getPaidInvoiceForTxn_internal`: dropped the `cancelled_at === undefined` filter so a paying invoice cancelled by PR B's refund flow still surfaces its `method` + RRN on the receipt. Sort by `created_at` desc — most recently created invoice wins.
- `_getPaidTxnWithLinesByToken_internal`: `.unique()` → `.first()`. 32 bytes of entropy makes token collisions corruption-grade, and a public route should serve the matching receipt rather than 500 on a theoretical duplicate.
- Defensive guards: `template.rp()` returns `"Rp —"` for non-finite money (no `"Rp NaN"` on a customer receipt); `lib/time.formatWibDateTime()` returns `"—"` for non-finite ms; `mintUrlSafeToken()` throws on non-integer or zero/negative byte counts.
- Voucher row in `template.ts` now renders whenever `voucher_discount > 0`, even if `voucher_code` is missing — silent gap between subtotal and total is worse than an em-dash code placeholder.
- Receipt-token mint funnel consolidation: `_ensureReceiptTokenForPaidTxn_internal` now owns existing-token check, CSPRNG mint, patch, AND audit emit. The lazy wrapper in `receipts/internal.ts` collapses to a thin facade. Any future direct caller (v0.5.3 "resend receipt") gets the audit row automatically. CSPRNG bytes are no longer minted on the existing-token branch.
- Tests: +7 (`/r/<token>` trailing slash, paying-invoice survives cancellation, voucher with missing code, NaN money render, NaN/Inf timestamp format + happy-path datetime, `mintUrlSafeToken` positive-byte guard).

### Rollback caveat (PR A)

Reverting PR A leaves orphan `receipt_token` values on already-confirmed transactions; the public route 404s for them. Tokens are stable (field is optional, immutable when set) so re-deploying PR A restores access without migration.

### PR B — refund subsystem + settlement surface (shipped 2026-06-01)

- Full refund flow: staff initiate, manager approves (inline PIN at booth, OR Telegram URL+PIN off-booth per ADR-035), refund logged as a new row (ADR-008).
- Stock re-credited automatically on refund commit (positive movements, `source: "refund"`, per ADR-019). Spoilage flow deferred to v0.5.2.
- Voucher attribution on partial refunds: proportional, floor-rounded (ADR-040, drafted on main pre-PR-B). Single helper `computeRefundAmount(line, txn, refundQty)` used by both `_commitRefund_internal` and the receipt-template net-retained math. The /refund form's live preview total uses the same single-floor formula client-side so the displayed total matches the eventual committed amount.
- Receipt auto-reprojects on refund commit (purge-on-commit per ADR-039); the original `receipt_token` stays stable across refunds, so the customer's saved URL always reflects current state.
- Settlement tracked separately via `settlement_status: pending → settled` per ADR-038. `markRefundSettled` is **manager-session gated** (NOT PIN). `/mgr/refunds-pending` is the FIFO settlement surface — managers process the bank transfers in batch.
- New approval kind `refund` wired through the 4-touchpoint pattern (schema literal, `kinds.ts`, Telegram template, `/approve/:token` UI).
- New audit verbs: `refund.requested`, `refund.committed`, `refund.denied`, `refund.settled`.
- New routes: `/refund` (today's recent list), `/refund/:txnId` (refund form), `/mgr/refunds-pending` (settlement surface).
- `src/lib/format.ts` `rp()` handles negative amounts (`rp(-43333) === "-Rp 43.333"`) for refund-summary displays.

## v0.5.0.1 — Housekeeping hotfix (2026-05-31)

> The squash commit for this work landed on `main` titled `v0.5.1 — Housekeeping (#7)`. Renumbered here to `v0.5.0.1` so `v0.5.1` can refer to the **Refunds + customer receipts** feature phase (the canonical use in `docs/PROGRESS.md`, ADR-038, ADR-039). The git history is fixed; this header is the source of truth for the version label.

### Security
- `_resolveSession_internal` now also rejects sessions whose underlying staff record is deactivated, matching `requireSession()` semantics. Closes a parity gap where a deactivated staff with an open session row could still authorise cross-module mutations (cart commit, awaiting-payment list, approvals). Cross-module callers (transactions, approvals) get the same authorisation surface as in-module callers. Dedicated unit tests cover all three rejection branches (missing/ended session, missing/inactive staff).

### Known follow-ups (deferred to v0.5.2)
- No runtime mutation to deactivate staff exists today, but once one ships, the charge screen's `onCancelPaymentForBlocker` will need to handle the new `SESSION_INVALID` re-throw (currently only swallows `TXN_NOT_AWAITING`). Without that, a staff deactivated mid-payment can't cancel an awaiting QR/VA from the abandon-cart dialog. Surface a "session invalid → redirect to /lock" path at that time.

### Internals
- `useDeviceId.ts` `LS_KEY` migrated to `DEVICE_ID_KEY` in `src/lib/storage-keys.ts`; the literal `"frollie-device-id"` now appears exactly once in the source tree.
- 4 sale-route test files now import `SESSION_KEY`, 3 lock/login test files now import `LAST_STAFF_KEY` (8 bare-literal sites swapped). Combined with the `useDeviceId` migration above, every localStorage key string used by the app now appears exactly once in source (in `src/lib/storage-keys.ts`).
- Dropped unused `by_role_archived` compound index from `telegramChats`. The schema test was first rewritten to mirror the production bare-`by_role` + JS-post-filter pattern (Convex optional-field filter gotcha workaround), and strengthened with an archived sibling row so the predicate isn't trivially satisfied. One stale test-description string referencing the index also renamed. `docs/SCHEMA.md` and `docs/ADR/037` updated to reflect the new index shape.
- Extracted `usePathChangeBlocker(when: boolean)` hook (`src/hooks/usePathChangeBlocker.ts`); collapsed two duplicated `useBlocker` + `useCallback` predicate blocks in `/sale` and `/sale/charge` to one-liner call sites. Wraps the predicate in `useCallback` so the Blocker stays referentially stable (v0.5.0 LESSON 4).
- `eslint-plugin-react-hooks@5.1.0` now wired in `eslint.config.js` for `src/**/*.{ts,tsx}` — `rules-of-hooks: error`, `exhaustive-deps: warn`. Existing code passes cleanly with zero findings.
- Scoped out the proposed `useEffectOnce` extraction — the three `useRef(false)` call sites (`useCatalogCache.liveSeenRef`, `login.hasPreStaged`, `ApprovalPending.called`) implement three different patterns (race-guard between two effects / conditional-once-with-retry / once-on-terminal-status). A single hook would hide their conditions. See MEMORY.md lesson #10.

## v0.5.0 — App shell + session ergonomics + v0.4 stabilizers (2026-05-31)

### App shell
- Sticky header chrome on every spoke route with back-to-home affordance
- Cart-abandon dialog on /sale (Save as draft / Discard / Cancel)
- Cancel-payment dialog on /sale/charge (Cancel payment / Keep waiting); cancels via new `cancelAwaitingPayment` mutation
- Navigation interception via React Router's `useBlocker` catches header back, browser back, and Android gesture-back uniformly
- Lock route + lock-resume UX: /login pre-stages to the previous staffer's PIN; silent fallback to staff list if deactivated

### Security hardening
- Per-token PIN attempt cap (5 attempts) on /approve/:token actions. **Operator note:** the cap counts ALL failures — legitimate manager fumbles count too. A revoked approval requires retry from scratch (mints a fresh token).
- ESLint rule `idempotency-required` enforces `idempotencyKey` + `withIdempotency` + `authCheck` on every public mutation
- All existing public mutations refactored to canonical authCheck-in-options pattern; auth now runs BEFORE the idempotency cache lookup

### Stabilizers
- ApprovalPending overlay auto-flips on denied status
- Cancel-sale cancels any pending Telegram approval for the txn (via shared `_cancelPendingManualPaymentForTxn_internal` helper)
- Booth manager-PIN override accepts any active manager's code (not just the logged-in session)
- Awaiting-payment countdown on /sale/charge driven by invoice expiry
- New `cancelPendingRequest` manager mutation for cleaning up stuck approvals
- `getRecentPinResetForStaff` no longer re-fires success toast on fresh sessions
- Founders summary cron eliminates role-rebind race window
- KIND_AUDIT verbs are now per-kind (`staff_pin_reset.resolved`, `manual_payment_override.resolved`). **Audit cutover:** pre-v0.5.0 rows use the old generic verbs; v0.5.0+ rows use per-kind verbs. Dashboard queries in v0.5.3 read the new shape; historical queries need both.
- `telegramChats` archived-filter rewritten to JS post-filter (closes documented prod gotcha)

### Internals
- `effectiveStatus(row)` helper centralises the four-state lifecycle derivation
- `chatRegistry.ts` split into `chatRegistry/public.ts` + `internal.ts` per ADR-034
- localStorage keys centralised in `src/lib/storage-keys.ts`; `storeSession(sessionId, staffId)` writes both atomically

## 2026-05-29 — Tooling: CEO Progress Report cutover

- Retired the in-tree `scripts/build-progress-html.mjs`; the rendered board is now built by the published `ceo-progress-report` npm package (added to devDependencies).
- New build command: `npx ceo-report build --src docs/PROGRESS.md --out docs/progress.html`, configured via `buildlog.config.mjs` at the repo root (title/monogram/location/lanes).
- Output verified functionally identical to the in-tree renderer (only cosmetic masthead/meta strings differ).
- Closes the post-extraction "retire the in-tree script" commitment from the 2026-05-27 extraction plan.

## 2026-05-28 — Xendit inline payments fix (v0.3)

- QRIS now uses the Xendit QR Codes API (inline scannable QR) instead of the Invoice API
- BCA VA now uses the Virtual Accounts (FVA) API for an inline VA number (live-unverified)
- Webhook parses the QR Codes v2 shape (`data.status: "SUCCEEDED"`, match on `qr_id`); always-200 + 401-on-missing-config
- Retired QRIS status polling + poll-based reconciliation; webhook + manager override are the confirmation paths
- Captured RRN (`receipt_id`) + paying `payment_source`; added `PAYMENT_AMOUNT_MISMATCH` flag
- ADR-036 supersedes ADR-011, adjusts ADR-014, amends strategic-foundations §8 + ADR-026

## 2026-05-27 — Tooling: CEO Progress Report extraction

- Extracted PROGRESS.md → progress.html renderer from `scripts/build-progress-html.mjs` into a standalone, installable package at `packages/ceo-progress-report/`.
- Package bundles: Node CLI (`ceo-report init`, `ceo-report build`), Claude Code plugin with two skills (`buildlog-author`, `buildlog-review`) and two slash commands, starter templates, GH Action workflow.
- Frollie POS continues using the in-tree script for v0.3 work; migration to the published package planned post-v0.3 (hard commitment — see plan Risks).
- npm publish + Claude Code marketplace submission deferred to follow-up tasks.

## Unreleased

### Architecture

- **ADR-034 accepted: deep modules with surface APIs as architectural blueprint.** Frollie POS commits to a three-layer architecture: (1) internal module boundaries in `convex/<module>/{public,internal,schema}.ts`, (2) external API surface under `convex/api/v1/` with versioned httpActions + bearer-token auth, (3) POS internal schema is private and free to evolve. Supersedes [ADR-000 §1](./ADR/000-strategic-foundations.md#1-shared-convex-project-with-product_master) (shared Convex project) — POS owns separate Convex deployments. Integration with Frollie Pro happens via HTTP contract, not schema mirroring. New "Arch" group added to ADR index. CLAUDE.md "Mirror Frollie Pro" directive relaxed for data shape (still applies to stack choices). Implementation deliverable: follow-up `v0.6-architecture-restructure` planning phase (not yet started). Review: `docs/reviews/staffreview-adr-034-deep-modules-2026-05-26.md`.

### POC

- Telegram bot integration playground at `/dev/telegram`. Sends approval / shift summary / custom messages via Convex action `telegram:send:sendTemplate`; receives button-press callbacks via `httpAction` at `/telegram-webhook`. Sandbox table `telegram_log`. Vitest + convex-test coverage for HTML escape, template renderers, and webhook (security + dedupe). Spec: `docs/superpowers/specs/2026-05-25-telegram-poc-design.md`. Does NOT replace ADR-027 / ADR-033 yet.

## [0.4.0] — 2026-05-30

Telegram graduation: the v0.3 Telegram POC becomes the primary off-booth approval channel. v0.4 ships the manual-payment override approval flow, the self-registration chat registry, the founders shift-summary cron, and the `APPROVAL_KINDS` extensibility registry.

### Added

- **Off-booth manual-payment approval flow** (`manual_payment_override` kind). Staff on the charge screen can request off-booth manager approval when no manager is present. The flow: `requestManualPaymentApproval` → Telegram card with URL button to `/approve/:token` → manager opens link (VIEW) + enters PIN (ACT) → `approveManualPayment` resolves the request and confirms the transaction, or `denyRequest` (kind-agnostic deny) closes it. The charge screen subscribes reactively via `useApproval` + `ApprovalPending`.
- **`APPROVAL_KINDS` registry** (`convex/approvals/kinds.ts`) — `ApprovalKind` union, `validateContext` (single-writer invariant for per-kind context payloads, enforces ADR-015 integer rupiah), `KIND_AUDIT`, `KIND_TEMPLATE`. The canonical mechanism for adding a new approval kind (see "How to add a feature" #8 in CLAUDE.md).
- **Telegram self-registration** — `telegramChats` + `telegramUpdates` tables; `/register` and `/start` bot commands wired via `buildRegistryCommands`; `getChatIdByRole` routes `sendTemplate` to the bound role chat with `TELEGRAM_CHAT_ID` as env-fallback during initial setup; `seedChatFromEnv` one-shot migration bootstrap.
- **Manager-gated `/mgr/telegram-chats` admin route** — lists registered chats, lets a manager assign/reassign roles (`managers` / `founders`), archive/restore chats, send test messages, and toggle the founders-summary setting. Calls `api.telegram.chatRegistry.public.mgrListChats` / `mgrAssignRole` / `mgrArchiveChat` / `mgrRestoreChat` / `mgrSendTest`. *(updated to reflect v0.5.0 chatRegistry split)*
- **Founders daily shift-summary cron** (22:00 WIB / 15:00 UTC) — `sendFoundersSummaryResilient` wraps `sendFoundersSummary` with linear back-off retry (up to `RESILIENT_MAX_ATTEMPTS`). Non-transient errors and unbound `founders` role produce an audited skip (`founders.summary_skipped`), not a retry storm. Registered in `convex/crons.ts`.
- **`useApproval` reactive hook** (`src/hooks/useApproval.ts`) — wraps `approvals.public.getRequestStatus` reactive subscription + `requestManualPaymentApproval` action dispatch + IDB-backed idempotency key lifecycle. Used by `ApprovalPending` and the charge screen.
- **`ApprovalPending` reusable component** (`src/components/pos/ApprovalPending.tsx`) — approval-pending overlay that renders pending / resolved / denied / expired states reactively, with per-state CTA.
- **`pos_settings` singleton table** (`convex/settings/`) — `founders_summary_enabled` toggle (defaults `true` if the row is absent). `getSettings` (public query) + `setFoundersSummaryEnabled` (manager-gated mutation, audits `settings.founders_summary_toggled`).

### Changed

- **`pos_approval_requests` schema generalized** — new kind `manual_payment_override`; generic `entity_type` / `entity_id` pointer; per-kind `context` payload (validated by `validateContext`); `denied` terminal state + `denied_at` / `denied_by_manager_id` / `deny_reason` fields; `telegram_message_id` / `telegram_chat_id` linkage for message-edit on resolve.
- **`sendTemplate`** is now role-routed (calls `getChatIdByRole` instead of reading `TELEGRAM_CHAT_ID` directly) + typed payload union + action-level idempotent + audited send-failures (`telegram.send_failed` via `_auditSendFailed_internal`).
- **`convex/http.ts`** `/telegram-webhook` route rewritten — uses `buildHandleTelegramWebhook` + `buildRegistryCommands`; replaces the v0.3 POC callback handler. `allowed_updates` for `setWebhook` must now include `"message"` in addition to `"callback_query"` so `/register` commands are delivered.
- **`_confirmPaid_internal` / `_onPaidManual_internal` / `_markResolved_internal`** thread an explicit `source` arg so off-booth flows audit as `telegram_approval` instead of defaulting to `booth_inline`.
- **`approveStaffPinReset`** audit source updated from `wa_approval` → `telegram_approval` (reflects the actual delivery channel; the `wa_approval` literal is retained in the schema for historical rows from v0.3 but production code no longer emits it).

### Deprecated / removed

- **`/dev/telegram` POC playground** — retired. `convex/telegram/queries.ts` removed. The POC `callback_data` inline-button handler in `webhook.ts` replaced by the URL-button `/approve/:token` pattern (ADR-037).
- **`TELEGRAM_CHAT_ID` as the primary routing mechanism** — demoted to env-fallback only. Role-bound chats in `telegramChats` supersede it. Keep the env var set during initial setup and prod cutover (see RUNBOOK).

### Notes

- All schema changes are additive — per-wave `git revert` is clean; no migrations required.
- The v0.3 POC `callback_data` approach is replaced by URL buttons. Reason: URL buttons require no bot-side state to resolve; the token in the URL carries the full auth context (ADR-037).
- The `setWebhook` endpoint must be re-called after deploy to update `allowed_updates` to include `"message"`. Dev deployment webhook URL: `https://helpful-grasshopper-46.convex.site/telegram-webhook`.
- 444 tests passing at merge (29 commits on `feat/v0.4-telegram-approval`).

## [0.3.0] — 2026-05-27

The first end-to-end sale. v0.2 shipped auth + catalog; v0.3 makes the booth able to take money.

### Added

- **Sale flow (cart → commit → charge → receipt).** New `transactions/` module: `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters`. Cart is committed (`draft → awaiting_payment`) snapshotting product code, name, unit price, and tax rate onto each line (never re-joined for price per [ADR-015](./ADR/015-idr-integer-rupiah.md) + business rule #1). Receipt number `R-YYYY-NNNN` allocated atomically inside `_confirmPaid` against a **WIB-calendar-year** counter ([ADR-023](./ADR/023-receipt-number-format.md)). Routes: `sale/index` (cart), `sale/charge` (method + invoice), `sale/charge-success` (receipt).
- **Xendit charge (QRIS + BCA VA).** New `payments/` module: `pos_xendit_invoices` audit table (one row per invoice, `by_xendit_invoice_id` for webhook dedup). Invoice creation records the `X-IDEMPOTENCY-KEY` sent to Xendit. Single active invoice per transaction — prior invoice cancelled via Xendit API on cart-edit retry, the superseded id linked via `replaced_by_invoice_id` ([ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)). Webhook at `convex/payments/webhook.ts` with mandatory signature verification.
- **Three-path payment confirmation** ([strategic foundations §8](./ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)): webhook (primary), polling fallback, and manager manual-override. The chosen path is recorded on `pos_transactions.confirmed_via` (`webhook | polling | manual`); manual override also records `confirmed_mgr_approver_id` + `confirmed_manual_reason`.
- **Reconciliation on reload** ([ADR-026](./ADR/026-reconciliation-on-reload.md)): `useStartupReconciliation` re-checks any recent `awaiting_payment` transaction with Xendit on startup. The `pos_stock_movements.by_line_and_sku` index gates against a double-decrement (one sale movement per transaction-line + SKU).
- **Drafts.** Cart can be saved and resumed; the committed-but-unpaid transaction is the draft (`status: "draft"`). Route `sale/drafts`. `useOfflineQueue` queues commits offline; payments/auth still block offline ([ADR-025](./ADR/025-service-worker-cache.md)).
- **Vouchers.** New `vouchers/` module: `pos_vouchers` (discount carried inline as `type` + `value`; no separate `pos_discounts` table yet) and append-only `pos_voucher_redemptions`. One voucher per transaction enforced via `by_transaction` ([ADR-010](./ADR/010-no-voucher-stacking.md)); no stacking. Over-redemption past `max_redemptions` is flagged (`voucher.over_redeemed`), not hard-blocked. Route `sale/voucher`.
- **Stock decrement on sale.** New `inventory/` module owns `pos_stock_movements` + `pos_stock_levels` (both **moved out of `catalog/`** per [ADR-034](./ADR/034-deep-modules-surface-apis.md)). A sale writes a signed-negative `pos_stock_movements` row (`source: "sale"`) per consumed inventory SKU. Negative stock is allowed and flagged via `pos_transactions.flags |= NEG_STOCK`, not blocked ([ADR-018](./ADR/018-negative-stock-allowed-flagged.md)).
- **PIN management.** `auth.changePin` (self-service, verifies current PIN), `auth.resetStaffPin` (manager at booth resets a staff PIN by proving the manager's own PIN), and the off-booth path below. All three converge on a single internal funnel `_changePinCommit_internal` (actor `self` → `staff.pin_changed`; actor `manager_reset` → `staff.pin_reset` + lockout unwind). `staff.bootstrapped` audited on seed-created staff.
- **Off-booth PIN-reset approval via Telegram** ([ADR-035](./ADR/035-telegram-as-internal-comms.md), [ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md)). New `approvals/` module: `pos_approval_requests` (kind `staff_pin_reset` only in v0.3; capability token collapsed onto the row as `token_hash` + `token_expires_at`, no separate `pos_approval_tokens` table). A 3-strike lockout schedules `notifyStaffLockout`, which posts a single-use 60-minute link to the managers' Telegram group; a manager opens `/approve/:token` (token authorises VIEW) and resets the PIN by entering their own PIN (PIN authorises ACT). Dedup guard skips a second notification while a live request exists; a failed Telegram send deletes the stuck pending row so the next cycle retries cleanly.
- **Frontend hooks:** `useCart`, `useOfflineQueue`, `useXenditPayment`, `useStartupReconciliation`. `useIdempotency` upgraded to IDB-backed persistence so a reload mid-payment doesn't double-execute.
- **Frontend components:** `src/components/pos/PinSheet` — reusable PIN-entry sheet (built on `NumericKeypad`) used by change-PIN, manager reset, and the `/approve/:token` landing.

### Changed

- **`docs/SCHEMA.md`** documents the 8 v0.3 tables with their **actual shipped shapes** (which are leaner than the previously-written v0.5 design specs) and adds the v0.3-emitted `audit_log.action` strings. Module-ownership table gains `inventory/`, `transactions/`, `payments/`, `vouchers/`, `approvals/`.
- **`CLAUDE.md`** file-locations, business-rules, auth, and how-to-add-a-feature sections updated for the new modules, hooks, routes, the `_changePinCommit_internal` funnel, and the add-an-approval-KIND recipe.

### Shipped-vs-planned divergences (so the docs reflect reality)

- `pos_transactions` ships without line-level discounts, manual discount sources, per-line tax aggregation, void provenance, `receipt_token`, or customer fields — those remain v0.5 design. v0.3 status union is `draft | awaiting_payment | paid | cancelled` (no `voided` yet).
- `pos_transaction_lines` uses `*_snapshot`-suffixed fields (`product_code_snapshot`, `product_name_snapshot`, `unit_price_snapshot`, `tax_rate_snapshot`) and omits `line_discount` / `tax_amount` / `line_total` / `refunded_qty`.
- `pos_stock_movements` references `source_transaction_line_id` (an `Id`) and uses the `by_line_and_sku` index for ADR-026 dedup rather than a unique `(ref_type, ref_id, sku)` constraint; `inventory_sku_id` (not `sku_id`) is the FK name.
- `pos_stock_levels.last_movement_id` stays `v.string()` (not `Id<>`) in v0.3 to avoid schema-validation rejection on legacy dev rows; reconciled at prod cutover.
- `pos_vouchers` carries the discount inline (`type` + `value`) instead of via a `pos_discounts` FK; `created_by_staff_id` is optional (dashboard-created vouchers have no staff context).
- `pos_approval_requests` ships the token **on the request row** (no `pos_approval_tokens` table) and a single `kind` (`staff_pin_reset`); the off-booth comms channel is **Telegram** ([ADR-035](./ADR/035-telegram-as-internal-comms.md)), superseding the wa.me model ([ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md)) for this flow.

### Notes

- **ADR-035 accepted: Telegram as the internal comms channel.** The off-booth PIN-reset link is delivered via the managers' Telegram group, graduating the v0.2 Telegram POC. Supersedes the wa.me share-intent model ([ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md)) for v0.3's approval flow.
- Tokens authorise VIEW; PINs authorise ACT ([ADR-029](./ADR/029-token-authorizes-view-pin-authorizes-act.md)). Token = 32-byte URL-safe random, SHA-256-hashed at rest, single-use, 60-minute TTL.
- A locked-out manager can still approve their own off-booth reset link — the token + correct PIN are sufficient authority (lockout state is deliberately not re-checked on the approve path).

## [0.2.1] — 2026-05-26

### Changed (Architecture restructure per ADR-034)

- **`convex/` reorganised into module layout.** Flat files (`auth.ts`, `staff.ts`, `products.ts`, `audit.ts`, `idempotency.ts`, `seed.ts`, `authActions.ts`, `seedActions.ts`) migrated into `convex/<module>/{public,internal,actions,sessions,schema}.ts` shape. Schema composed from per-module fragments via spread. No business behavior changed.
- **Backwards dependency removed:** `audit` no longer imports from `staff`. Session helpers (`requireSession`, `requireManagerSession`) extracted to `convex/auth/sessions.ts`; both `audit/` and `staff/` consume them.
- **Frontend API namespace migrated:** all `api.<module>.<fn>` references became `api.<module>.public.<fn>` (or `.actions.<fn>` for Node-runtime actions). 5 frontend files updated.

### Added

- **Module-boundary CI lint:** custom ESLint rule `no-cross-module-db-access` (`tools/eslint-rules/`) blocks PRs that touch tables owned by another module directly. Foundational modules (`auth`, `idempotency`, `audit`, `seed`, `staff`, `_codes`) allow-listed. First ESLint config in the repo (`eslint.config.js`).
- **Schema composition pattern:** `convex/schema.ts` now spreads `authTables`, `catalogTables`, `idempotencyTables`, `auditTables`, `telegramTables` from per-module `schema.ts` fragments.
- **Stable string identifiers** (per ADR-034) — **shipped as optional fields in v0.2.1**: `staffCode` (`S-NNNN`) on `staff`, `productCode` (UPPERCASE_SNAKE + `_<N>PC`) on `pos_products`, `componentCode` (UPPERCASE) on `pos_inventory_skus`. All three indexed (`by_code`). Seed allocates them for the 5 standard staff + 5 components + 7 products; format conformance tests in `convex/_codes/__tests__/`. **v0.3 promotes to required** once `createStaff` / future `createProduct` mutations gain allocation logic — see deferral note in this CHANGELOG section.
- **External API scaffold:** `convex/api/v1/{_auth.ts,README.md}` placeholders. No endpoints yet (deferred to v0.3 with first transaction endpoint).
- **`docs/PUBLIC_API.md`:** stub external contract doc.

### Deferred to later phases (per `docs/v0.2.1-restructure-scope.md` §5 + staffreview Critical #2)

- **Flip `code` fields to required** → v0.3. Requires `createStaff` to allocate codes (and future `createProduct` / `createComponent`). Cascades through `_seedStaffCommit_internal`, `_createStaffCommit_internal`, and raw test inserts — too many call sites to update safely in v0.2.1's restructure scope.
- External API endpoints (`/api/v1/transactions`, etc.) → v0.3
- Bearer-token implementation (`api_tokens` table, argon2id storage, rotation, rate limiting) → v0.3
- Full PUBLIC_API.md endpoint specs → v0.3 (first endpoint)
- API contract snapshot tests → v0.3
- Telegram POC graduation to `approvals/` module → v0.4
- PII scope enforcement tests → v0.3
- `audit_log.source` enum addition for `"api_consumer"` → v0.3

### Docs

- `docs/SCHEMA.md` reframed as POS-internal (pointer to PUBLIC_API.md for external contract).
- `CLAUDE.md` file-locations section rewritten to module paths.
- ADR-034 amended (§"Cross-module patterns — Audit logging") to clarify `logAudit` is a plain helper, not an `internalMutation`.

## [0.2.0] — 2026-05-26

### Added

- **Convex backend (v0.2 subset, runtime-split per ADR-004):**
  - V8 runtime — `convex/auth.ts` (getActiveStaff, getSession, _getStaffPinHash_internal, _getLockState_internal, _recordFailedAttempt_internal, _loginCommit_internal, logout, _seedStaffCommit_internal), `convex/staff.ts` (listStaff, isDeviceRegistered, generateDeviceSetupCode, activateDevice, _createStaffCommit_internal), `convex/products.ts` (catalog), `convex/audit.ts` (logAudit, list), `convex/idempotency.ts` (withIdempotency, _lookup_internal), `convex/seed.ts` (commit-side seed mutation + count query).
  - Node runtime — `convex/authActions.ts` (loginWithPin action, createStaff action, _hashPin_internal, _seedHashedStaff_internal), `convex/seedActions.ts` (reset internal action).
- **Schema:** staff, sessions, devices, **pending_device_setups (new)**, auth attempts, inventory SKUs, products, components, stock levels, audit log, idempotency.
- **Auth stack:** argon2id PIN hashing via Node action (ADR-004), 3-strike 60-second lockout (ADR-002), shared device sessions (ADR-003), manager-only gates on staff/device CRUD (ADR-005). Failed-attempt state is persisted in a separate non-throwing mutation so lockout survives the throw — Convex mutations are transactional and a throw rolls back the entire mutation's writes.
- **Device registration (strategic §6):** `staff.isDeviceRegistered` query backing the RootLayout gate; setup codes use `crypto.getRandomValues()` not Math.random; pending setups live in their own table.
- **Frontend hooks:** `useDeviceId` (localStorage + IDB backup), `useSession`, `useIdempotency`, **`useCatalogCache` (new — IDB-backed offline catalog per ADR-025).**
- **Frontend lib:** `format.ts` (Rp formatter + Jakarta-tz date helpers).
- **Frontend layout:** ConnDot connection indicator (subscribed, not polled), RootLayout session+device gate using the real `isDeviceRegistered` query, DeviceActivation flow at the public `/activate` route.
- **Login screen** (LoginA wireframe pattern): staff list → PIN entry with NumericKeypad. Toast errors translate `LOCKED_OUT` / `INVALID_PIN`.
- **HomeNav launcher** (HomeNav wireframe): role-aware tile grid (SELL / STOCK / YOU / MANAGER) + Lock button. Tiles for non-v0.2 destinations link to their stubs. Catalog reads from `useCatalogCache(useQuery(catalog))` so cold starts work offline.
- **Test infrastructure:** vitest + jsdom (frontend) + edge-runtime (backend, via `environmentMatchGlobs`) + Testing Library + convex-test + fake-indexeddb. `npm test` runs all suites.
- **Plan rigor:** entry follows TDD (red → green → commit) per task; every public mutation accepts `idempotencyKey`; every state-changing mutation writes an audit row.

### Changed

- `docs/SCHEMA.md` audit enum gains `device.setup_code_issued`, `seed.reset`. `pos_idempotency.staff_id` documented as optional.
- `vite.config.ts` runtimeCaching adds a defensive `NetworkOnly` rule for `/api/*` (Convex traffic is WebSocket — this is purely defensive against any future Convex REST endpoint being inadvertently cached).

### Fixed during execution

- **Task 5 plan flaw:** the original plan had `_loginCommit_internal` write to `pos_auth_attempts` then throw `INVALID_PIN` / `LOCKED_OUT`. Convex mutations are transactional, so the throw rolled back the failed-attempt write — lockout never persisted. Fix: split into `_recordFailedAttempt_internal` (commits) + action-side throw. The action orchestrates: cache lookup → staff fetch → lock-state check → argon2 → record-failed-or-commit-success.

### Deferred

- v0.3 — `useIdempotency` IDB persistence (so reload-mid-payment doesn't double-execute), `withIdempotency` error caching design re-evaluation, payments + cart + drafts.
- v0.5 — full manager portal (`staff.resetPin`, `staff.deactivateStaff`, `staff.updateStaff`) — v0.2 only needs `createStaff`.
- v0.6 — Playwright E2E covering offline catalog hydration + device activation.

### Notes

- v0.2 ships with no payments, no cart, no refunds — those land in v0.3.
- Default seeded PINs: staff `0000`, manager (Lucas) `9999`. Reset via `npx convex run seedActions:reset` (internal action; not callable from public clients).
- Dev uses a separate Convex deployment from the shared `product_master` prod deployment. v1.0 merges to the shared deployment.
- The auth runtime split (`auth.ts` V8 / `authActions.ts` Node) is the canonical answer to Convex's "actions ≠ mutations" constraint; ADR-004's "verify in an action" is honored end-to-end.

## [0.2.0-baseline] — 2026-05-25

The repository's initial GitHub commit. **Scaffolding + cleaned documentation only.** No backend yet, no implemented screens beyond route stubs.

### Added

- **Project scaffolding** (Vite 6, React 19, TypeScript, Tailwind CSS 4 with `@theme` CSS config, shadcn/ui new-york stone, Convex 1.31.7, React Router v7, Sonner, Framer Motion, vite-plugin-pwa).
- `src/index.css` carrying the Frollie design tokens (Inter font, Frollie teal palette, success/warning/error/info, role/channel/station colors, easing + duration tokens) — mirrors the Frollie Pro design system.
- `src/router.tsx` declaring the full route table from the wireframe IA (login, home, sale + drafts/voucher/charge/charge-success, stock + in, lock, refund, history, settlements, wait, mgr/* (home/dashboard/products/receipt), approve/* (PUBLIC landing + pin), receipt (PUBLIC `/r/:n`)).
- `src/components/layout/RootLayout.tsx` + `Stub.tsx` — minimal app shell + placeholder pages for routes implemented in later phases.
- **`src/components/ui/` shadcn primitives** (new-york style, stone base, tuned to Frollie teal): `button`, `badge`, `card`, `input`, `label`, `separator`, `dialog`, `dropdown-menu`, `popover`, `select`, `switch`, `tabs`, `tooltip`, `progress`, `scroll-area`, `sonner` toast. Plus `src/lib/utils.ts` `cn()` helper.
- **`src/components/pos/NumericKeypad.tsx`** — POS-specific 3-col keypad (1-9, Clear, 0, Backspace) with keyboard listener (digits, Backspace, Escape). Two sizes via `size: "compact" | "comfortable"`. Used by both PIN entry (Login, ApprovePin) and quantity entry (StockIn, custom-qty cart edit).
- `.env.example`, `convex.json`, `index.html`, `.gitignore` (excludes `archive/` and `frollie-pos design files/`).

### Changed — Documentation

- **Replaced the 14 original ADRs with the 33 v0.5 implementation-focused ADRs** from the wireframe handoff registry (`frollie-pos design files/project/wireframes/handoff.jsx`). New numbering matches that registry one-to-one.
- **Consolidated the strategic decisions** from the original 14 (those not subsumed by the 33) into a single `docs/ADR/000-strategic-foundations.md`. Eight strategic notes: shared Convex project, Xendit + BCA VA over static, PWA over native, PPN schema-from-day-one, finished-goods-only scope, device registration, settlement second-stage model, three-path payment confirmation. See that doc's closing table for the explicit subsumed-vs-preserved map.
- **Rewrote `docs/SCHEMA.md`** for the v0.5 schema. New tables: `pos_inventory_skus`, `pos_products` (rewritten for pack-size), `pos_product_components` (join), `pos_drafts`, `pos_approval_requests`, `pos_approval_tokens`, `pos_idempotency`, `pos_settings`, `pos_xendit_invoices` (audit), `pos_auth_attempts` (lockout counter), `pos_receipt_counters` (atomic NNNN allocation). Renamed `pos_transaction_items` → `pos_transaction_lines`. Updated `audit_log` with `source` field + `mgr_approver_id` + `metadata`.
- **Updated `CLAUDE.md`** business rules section to reflect the 33 ADRs (negative-stock allowed + flagged, idempotency keys everywhere, WA approval routing, founders share, argon2id replacing bcrypt). Refreshed file locations to match the actual scaffolded layout.
- **Updated `README.md`** for the GitHub-baseline state: actual project tree, env vars including `APPROVAL_TOKEN_SECRET`, references to the wireframe bundle location.
- **Updated `docs/API_REFERENCE.md`** with the v0.5 function surface (`approvals.ts`, `products.ts`, `settings.ts`, `idempotency.ts`, drafts split out, etc.).
- **Updated `docs/WORKFLOW.md`** with WA approval testing notes + the v0.2 baseline release.
- **`docs/DECISIONS.md`** kept as legacy reference (the substance migrated to either the 33 ADRs or to `000-strategic-foundations.md`).

### Notes

- v0.2-baseline is **documentation + scaffolding only**. Implementation begins in Phase v0.2 proper (auth + catalog).
- Shared Convex deployment with `product_master` — coordinate schema changes with the Frollie Pro maintainer.
- The wireframe handoff bundle (`frollie-pos design files/`) and the original delivery zip (`archive/files.zip`) are kept locally as reference but excluded from the repo via `.gitignore`.

### Things that quietly *changed* (worth flagging)

- **bcrypt → argon2id** for PIN hashing. The original ADR-005 specified bcrypt cost 12; the v0.5 ADR-004 specifies argon2id with ~200ms tuned cost. Argon2id is memory-hard, GPU/ASIC-resistant, and the current OWASP recommendation. No backward-compat — there are no production PIN hashes to migrate yet.
- **`pos_transaction_items` → `pos_transaction_lines`** rename. Aligns with the wireframe and 33-ADR naming.
- **`pos_payments.status`** gains a `cancelled` value for explicit Xendit-invoice cancellation on cart-edit retry (ADR-014).
- **`audit_log`** gains `source`, `mgr_approver_id`, `metadata` fields. `actor_id` may now be the string `"system"` for reaper actions.
- **Receipt URL pattern** moved from `pos.frollie.com/r/{transaction_number}?sig={hmac}` (original ADR-style) to `frollie.id/r/{receipt_token}` (ADR-021) — token-as-capability rather than HMAC-signed number. Both unguessable; token is simpler.
- **Customer-receipt-by-WhatsApp** is now subsumed by the broader WA share-intent model used for manager approvals + founders summary (ADR-027). Same wa.me pattern across all three uses.
