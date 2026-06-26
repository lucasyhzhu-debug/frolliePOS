# CLAUDE.md

AI agent context for the Frollie POS repo. Read this first before touching code.

> **This file is a pointer, not a mirror.** Depth lives in `docs/` — ADRs (`docs/ADR/`), schema (`docs/SCHEMA.md`), the Convex function inventory (`docs/API_REFERENCE.md`), Telegram ops (`docs/RUNBOOK-telegram.md`), and reusable patterns (`docs/PATTERNS/`). When a rule below cites an ADR, the ADR is the full rationale.

## Documentation system — two living docs

Progress is tracked with two forward/back docs (the old `docs/PROGRESS.md` task board is **retired** as of 2026-06-25):

- **[`docs/ROADMAP.md`](./docs/ROADMAP.md)** — the **forward** queue: specs + plans, documented as we brainstorm them, before they're built. Read this to see what's next; the backlog, decisions awaiting CTO, and risks live here too.
- **[`docs/CHANGELOG.md`](./docs/CHANGELOG.md)** — the **back** record: shipped implementation, with dates + versions. The single source of truth for what exists.

**Workflow:** brainstorm a slice → record its spec/plan in ROADMAP → when it ships, add a dated+versioned CHANGELOG entry and remove it from ROADMAP. Don't reintroduce a task board (`/progress`, `/progress-update`, `ceo-report build` are no longer part of any workflow here).

**Versioning** (set at ship time by the CHANGELOG entry, named ahead of time by the roadmap):
- **Major feature → bump the minor:** `x.1 → x.2` (new user-facing capability / phase).
- **Sub-feature or fix → bump the patch:** `x.x.1 → x.x.2` (a slice, hotfix, or hardening pass within a feature).

## What this is

Internal POS for the Frollie booth (Pakuwon Mall). Single Android device, mobile web PWA, 2–3 staff with overlapping shifts. Digital payments only via Xendit (QRIS primary + BCA VA secondary). Sells Dubai chocolate cookies in multiple pack sizes (1pc, 3pcs, 8pcs, Mixed Box 4pcs). Not a revenue product — an internal tool to validate flows that fold into Frollie Pro.

**What it is NOT:** multi-stall, cash-handling, a recipe/kitchen-inventory system, customer-facing, or a Play Store app. (See [When to push back](#when-to-push-back).)

## Relationship to Frollie Pro

POS runs in its **own Convex project** — separate from [`product_master`](https://github.com/lucasyhzhu-debug/product_master). The relationship is logical, not infrastructural: POS tables (`pos_*`, `staff`, `staff_sessions`, `registered_devices`, `audit_log`) live in the POS deployment only. Mirror Frollie Pro for **stack choices**, but POS **data shape is independent** ([ADR-034](./docs/ADR/034-deep-modules-surface-apis.md)) — integration happens via a versioned HTTP API (`convex/api/v1/`), not schema mirroring. v1.1+ cross-deployment `products` sync is out of v1 scope. Stack deviations require an ADR.

## Stack

- **Convex 1.31.7** (serverless backend, real-time sync) · **React 19 + TypeScript + Vite**
- **Tailwind CSS 4** (CSS config in `src/index.css`) · **shadcn/ui** new-york/stone, tuned to Frollie teal
- **Framer Motion** · **React Router v7** (library mode) · **Vercel** (frontend) · **PWA** (`vite-plugin-pwa`)
- **Xendit** payments (QR Codes API for QRIS, FVA API for BCA VA — [ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md))
- **Sonner** toasts · **Zustand** (cart-build local state only) · **IDB** (offline queue)

Design tokens (Inter, phthalo canvas, teal primary, citrus accent, role/semantic colors) in `src/index.css`. **Phthalo-dark is the default theme** — mounted via a permanent `class="dark"` on `<html>`; `:root` is the enriched-light glare-gate fallback (remove the one class to flip). `@custom-variant dark` keys `dark:` utilities to the class. Theme is token-driven, so new surfaces inherit the dark canvas — use semantic tokens (`bg-card`, `text-muted-foreground`, `bg-success/15`, `text-citrus`), never raw Tailwind palette literals. Shared grid-stagger motion variants live in `src/lib/motion.ts`; guard every Framer Motion interaction with `useReducedMotion` (full no-op). See [ADR-047](./docs/ADR/047-phthalo-dark-design-system.md). Mirrors the Frollie Pro design system. Inline form-validation uses the `FieldMessage` primitive (`src/components/ui/field-message.tsx`, ADR-048) — the sanctioned channel for sync field errors (toasts stay for global/async only); a scoped ESLint `no-restricted-syntax` fence (the migrated-file registry in `eslint.config.js`) bans literal-arg `toast.error` in converted files. **v2.0 owner cockpit** adds a scoped `.theme-owner` token override on the cockpit canvas (applied by `RootLayout` on `/cockpit/*`) to distinguish the owner plane visually from the booth: **amber/gold** (bg `#231905`, card `#33270F`, accent `#E9B43C`) vs. booth phthalo-green + teal — see [ADR-052] and `docs/superpowers/specs/2026-06-23-cockpit-login-accent-mockups.html`. Cockpit UI uses the same semantic tokens, so the override re-themes it automatically.

## Business rules that affect code

Full rationale in the cited ADR. These are the "don't break this" constraints:

1. **Snapshot prices + names on transaction lines.** Never join `pos_transaction_lines` → `pos_products` for historical price; `unit_price` and `product_name_snapshot` are frozen at sale time.
2. **Audit log is append-only** — never update/delete an `audit_log` row ([ADR-007](./docs/ADR/007-audit-log-append-only.md)).
3. **PPN is 0 today, schema-ready for 11%.** Don't hardcode 0; read `pos_products.tax_rate` (default 0). Flip `pos_settings.is_pkp` at PKP threshold, no migration ([foundations §4](./docs/ADR/000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp)).
4. **Refunds are their own entity** — never mutate a paid txn's status to "refunded"; create a `pos_refunds` row, status computed on read ([ADR-008](./docs/ADR/008-refunds-as-new-rows.md)).
5. **Payment confirmation = webhook (primary) + manager-PIN manual override (fallback).** Polling retired for QRIS/BCA VA ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md)).
6. **Stock-in only at inventory-SKU level** — products never restocked directly; "Dubai 8pcs" decrements 8 from the `dubai` SKU ([ADR-016](./docs/ADR/016-product-inventory-separation.md)).
7. **Negative stock allowed at sale, flagged** — don't hard-block; set `pos_transactions.flags |= NEG_STOCK` ([ADR-018](./docs/ADR/018-negative-stock-allowed-flagged.md)).
8. **Stock-in is a logged movement, never a number edit** — every change writes a `pos_stock_movements` row with required `source` enum. `pos_stock_levels` is a nightly-reconciled cache.
9. **Manager-PIN required for:** refunds, voids of paid txns, manual payment override, ad-hoc discounts, stock adjustments, spoilage, settings edits, PIN resets ([ADR-005](./docs/ADR/005-manager-pin-one-off.md)). *Note: `recount` is a staff-allowed `source` distinct from PIN-gated `adjustment` (ADR-041); managers see recounts via Telegram.*
10. **Telegram routes off-booth manager-PIN gates** to **Frollie · Managers** via a single-use `/approve/:token` URL button ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md)). Audit `source` is `telegram_approval`; legacy `wa_approval` kept in schema for historical rows only.
11. **Tokens authorise VIEW; PINs authorise ACT** ([ADR-029](./docs/ADR/029-token-authorizes-view-pin-authorizes-act.md)). Token = 32-byte URL-safe random, single-use, 60-min TTL.
12. **Daily shift-summary** = daily cron (22:00 WIB). **v2.0 (Spec 4):** sends a business-wide **`owners`** rollup (with per-outlet breakdown) PLUS a per-outlet **`managers_daily_summary`** ([ADR-033](./docs/ADR/033-founders-shift-summary-share.md); the `founders` role was recast to `owners`). Opt-out via `pos_settings.founders_summary_enabled` (default true) — the owners rollup reads the **default outlet's** toggle; each outlet's managers summary reads **that outlet's** toggle. Audited skip, no retry storm.
13. **Vouchers are static**, manager-created/distributed; no stacking ([ADR-010](./docs/ADR/010-no-voucher-stacking.md)); cached offline, server re-validates on sync ([ADR-009](./docs/ADR/009-voucher-cache-offline.md)).
14. **All money as integer rupiah** — no floats/cents. Format via `Intl.NumberFormat("id-ID")` in `src/lib/format.ts` ([ADR-015](./docs/ADR/015-idr-integer-rupiah.md)).
15. **Server time wins** — every `_at` set via `Date.now()` inside the function, never client-supplied ([ADR-031](./docs/ADR/031-convex-server-time-wins.md)).
16. **PWA partial offline:** catalog/cart/drafts/stock-in queue; payments/auth/refunds block offline with clear UI ([ADR-025](./docs/ADR/025-service-worker-cache.md)).
17. **Reconciliation is manual-only for QRIS/FVA** — `useStartupReconciliation` is a no-op shell ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) amends [ADR-026](./docs/ADR/026-reconciliation-on-reload.md)). Double-decrement prevented by the `pos_stock_movements.by_line_and_sku` index (one `sale` movement per `(source_transaction_line_id, inventory_sku_id)`).
18. **PIN changes funnel through `_changePinCommit_internal`** — its 3 callers are `auth.changePin` (self), `auth.resetStaffPin` (booth), `approvals.approveStaffPinReset` (off-booth). Branch on `actor.kind`; never log PIN values; don't add a 4th reset path.
19. **`APPROVAL_KINDS` is the add-a-kind mechanism** — `convex/approvals/kinds.ts` (`ApprovalKind` union + `validateContext` switch + `KIND_AUDIT` + `KIND_TEMPLATE`). `validateContext` is the single-writer invariant. Keep schema/internal validators, Telegram renderer, and `/approve` UI in sync (see [How to add a feature](#how-to-add-a-feature) #8).
20. **Public mutations require `idempotencyKey` + `withIdempotency` + `authCheck`** ([ADR-013](./docs/ADR/013-idempotency-keys.md)). ESLint-enforced. The handler re-calls `require*Session(...)` so `authCheck` runs BEFORE the cache lookup; the duplication is intentional — don't collapse it. See [`docs/PATTERNS/idempotency-dual-call-authcheck.md`](./docs/PATTERNS/idempotency-dual-call-authcheck.md). Action-level caches (`withActionCache`) carry the same invariant via a required `authCheck` arg — see [ADR-046](./docs/ADR/046-action-cache-auth-before-lookup.md).
21. **`markRefundSettled` is manager-session, NOT manager-PIN** ([ADR-038](./docs/ADR/038-refund-settlement-manual-v1.md)) — it's a bookkeeping ack that the already-authorised transfer completed; moves no money. Still audited (`refund.settled`). Same logic guides any "tally what already happened" mutation.
22. **Manager-admin writes are tiered** (v0.5.3b): **manager-PIN** for identity/money (`createStaff`, `setStaffRole`, `deactivateStaff`, `createProduct`, `updateProductPricing`, `createInventorySku`); **manager-session** for low-stakes config (`updateStaffName`, `updateProductMeta`, `setProductComponents`, `archiveProduct`, receipt-config CRUD). PIN-gated admin actions funnel through `verifyManagerPinOrThrow` (`convex/auth/verifyPin.ts`). **v0.6 adds:** **manager-PIN** for `createVoucher`, `recordSpoilage`, `approveSpoilage` (identity/money: voucher mint + stock decrement); **manager-session** for `updateVoucherMeta`, `archiveVoucher`, `listAllVouchers`, `getVoucherRedemptions`, `listStockDrift`, `resolveDrift` (low-stakes config + read-only drift triage), `setTxnTickerEnabled` (v1.0.2 — sales-ticker opt-out). **v0.7 adds:** **manager-PIN** for `enterSettlementManually` (manual payout-day bookkeeping — money).
23. **Booth state is two stored levels (ADR-053, supersedes ADR-050).** Level 1: `outlets.is_open` (SOP gate — set by `openBooth`/`managerSkipOpen`, cleared by `endOfDay`). Level 2: `pos_shifts` holder row (`ended_at == null` = active holder; `startShift` creates, `endOfDay`/handover-out-half ends). Handover is person-to-person (outgoing `handover` ends, incoming `startShift` begins — no intermediate state). Lock = plain session logout (`lock`): the holder row is unchanged, so the same staff simply logs back in to resume (no separate resume mutation). `managerOverride` force-ends a stranded holder (PIN-gated, no Telegram). `pos_shift_events` kept read-only/legacy for audit history; `deriveBoothState` deleted. ([ADR-053](./docs/ADR/053-two-level-booth-state.md))
24. **Per-staff locale (`"en" | "id"`, default `"en"`)** — stored on `staff.locale`, projected by `getSession`, seeded into `LocaleProvider` post-login. Pre-login defaults to English. Toggle is optimistic (instant client flip → `setOwnLocale` persist → revert on failure). `format.ts` (currency + dates) stays `id-ID` regardless of locale; receipts and Telegram are out of scope for v1.2. Brand names in converted files use `{"Brand"}` (JSXExpressionContainer, not JSXText) to avoid the ESLint i18n fence. ([ADR-049](./docs/ADR/049-i18n-client-typed-dictionary.md))
25. **Outlet scoping is session-derived — `outlet_id` never crosses the wire as a client argument** ([ADR-051](./docs/ADR/051-multi-outlet-tenancy-silo.md)).
26. **OTP authorises MANAGE ([ADR-052](./docs/ADR/052-owner-auth-telegram-otp.md)) — the owner cockpit is a third auth plane, extending ADR-029 (token=VIEW; PIN=ACT; OTP=MANAGE).** Key invariants: **(a)** Cockpit sessions are `kind: "cockpit"` on `staff_sessions`, outlet-UNSCOPED (no `outlet_id`), and rejected from every booth resolver (`requireSession`, `_resolveSession_internal`, `_resolveSessionRole_internal`) with `NOT_BOOTH_SESSION` — a cockpit session cannot call booth mutations, and vice versa. `assertZeroNullOutletIds` skips cockpit rows. **(b)** OTP is delivered to the owner's **private** Telegram DM only (by `staff.telegram_user_id`); never a group chat — DM-only is asserted in the delivery path. **(c)** Lockout isolation: OTP request throttle lives in `owner_auth_attempts` (per staff, keyed by `staff_id`); quick-PIN misses in the per-binding `quick_pin_fail_count` on the `owner_auth_bindings` row; neither path can write to `pos_auth_attempts` (booth) — a cockpit attacker cannot DoS-lock a booth login (SEC-07 principle). **(d)** Owner role is reached only by promotion via `setStaffRole` (manager-PIN); `createStaff` never mints an owner. **(e)** `owner_otp` is the one DM-routed Telegram template kind; it is sent via `chatIdOverride` to the owner's `telegram_user_id` and is **NOT** routed through a group role — `KNOWN_TELEGRAM_ROLES` is unchanged. The 6-digit code is REDACTED from `telegram_log` (C3 audit constraint). New env var: `TELEGRAM_BOT_USERNAME` (used to build `https://t.me/<bot>?start=<token>` bind deep-links) — set on BOTH dev and prod. The chain: `registered_devices.outlet_id` (bound post-activation by `assignDeviceOutlet`, manager-PIN) → session writer stamps it on `staff_sessions.outlet_id` → `requireSession` / `requireManagerSession` / `getSession` return it as a window-typed `Id<"outlets"> | undefined` → every operational query/mutation scopes by it via `outletScoped` helper (`convex/lib/outletScope.ts`). **Every operational scan index MUST lead with `outlet_id`** — enforced by the `index-leads-with-outlet_id` ESLint fence (`tools/eslint-rules/index-leads-with-outlet_id.js`), which makes "forgot to scope" a CI failure. 16 justified `// eslint-disable` exceptions exist (Public API cross-outlet feeds, session-less catalog/stock offline-cache queries, global-code external IDs, business-level storm-cap/PIN-reset); all others are errors. **v2.0 additive phase (this branch):** `outlet_id` is `optional` everywhere; old non-outlet indexes kept alongside new `by_outlet_*` indexes (deferred Task 12 enforce-step will flip to required + drop subsumed indexes after prod backfill). **`pos_settings.outlet_device_id`, `settings.outletStatus`, `staff.setOutletDevice`, and `useOutletStatus.ts` (PR #124 hotfix) are retired** — real device→outlet binding replaces them. **`pos_error_reports.outlet_id` stays `optional` even at enforce** (system/cron rows carry no session).
27. **Telegram routing is two-tier `(role, outlet_id)` (Spec 4, [ADR-035](./docs/ADR/035-telegram-as-internal-comms.md) per-outlet amendment).** `ROLE_SCOPE` (`convex/telegram/config.ts`) declares each role `"outlet"` (`managers`, `inventory` — bound to a specific outlet) or `"business"` (`owners`, `ops` — no `outlet_id`). `telegramChats.outlet_id` + the `by_role_outlet` index carry the binding; **`telegramChats` stays in the outlet-fence EXCLUSION list** (`by_role_outlet` leads with `role`, not `outlet_id`). The action-layer `resolveOutletChatId(ctx, role, outletId)` (`convex/telegram/resolveOutletChat.ts`, V8-safe) is the single two-tier resolve: `(role,outlet)` lookup → single-outlet fallback **gated on exactly-one-active-outlet** → else throw (no multi-outlet misroute). `sendTemplate` throws `OUTLET_REQUIRED_FOR_ROLE` if an outlet-scoped role is sent without `outletId`; **`chatIdOverride` callsites bypass that safety net** (low-stock dispatch, recount, txn-ticker, drift cron, owners cron) so each resolves per-outlet itself and uses a **per-outlet idempotency key** (`<prefix>:<outletCode>:<date>`) — a missed thread is a silent misroute, not a caught throw. `founders` → `owners` recast (transitional alias kept through the migration window; rebound by the `bindTelegramChatsToDefaultOutlet` backfill). Audit verb: `telegram.chat_outlet_bound`.

## File locations

Backend is organized by domain module per [ADR-034](./docs/ADR/034-deep-modules-surface-apis.md) (each module: `public.ts`, `internal.ts`, `schema.ts`, often `actions.ts`). **Function-level reference: [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md).** Schema: [`docs/SCHEMA.md`](./docs/SCHEMA.md).

**`convex/` modules:**

| Module | Owns / purpose |
|---|---|
| `schema.ts` | Root schema, composed from per-module fragments |
| `outlets/` | **v2.0:** `outlets` table + `staff_outlet_access` join table; `listOutlets`, `_getDefaultOutlet_internal`, `_listStaffForOutlet_internal`, `_assertStaffHasOutletAccess_internal`. |
| `migrations/` | **v2.0:** `migration_state` table; `seedDefaultOutlet` (idempotent), `backfillOutletId` (paginated/resumable), `assertZeroNullOutletIds`. **v2.1 (ADR-053):** `backfillOutletStatus` + `assertOutletStatusBackfilled` — one-shot derive-`outlets.is_open`+holder from legacy events; **ran on prod 2026-06-26, now vestigial post-enforce** (`is_open` is required). Run in order on prod after a deploy. |
| `auth/` | Staff, sessions, devices, PIN auth (+ `sessions.ts`, `verifyPin.ts`). **v0.5.3b:** `verifyManagerPinOrThrow` (manager-PIN funnel for admin writes) + PIN-gated `createStaff` action — see `docs/API_REFERENCE.md`. `_resolveSessionRole_internal` (v0.5.3a — non-throwing resolve+role for read-only fork-on-role queries), `_listStaffNames_internal` (staff-name labeling). **v1.2 #1:** `staff.locale` (`"en" \| "id"`, default `"en"`) projected on `getSession` — drives `LocaleProvider` post-login. **v2.0:** `requireSession`/`requireManagerSession`/`getSession` return `outlet_id` (`Id<"outlets"> \| undefined`, window-tolerant default-outlet fallback — hard SESSION_NO_OUTLET throw deferred to Task 12). `_loginCommit_internal`, `managerTakeover`, seed writers all resolve + stamp `outlet_id`. **v2.0 owner-auth (ADR-052):** `ownerSchema.ts` adds `owner_auth_otp` + `owner_auth_bindings` + `owner_auth_attempts` tables; `ownerActions.ts` + `ownerInternal.ts` implement the OTP request/verify/bind/logout/remember-device flow; `requireCockpitSession` (cockpit counterpart to `requireSession`); `staff.role` gains `"owner"`, `staff.telegram_user_id` added, `staff_sessions.kind` + `last_active_at` added. Booth resolvers reject cockpit sessions with `NOT_BOOTH_SESSION`. |
| `staff/` | Staff CRUD + device registration; `listActiveManagers`. **v0.5.3b:** `actions.ts` (PIN-gated role/deactivate) + session-only admin mutations + `listStaff` projection that strips `pin_hash` — see `docs/API_REFERENCE.md`. **v1.2 #1:** `setOwnLocale` — session-gated mutation to persist `staff.locale`; idempotency-wrapped; audit verb `staff.setLocale`. **v2.0:** `assignDeviceOutlet` (manager-PIN action) + `grantOutletAccess`/`revokeOutletAccess` (manager-PIN actions) + `listStaffForDevice`. PR#124 `setOutletDevice` + `useOutletStatus` **retired**. |
| `catalog/` | Products, inventory SKUs, components, stock levels. **v0.5.3b:** `actions.ts` (PIN-gated create/pricing) + session-only meta/components/archive mutations + admin `listAllProducts` — see `docs/API_REFERENCE.md`. **v1.2 #3:** product photo upload (`generateProductPhotoUploadUrl`, manager-session) + `photo_url` projection; `photo_storage_id` now live; initials/hue chip fallback rendered via `ProductThumb`. |
| `audit/` | Append-only audit log; `logAudit` helper called from every state-changing mutation |
| `idempotency/` | Mutation harness + dedupe helpers |
| `transactions/` | `pos_transactions`/`_lines`/`_receipt_counters`; cart commit + `_confirmPaid`; `flags.ts` (`NEG_STOCK`); `cancelAwaitingPayment`. **Reporting (v0.5.3a):** `lib.ts` pure day aggregators (`computeDaySummary`, V8-safe), `_fetchDayWindow_internal` (single day read, role-neutral — callers fork), public queries `listDayTransactions`/`dashboardSummary`/`getTransactionDetail`/`shareReceipt` (staff = same-day, manager = any day) |
| `payments/` | Xendit charge + `pos_xendit_invoices`; `webhook.ts` = signature-verified httpAction; `instrumentFromInvoice` (pure helper → `"qris"\|"bca_va"\|"unknown"`) |
| `inventory/` | `pos_stock_movements` + `_stock_levels` + `_low_stock_alerts` (ADR-042) + `_recount_state` (ADR-041). Recount, low-threshold, low-stock dispatch, `/stock` queries. **v0.6:** `actions.ts` (PIN-gated `recordSpoilage` — spoilage stock decrement, S4) + `cronActions.ts` (R5 resilient cron entry for stock-drift reconciliation) + drift queries (`listStockDrift`, `resolveDrift`) |
| `vouchers/` | `pos_vouchers` + `_redemptions`; inline discount, one per txn |
| `approvals/` | Off-booth flow: `pos_approval_requests`, `kinds.ts` (`APPROVAL_KINDS`), `lib.ts` (`effectiveStatus`, `TOKEN_PIN_ATTEMPT_CAP`). **v0.6:** `kinds.ts` gained `"spoilage"` union member (S2); `actions.ts` gained `requestSpoilageApproval` + `approveSpoilage` (S5) |
| `settings/` | `pos_settings` singleton; `_getSettings_internal` returns defaults when row absent. **v0.5.3b:** receipt-branding fields (`receipt_*`) + manager-session receipt-config CRUD (update purges receipt cache) — see `docs/API_REFERENCE.md`. **v2.0:** `pos_settings` is now **per-outlet** (one row per outlet); `_getSettings_internal` takes `outletId?` arg and reads `by_outlet`. `pos_settings.outlet_device_id` **retired** (replaced by `registered_devices.outlet_id`). |
| `settlements/` | **v0.7:** `pos_settlements` per-day payout aggregate (ADR-012 amended — no Xendit "settlement object"/webhook); pure `lib.ts` parse/aggregate, single-writer `_upsertSettlementDay_internal` (poll-wins-on-conflict), PIN-gated `enterSettlementManually`, V8 auto-poll cron `syncSettlements*` (KYB-gated), role-agnostic `listSettlements` |
| `shifts/` | **ADR-053 (supersedes ADR-050):** Two-level stored booth state. `shifts.ts` mutations (`openBooth`, `startShift`, `endOfDay`, `handover`, `lock`) + `loginContext` query. `actions.ts` Node actions: `managerOverride` (force-end stranded shift, PIN-gated) + `managerSkipOpen` (manager PIN + session) + `_sendSignoffSummary` (deferred Telegram). `shiftsInternal.ts` internal helpers. `shiftLib.ts` pure helpers (replaces `deriveBoothState`). `internal.ts` legacy event helpers (`_shiftStartAnchor_internal`, `_buildSignoffSummary_internal`, `_recordShiftEvent_internal`). `pos_shift_events` kept read-only. |
| `cockpit/` | **v1.3.0 (Spec 3):** Owner read/clone surface — outlet-**UNSCOPED**, `requireCockpitSession`-gated. Owns **no tables** — all cross-outlet reads route through owning-module internals (ADR-034). `outlets.ts`: `createOutlet` (action, idempotency + `withActionCache`) + `_createOutletAtomic_internal` (single-writer internalMutation — blank/clone outlet creation: outlet row, catalog clone or blank seed, settings, `staff_outlet_access` grant, one `outlet.created` audit row); `listOutlets` (query); `listAssignableStaff` (query). `dashboard.ts`: `perOutletSummary` query (fans out over active outlets via `computeDaySummary`; the consolidated headline is summed client-side from its rows). Supporting helpers in owning modules: `outlets/lib.ts` (`getOutletByCode`, `insertOutletRow`), `catalog/lib.ts` (`cloneCatalogRows`), `settings/lib.ts` (`cloneSettingsRow`/`seedSettingsRow`), `auth/grantAccess.ts` (`grantOutletAccessRow`), `staff/internal.ts` (`_listAssignableStaff_internal`). |
| `receipts/` | `/r/<token>` httpAction + `pos_receipt_html_cache` + `template.ts` (ADR-039, 24h cache). *(v0.5.3a: `_lazyMintReceiptToken_internal` facade deleted; `shareReceipt` calls `transactions._ensureReceiptTokenForPaidTxn_internal` directly.)* **v0.5.3b:** template reads branding from `pos_settings`; `_purgeAllReceiptCache_internal` fires on every receipt-config update. **v0.5.4 (ADR-043):** `public.ts::getReceiptForPrint` = print view-model query (view-model + status label only, NO token); `template.ts::STATUS_LABELS` now exported for server-side label derivation. |
| `refunds/` | `pos_refunds`; `lib.ts` pure helpers (`computeRefundAmount` ADR-040, `lineRefundable`, `lineRefundedQty`, `refundStatus` — shared by commit funnel, receipt template, FE preview, history badge); `_commitRefund_internal` = single writer for both booth + Telegram paths |
| `telegram/` | Production Telegram (v0.4 rewrite): `send.ts` (`sendTemplate` + scope dispatch), `chatRegistry/` (role routing + admin mutations at `api.telegram.chatRegistry.public.mgr*`), `webhook.ts`, `commands.ts`, `config.ts` (`ROLE_SCOPE`), **v2.0 (Spec 4):** `resolveOutletChat.ts` (`resolveOutletChatId`), `dispatch.ts`/`txnTicker.ts` (per-outlet resolve), `ownersSummary.ts` *(renamed from `foundersSummary.ts`)* |
| `crons.ts` | `owners-shift-summary` *(v2.0, was `founders-shift-summary`)* daily 22:00 WIB / 15:00 UTC; **v0.7** `settlement-sync` 03:30 WIB / 20:30 UTC; **v1.1** `api-housekeeping` 02:00 WIB / 19:00 UTC (purge `api_rate_buckets` + `api_request_log`); **v2.0** `owner-auth-housekeeping` 03:10 WIB / 20:10 UTC |
| `api/v1/` | External HTTP API for Frollie Pro consumption. Tables: `api_tokens`, `api_rate_buckets`, `api_request_log`. **`pos_products.code` + `staff.code` are now REQUIRED** (no longer optional-until-F6 — the API uses them as stable external IDs). Consumer guide: `docs/PUBLIC_API.md`; response-shape contract: `docs/2026-06-17-pos-erp-sales-sync-CONTRACT.md`. |
| `lib/` | `telegramHtml.ts`, `time.ts` (WIB calendar; exports `WIB_OFFSET_MS`), `tokens.ts` (`mintUrlSafeToken`), `cronRetry.ts`, `dateAnchors.ts`. **Must be V8-safe** (no `"use node"`). **v2.0:** `outletScope.ts` — V8-safe `outletScoped(ctx, outlet_id, indexFn)` helper; replaces ad-hoc ternary fallback patterns. |
| `http.ts` | Registers httpAction routes |

**`src/`:**

| Path | Contents |
|---|---|
| `routes/` | Page routes. Live: `sale/*`, `approve/*`, `mgr/telegram-chats`, `history/index` + `history/$txnId` (v0.5.3a — txn list + detail/share; v0.5.6 — reprint + refund-entry buttons), `mgr/dashboard` (v0.5.3a — manager-only), `mgr/staff` + `mgr/products` + `mgr/receipt` (v0.5.3b — manager-only admin), `account` (v0.5.6 — self change-PIN), `mgr/device-setup` (v0.5.6 — manager device-setup-code; **v2.0:** gains outlet-assign panel `mgr/device.tsx` — manager-PIN `assignDeviceOutlet` replaces old outlet-device designation; PR#124 SOP gate retired), `refund/index` + `refund/$txnId` (refundable list + detail flow), `mgr/audit` (v0.5.8 — manager audit-log viewer), `settlements` (v0.7 — per-day payout list + manager manual-entry, role-agnostic read). Stubbed: remaining `mgr/*` |
| `components/ui/` | shadcn primitives (new-york/stone) |
| `components/layout/` | `RootLayout` (shell + session gate), `Stub`, `AppHeader`, `SpokeLayout` |
| `components/pos/` | `NumericKeypad` (canonical PIN/qty; v1.2 — `disabled` prop locks both click + hardware keydown), `PinSheet`, `ApprovalPending`, `AbandonCartDialog`, `PrinterSheet` (v0.5.4 — connect/status/test-print sheet, wraps `Dialog`, ADR-043) |
| `components/auth/` | `PinEntry` (v1.2 — presentational, prop-driven login PIN entry: `pending` "Verifying…" spinner, `phase`-tinted dots, inline `FieldMessage` error/success, `persist` clear-rule; the route owns the phase machine), `StaffListItem` (staff picker row + pressed-state) |
| `hooks/` | `useDeviceId`, `useSession`, `useCatalogCache`, `useIdempotency` (IDB-backed), `useCart`, `useOfflineQueue`, `useXenditPayment`, `useStartupReconciliation` (no-op), `useApproval`, `useLastStaff`, `useCountdown`, `useThermalPrinter` (v0.5.4 — Web Bluetooth connect/auto-reconnect/print + pure `chunkBytes`, ADR-043), `useAwaitingPaymentRecovery` (v0.5.8 — awaiting-payment recovery banner data) |
| `lib/` | `utils.ts` (`cn()`), `format.ts`, `storage-keys.ts` (localStorage namespace; use `storeSession`), `errors.ts` (`errorMessage` — canonical unknown-error→string, unwraps `ConvexError.data`; use at every backend-error call site), `pinResetDenials.ts` (v1.2 — remount-safe localStorage dedup so the PIN-reset-denial toast fires once per request, #11), `escpos.ts` (v0.5.4 — pure ESC/POS `encodeReceipt` + `SAMPLE_RECEIPT`, ADR-043) |
| `pwa/` | Service worker bootstrap |

**`docs/`:** `ROADMAP.md` (forward queue), `CHANGELOG.md` (shipped record), `SCHEMA.md`, `API_REFERENCE.md`, `ADR/` (37 ADRs + `000-strategic-foundations.md`), `DECISIONS.md` (legacy product/flow), `WORKFLOW.md`, `RUNBOOK-telegram.md`, `PATTERNS/`, `postmortems/` (post-incident retrospectives — distinct from `docs/reviews/` pre-merge artifacts).

**Other:** `frollie-pos design files/` (wireframes, gitignored — IA source for v0.5). _(`packages/ceo-progress-report/` is retired alongside the PROGRESS.md board — no longer part of the doc workflow.)_

## Commands

```bash
npm install
npm run dev               # vite dev server on :5173
npx convex dev            # convex local dev (deployment: helpful-grasshopper-46)
npm run build             # tsc -b && vite build
npm run typecheck         # tsc --noEmit
npm run lint
npm run deploy            # frontend → vercel
npx convex deploy         # backend → convex prod (own project)
```

## Convex deployment

POS has its **own Convex project**, separate from `product_master`. Two deployments:

- **dev:** `helpful-grasshopper-46` — `.convex.cloud` (client/WS), `.convex.site` (httpAction webhooks). Set in `.env.local` as `VITE_CONVEX_URL`; `npx convex dev` targets this.
- **prod:** `savory-zebra-800` — same `.cloud`/`.site` split. **Deployed automatically by the Vercel PRODUCTION build, via `npm run build` → `scripts/build.mjs`** (the env-gated logic lives in the build script, NOT vercel.json, because a Vercel **dashboard** Build Command overrides `vercel.json` — keep them both `npm run build`). On `VERCEL_ENV === "production"` the script runs `npx convex deploy --cmd "npx convex codegen && tsc -b && vite build" --cmd-url-env-var-name VITE_CONVEX_URL` — Convex prod deploy FIRST, then the FE build with prod `VITE_CONVEX_URL` injected, so backend + frontend ship together and the FE can never go live against a stale backend. On preview/local it's FE-only (`convex codegen && tsc -b && vite build`) — a PR preview must NEVER deploy to prod. Requires `CONVEX_DEPLOY_KEY` (a **prod** deploy key) in the Vercel project's **Production** env. Break-glass: manual `npx convex deploy` with the prod key. **Function-type changes (mutation↔action) at the same name are deploy-skew-fatal** — both old-FE+new-backend and new-FE+old-backend throw — so they MUST ship atomically via this single build (don't hand-deploy one side). `npm run build:fe` is the pure FE build (no codegen/deploy).

Add tables in `convex/schema.ts` here — POS tables are POS-owned. Pattern after `product_master` where mirroring a concept, but the tables stay independent.

## Xendit integration

> **Before researching any external/third-party API (Xendit) behaviour, read [`docs/xendit-reference/`](./docs/xendit-reference/) first.** It is our source-cited external-API knowledge base — hard-won facts (which endpoint, which webhook field, what does NOT exist) captured so we don't re-research every phase. New API findings go *there*, not in `docs/API_REFERENCE.md` (that file is our own Convex function inventory). Current contents: `README.md` (QRIS QR Codes API diagnosis + working pattern), `settlement-reconciliation.md` (settlement/payout facts), `qris-protocol-research.md` (EMVCo protocol background).

Full design: [ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md). Load-bearing facts:

- **QRIS** = QR Codes API (`POST /qr_codes`, inline `qr_string`). **BCA VA** = FVA API (`POST /callback_virtual_accounts`, inline `account_number`). Both render in-POS, no hosted invoice page. Invoice API **not used**.
- **`api-version: 2022-07-31` header is load-bearing** on QR creation — without it the `qr.payment` webhook never fires. Asserted by `buildQrisHeaders()` test.
- **Webhook** (`convex/payments/webhook.ts`): signature verification mandatory via `XENDIT_CALLBACK_TOKEN`; always returns 200 (bad/missing token → 401). Parses QRIS (`event: "qr.payment"`, match `data.qr_id`) and BCA VA (flat FVA callback, match `callback_virtual_account_id`).
- **No polling.** Confirmation = webhook + manager-PIN override only.
- **Idempotency at two levels:** client `idempotencyKey` per mutation; webhook also dedupes by `xendit_invoice_id` (Xendit retries).
- **Single active invoice per txn (local supersede):** on retry, mint fresh QR/VA, mark prior row cancelled + `replaced_by_invoice_id` locally. No Xendit cancel-API call for QR codes.
- **Settlement has NO webhook** ([`settlement-reconciliation.md`](./docs/xendit-reference/settlement-reconciliation.md)). Payout of collected funds is knowable only via the **List Transactions API** (`GET /transactions`, per-txn `settlement_status` ∈ `PENDING`/`SETTLED`/`EARLY_SETTLED`/`null` + `settlement_date` + `fee`) or Balance/Transactions report CSVs — matched on our `reference_id`. v0.5.3c ingests via a nightly poll-cron, not a webhook. The "settlement webhook" wording in foundations §7 / ADR-012 is superseded (verified false 2026-06-02). `pos_settlements` (Xendit→merchant) ≠ `pos_refunds.settlement_status` (merchant→customer, ADR-038).

## Auth

PIN-based, 4 digits, **argon2id hashed in a Convex action** (not a mutation — verify is long-running) ([ADR-001](./docs/ADR/001-pin-only-authentication.md), [ADR-004](./docs/ADR/004-pin-hashing-server-side.md)). Session = `staff_sessions` row, no auto-logout, ends on explicit Lock ([ADR-003](./docs/ADR/003-shared-device-ephemeral-session.md)). 3 failed PINs = 60s lockout in `pos_auth_attempts` ([ADR-002](./docs/ADR/002-lockout-policy.md)). Devices must be registered via a one-time 6-digit setup code ([foundations §6](./docs/ADR/000-strategic-foundations.md#6-device-registration-before-login-security-control)). **(v0.5.7)** Setup codes have **two issuance paths**, both funnelling through the single-writer `issueDeviceSetupCode` helper (`convex/staff/internal.ts`): booth manager-session (`generateDeviceSetupCode`) and managers-Telegram (`/activatepos`), distinguished by the `pending_device_setups.issued_via` discriminant (`"booth_inline" | "telegram"`). In dev, `seed:reset` pre-registers a fixed device (`dev-booth-device`) and `useDeviceId` returns it under `vite dev` (`MODE==="development"`), so local / Chrome-MCP loads skip `/activate` (prod/test keep the random UUID path).

Manager actions are **one-off PIN entries**, not modes ([ADR-005](./docs/ADR/005-manager-pin-one-off.md)). Off-booth flows route through Telegram approval ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md)). PIN management = 3 flows, 1 commit funnel (`_changePinCommit_internal`) — see business rule #18.

**(v1.1 security hardening, SEC-01..07)** — `bootstrap` requires the **`BOOTSTRAP_MANAGER_PIN`** env var (4 digits) on the target deployment; no hardcoded PIN. The seeded manager carries `must_change_pin` → FE forces a one-time rotation prompt after login (soft; cleared on any `changePin`). The PIN-lockout counter (`_recordFailedAttempt_internal`) is no longer idempotency-keyed and takes `countTowardLockout` (booth=true, off-booth-approve=false — a leaked approval token can't DoS-lock a booth login). **Device activation is throttled**: per-device (5 misses → 60s) + a global rolling-window ceiling (50 fails / 15-min) that blocks the window without wiping `pending_device_setups`; `activateDevice` is an **action** (the throttle counter must commit independently of the `INVALID_CODE` rejection). Setup-code TTL is **15min** (was 1h). `getById`/`getCurrentInvoice` are session-gated + projected (no `receipt_token`/`qr_string` leak); system callers use `_getTxnById_internal`/`_getCurrentInvoice_internal`.

## Crons

In `convex/crons.ts`. **`owners-shift-summary`** *(v2.0 Spec 4, was `founders-shift-summary`)* at 22:00 WIB / 15:00 UTC → `telegram/ownersSummary.sendOwnersSummaryResilient` — sends a business-wide `owners` rollup (with per-outlet breakdown) PLUS a per-outlet `managers_daily_summary`. On-demand: `npx convex run telegram/ownersSummary:sendOwnersSummary` (needs `owners` role bound + the default outlet's `founders_summary_enabled` toggle on). **v0.7: `settlement-sync`** at 03:30 WIB / 20:30 UTC → `settlements.cronActions.syncSettlementsResilient` (nightly Xendit `GET /transactions` poll; KYB-gated for live data). **v2.0: `owner-auth-housekeeping`** at 03:10 WIB / 20:10 UTC → `auth.internal._purgeOwnerAuthHousekeeping_internal` (purges expired/consumed `owner_auth_otp` rows + expired/redeemed `owner_auth_bindings` rows).

## Telegram

Env vars, role table, and ops troubleshooting: [`docs/RUNBOOK-telegram.md`](./docs/RUNBOOK-telegram.md). Roles (`KNOWN_TELEGRAM_ROLES` in `convex/telegram/config.ts`): `managers` (approvals + per-shift signoff + recount + daily summary — bind first), `owners` *(v2.0, was `founders`)* (daily business rollup), `inventory` (recount + low-stock alerts + **v0.6** `stock_drift_alert`), **v1.0.1** `ops` (POS error/crash alerts via `system_error`). **v2.0 (Spec 4):** routing is two-tier `(role, outlet_id)` — `managers`/`inventory` are **per-outlet** (`ROLE_SCOPE = "outlet"`, bound to a specific outlet via `/mgr/telegram-chats`), while `owners`/`ops` are **business-wide** (`ROLE_SCOPE = "business"`, no `outlet_id`); see ADR-035 per-outlet amendment + business rule #27. `founders` is a transitional alias (rebound to `owners` by the Task-12 backfill). Set env vars on **both** dev and prod.

**Commands (v0.5.7):**
- `/activatepos` — any chat whose row has `role === "managers"` *(v2.0: per-outlet — was the single managers chat)*; replies with a 6-digit device setup code (15min TTL — SEC-04) + a `<POS_BASE_URL>/activate` link so an off-booth manager can activate a new phone/browser. The minted code is outlet-less (no device pre-assign — decision C); device→outlet binding is the separate post-activation manager-PIN `assignDeviceOutlet`. Group privacy mode swallows the bare command — see [`docs/RUNBOOK-telegram.md`](./docs/RUNBOOK-telegram.md).

**Template kinds (v0.6 additions):**
- `spoilage` — approval template, URL button → `/approve/:token` (ADR-035); routes to `managers` role.
- `stock_drift_alert` — informational template (no URL button); routes to `inventory` role.

**Template kinds (v1.0.1 additions):**
- `system_error` — informational template (no URL button); routes to `ops` role. Fired by the launch-day error pipe when a `pos_error_reports` row clears the dedup/storm-cap gate.
- `txn_ticker` — informational template (no URL button); routes to `managers` role. One message per paid sale, sent **silent** (`disableNotification`); toggle via `pos_settings.txn_ticker_enabled` (default true).

**Template kinds (v2.0 owner-auth additions):**
- `owner_otp` — informational DM (no URL button); routed via `chatIdOverride` to the owner's **private** `telegram_user_id` (NOT a group role — `KNOWN_TELEGRAM_ROLES` unchanged). The 6-digit code is REDACTED from `telegram_log` (C3). This is the only DM-routed Telegram kind.

**Template kinds (v2.0 per-outlet routing — Spec 4):**
- `managers_daily_summary` — informational template (no URL button); routes to a **per-outlet** `managers` chat. One per active outlet per day, sent alongside the business-wide `owners` rollup by the `owners-shift-summary` cron. Per-outlet idempotency key `mgrsum:<outletCode>:<dateLabel>`.
- `shift_summary` (owners rollup) gains an optional `perOutlet[]` breakdown block; `system_error` gains an optional `outlet_label` (routing stays business-wide `ops`).
- **Outlet-scoped sends route by `(role, outlet_id)`** via `resolveOutletChatId` (action layer); `sendTemplate` throws `OUTLET_REQUIRED_FOR_ROLE` if an outlet-scoped role is sent without an `outletId`. `chatIdOverride` callsites (low-stock dispatch, recount, txn-ticker, drift cron) resolve per-outlet themselves and carry their own per-outlet idempotency keys — a missed thread is a silent misroute, not a caught throw.

## How to add a feature

1. Read the relevant ADR(s); for strategy, [`000-strategic-foundations.md`](./docs/ADR/000-strategic-foundations.md).
2. Reuse a Frollie Pro pattern if one exists; else document the new one in `docs/DECISIONS.md`.
3. New table/column → update `docs/SCHEMA.md` first, then `convex/schema.ts`.
4. State-changing action → emit `logAudit` and document the new verb in `docs/SCHEMA.md` (the v0.3-shipped audit verb list). `audit_log.action` is a free `v.string()` — there is no code enum to edit.
5. Public mutation → accept `idempotencyKey`, wrap with `withIdempotency` + `authCheck` (rule #20).
6. Manager-PIN gate → inline (booth) or Telegram-approval (off-booth default). Both update the same `pos_approval_requests` row.
7. Payment/refund/stock features → write tests. Others: optional but encouraged.
8. **New approval KIND** → wire all four touch-points: **(a)** `convex/approvals/kinds.ts` (`ApprovalKind` union, `validateContext` case, `KIND_AUDIT`, `KIND_TEMPLATE`) + `approvals/schema.ts` + `approvals/internal.ts` validators; **(b)** Telegram template — literal in `sendTemplate`'s `kind` union (`convex/telegram/send.ts`) + `renderXxx` in `convex/lib/telegramHtml.ts` (URL button → `${POS_BASE_URL}/approve/${rawToken}`, never `callback_data`); **(c)** `/approve/:token` UI variant (`src/routes/approve/index.tsx` discriminates on `kind`; `approve/pin.tsx` for ACT); **(d)** public action in `approvals/actions.ts` following the `requestManualPaymentApproval`/`approveManualPayment`/`denyRequest` pattern, reusing `_createRequest_internal`/`_markNotified_internal`/`_markResolved_internal`/`_markDenied_internal`. Thread `source: "telegram_approval"` everywhere. Admin surface is `api.telegram.chatRegistry.public.mgr*`.
9. Update `docs/CHANGELOG.md` in the same PR.
10. **`test.skip` blocks** require the [`docs/PATTERNS/skip-comment-template.md`](./docs/PATTERNS/skip-comment-template.md) three-field format (observed failure mode + evidence path + follow-up issue). A SKIP without all three is rejected at review.

## When to push back

Each is a settled decision — cite the ADR, don't relitigate without a new one:

- **Cash handling** → future phase ([ADR-006](./docs/ADR/006-no-cash-no-shift-open-close.md)).
- **Packaging/kitchen stock** → out of scope, finished-goods only ([foundations §5](./docs/ADR/000-strategic-foundations.md#5-finished-goods-only--no-kitchen-inventory-in-v1)).
- **Customer-facing screen** → out of scope, staff + manager only.
- **Different backend (Firebase/Supabase)** → needs an ADR with strong justification vs Frollie Pro alignment.
- **Multi-stall** → future phase; schema is single-tenant in v1.
- **Voucher stacking** → rejected ([ADR-010](./docs/ADR/010-no-voucher-stacking.md)).
- **Hard-block sales at zero stock** → rejected; counter velocity wins ([ADR-018](./docs/ADR/018-negative-stock-allowed-flagged.md)).
- **WhatsApp Cloud API for approvals** → v1.1+; v1 uses Telegram ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md)).
- **Skip idempotency, just disable the button** → doesn't cover retries/SW re-fires/reloads ([ADR-013](./docs/ADR/013-idempotency-keys.md)).

**When in doubt:** ask. Don't ship an assumption that locks the Frollie Pro graft — clarifying costs one message, a bad foundation costs a rewrite.

## Wireframe reference

Screen designs: `frollie-pos design files/project/Frollie POS Wireframes.html` (canonical IA + flow for v0.5). Open the artboard's `wireframes/<name>.jsx` for layout intent. The hand-drawn look is a wireframe convention — implement production-polish with the shadcn/Tailwind tokens in `src/index.css`.

## gstack

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows. Use `/browse` for all web browsing; use `~/.claude/skills/gstack/...` for gstack paths. Skills like `/qa`, `/ship`, `/review`, `/investigate` become available after install.
