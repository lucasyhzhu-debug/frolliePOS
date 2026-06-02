# CLAUDE.md

AI agent context for the Frollie POS repo. Read this first before touching code.

> **This file is a pointer, not a mirror.** Depth lives in `docs/` — ADRs (`docs/ADR/`), schema (`docs/SCHEMA.md`), the Convex function inventory (`docs/API_REFERENCE.md`), Telegram ops (`docs/RUNBOOK-telegram.md`), and reusable patterns (`docs/PATTERNS/`). When a rule below cites an ADR, the ADR is the full rationale.

## Progress tracker — read FIRST, update LAST

Living roadmap: [`docs/PROGRESS.md`](./docs/PROGRESS.md) (source of truth). Every task has a stable **Task ID** (`<phase>-<lane>-<slug>`) with metadata. Rendered view: [`docs/progress.html`](./docs/progress.html), generated from the markdown.

**Mandatory workflow for every session and every dispatched agent:**

1. **Before work**: `/progress --ready` → pick a task whose `agent:`/lane matches you; read its metadata block.
2. **Starting**: `/progress-update <task-id> --status in-progress --owner <name>` (claims it).
3. **Ticking subtasks**: `/progress-update <task-id> --subtask "<substring>"`.
4. **On commit**: `/progress-update <task-id> --status done --commit <sha>`.
5. **New task mid-phase**: `/progress-update <new-id> --new-task "<title>" --phase vX.Y --lane be|fe|xc --agent <name> [--deps ...]`.
6. **After any update**: `npx ceo-report build --src docs/PROGRESS.md --out docs/progress.html` (regenerates HTML, ~50ms).

**Refusal conditions** (skill-enforced): `in-progress` needs `--owner`; `done` needs `--commit`; `--subtask` must match exactly one subtask.

**Do NOT** hand-edit `docs/PROGRESS.md` status/subtask/owner/commit fields (go through `/progress-update`) or `docs/progress.html` (regenerated). Direct PROGRESS.md edits are only for new phase headers, typo fixes, lane restructuring. Backlog phases (v0.4–v1.0) get Task IDs when they enter planning — don't retrofit early.

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

Design tokens (Inter, Frollie teal, role/channel/station colors) in `src/index.css`, mirroring the Frollie Pro design system.

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
12. **Founders shift-summary** = daily cron (22:00 WIB) to **Frollie · Founders** ([ADR-033](./docs/ADR/033-founders-shift-summary-share.md)). Opt-out via `pos_settings.founders_summary_enabled` (default true); audited skip, no retry storm.
13. **Vouchers are static**, manager-created/distributed; no stacking ([ADR-010](./docs/ADR/010-no-voucher-stacking.md)); cached offline, server re-validates on sync ([ADR-009](./docs/ADR/009-voucher-cache-offline.md)).
14. **All money as integer rupiah** — no floats/cents. Format via `Intl.NumberFormat("id-ID")` in `src/lib/format.ts` ([ADR-015](./docs/ADR/015-idr-integer-rupiah.md)).
15. **Server time wins** — every `_at` set via `Date.now()` inside the function, never client-supplied ([ADR-031](./docs/ADR/031-convex-server-time-wins.md)).
16. **PWA partial offline:** catalog/cart/drafts/stock-in queue; payments/auth/refunds block offline with clear UI ([ADR-025](./docs/ADR/025-service-worker-cache.md)).
17. **Reconciliation is manual-only for QRIS/FVA** — `useStartupReconciliation` is a no-op shell ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) amends [ADR-026](./docs/ADR/026-reconciliation-on-reload.md)). Double-decrement prevented by the `pos_stock_movements.by_line_and_sku` index (one `sale` movement per `(source_transaction_line_id, inventory_sku_id)`).
18. **PIN changes funnel through `_changePinCommit_internal`** — its 3 callers are `auth.changePin` (self), `auth.resetStaffPin` (booth), `approvals.approveStaffPinReset` (off-booth). Branch on `actor.kind`; never log PIN values; don't add a 4th reset path.
19. **`APPROVAL_KINDS` is the add-a-kind mechanism** — `convex/approvals/kinds.ts` (`ApprovalKind` union + `validateContext` switch + `KIND_AUDIT` + `KIND_TEMPLATE`). `validateContext` is the single-writer invariant. Keep schema/internal validators, Telegram renderer, and `/approve` UI in sync (see [How to add a feature](#how-to-add-a-feature) #8).
20. **Public mutations require `idempotencyKey` + `withIdempotency` + `authCheck`** ([ADR-013](./docs/ADR/013-idempotency-keys.md)). ESLint-enforced. The handler re-calls `require*Session(...)` so `authCheck` runs BEFORE the cache lookup; the duplication is intentional — don't collapse it. See [`docs/PATTERNS/idempotency-dual-call-authcheck.md`](./docs/PATTERNS/idempotency-dual-call-authcheck.md).
21. **`markRefundSettled` is manager-session, NOT manager-PIN** ([ADR-038](./docs/ADR/038-refund-settlement-manual-v1.md)) — it's a bookkeeping ack that the already-authorised transfer completed; moves no money. Still audited (`refund.settled`). Same logic guides any "tally what already happened" mutation.
22. **Manager-admin writes are tiered** (v0.5.3b): **manager-PIN** for identity/money (`createStaff`, `setStaffRole`, `deactivateStaff`, `createProduct`, `updateProductPricing`); **manager-session** for low-stakes config (`updateStaffName`, `updateProductMeta`, `setProductComponents`, `archiveProduct`, receipt-config CRUD). PIN-gated admin actions funnel through `verifyManagerPinOrThrow` (`convex/auth/verifyPin.ts`).

## File locations

Backend is organized by domain module per [ADR-034](./docs/ADR/034-deep-modules-surface-apis.md) (each module: `public.ts`, `internal.ts`, `schema.ts`, often `actions.ts`). **Function-level reference: [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md).** Schema: [`docs/SCHEMA.md`](./docs/SCHEMA.md).

**`convex/` modules:**

| Module | Owns / purpose |
|---|---|
| `schema.ts` | Root schema, composed from per-module fragments |
| `auth/` | Staff, sessions, devices, PIN auth (+ `sessions.ts`, `verifyPin.ts`). **v0.5.3b:** `verifyManagerPinOrThrow` (manager-PIN funnel for admin writes) + PIN-gated `createStaff` action — see `docs/API_REFERENCE.md`. `_resolveSessionRole_internal` (v0.5.3a — non-throwing resolve+role for read-only fork-on-role queries), `_listStaffNames_internal` (staff-name labeling) |
| `staff/` | Staff CRUD + device registration; `listActiveManagers`. **v0.5.3b:** `actions.ts` (PIN-gated role/deactivate) + session-only admin mutations + `listStaff` projection that strips `pin_hash` — see `docs/API_REFERENCE.md`. |
| `catalog/` | Products, inventory SKUs, components, stock levels. **v0.5.3b:** `actions.ts` (PIN-gated create/pricing) + session-only meta/components/archive mutations + admin `listAllProducts` — see `docs/API_REFERENCE.md`. |
| `audit/` | Append-only audit log; `logAudit` helper called from every state-changing mutation |
| `idempotency/` | Mutation harness + dedupe helpers |
| `transactions/` | `pos_transactions`/`_lines`/`_receipt_counters`; cart commit + `_confirmPaid`; `flags.ts` (`NEG_STOCK`); `cancelAwaitingPayment`. **Reporting (v0.5.3a):** `lib.ts` pure day aggregators (`computeDaySummary`, V8-safe), `_fetchDayWindow_internal` (single day read, role-neutral — callers fork), public queries `listDayTransactions`/`dashboardSummary`/`getTransactionDetail`/`shareReceipt` (staff = same-day, manager = any day) |
| `payments/` | Xendit charge + `pos_xendit_invoices`; `webhook.ts` = signature-verified httpAction; `instrumentFromInvoice` (pure helper → `"qris"\|"bca_va"\|"unknown"`) |
| `inventory/` | `pos_stock_movements` + `_stock_levels` + `_low_stock_alerts` (ADR-042) + `_recount_state` (ADR-041). Recount, low-threshold, low-stock dispatch, `/stock` queries |
| `vouchers/` | `pos_vouchers` + `_redemptions`; inline discount, one per txn |
| `approvals/` | Off-booth flow: `pos_approval_requests`, `kinds.ts` (`APPROVAL_KINDS`), `lib.ts` (`effectiveStatus`, `TOKEN_PIN_ATTEMPT_CAP`) |
| `settings/` | `pos_settings` singleton; `_getSettings_internal` returns defaults when row absent. **v0.5.3b:** receipt-branding fields (`receipt_*`) + manager-session receipt-config CRUD (update purges receipt cache) — see `docs/API_REFERENCE.md`. |
| `receipts/` | `/r/<token>` httpAction + `pos_receipt_html_cache` + `template.ts` (ADR-039, 24h cache). *(v0.5.3a: `_lazyMintReceiptToken_internal` facade deleted; `shareReceipt` calls `transactions._ensureReceiptTokenForPaidTxn_internal` directly.)* **v0.5.3b:** template reads branding from `pos_settings`; `_purgeAllReceiptCache_internal` fires on every receipt-config update. |
| `refunds/` | `pos_refunds`; `lib.ts` pure helpers (`computeRefundAmount` ADR-040, `lineRefundable`, `lineRefundedQty`, `refundStatus` — shared by commit funnel, receipt template, FE preview, history badge); `_commitRefund_internal` = single writer for both booth + Telegram paths |
| `telegram/` | Production Telegram (v0.4 rewrite): `send.ts` (`sendTemplate`), `chatRegistry/` (role routing + admin mutations at `api.telegram.chatRegistry.public.mgr*`), `webhook.ts`, `commands.ts`, `config.ts`, `foundersSummary.ts` |
| `crons.ts` | `founders-shift-summary` daily 22:00 WIB / 15:00 UTC |
| `api/v1/` | External HTTP API for Frollie Pro consumption |
| `lib/` | `telegramHtml.ts`, `time.ts` (WIB calendar; exports `WIB_OFFSET_MS`), `tokens.ts` (`mintUrlSafeToken`), `cronRetry.ts`, `dateAnchors.ts`. **Must be V8-safe** (no `"use node"`) |
| `http.ts` | Registers httpAction routes |

**`src/`:**

| Path | Contents |
|---|---|
| `routes/` | Page routes. Live: `sale/*`, `approve/*`, `mgr/telegram-chats`, `history/index` + `history/$txnId` (v0.5.3a — txn list + detail/share), `mgr/dashboard` (v0.5.3a — manager-only), `mgr/staff` + `mgr/products` + `mgr/receipt` (v0.5.3b — manager-only admin). Stubbed: refund, settlements, remaining `mgr/*` |
| `components/ui/` | shadcn primitives (new-york/stone) |
| `components/layout/` | `RootLayout` (shell + session gate), `Stub`, `AppHeader`, `SpokeLayout` |
| `components/pos/` | `NumericKeypad` (canonical PIN/qty), `PinSheet`, `ApprovalPending`, `AbandonCartDialog` |
| `hooks/` | `useDeviceId`, `useSession`, `useCatalogCache`, `useIdempotency` (IDB-backed), `useCart`, `useOfflineQueue`, `useXenditPayment`, `useStartupReconciliation` (no-op), `useApproval`, `useLastStaff`, `useCountdown` |
| `lib/` | `utils.ts` (`cn()`), `format.ts`, `storage-keys.ts` (localStorage namespace; use `storeSession`) |
| `pwa/` | Service worker bootstrap |

**`docs/`:** `SCHEMA.md`, `API_REFERENCE.md`, `ADR/` (37 ADRs + `000-strategic-foundations.md`), `DECISIONS.md` (legacy product/flow), `CHANGELOG.md`, `WORKFLOW.md`, `RUNBOOK-telegram.md`, `PATTERNS/`.

**Other:** `frollie-pos design files/` (wireframes, gitignored — IA source for v0.5), `packages/ceo-progress-report/` (frozen snapshot; build path is now the published npm package via `buildlog.config.mjs`).

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
- **prod:** `savory-zebra-800` — same `.cloud`/`.site` split. Populated via `npx convex deploy`. The Vercel build must inject the **prod** URL as `VITE_CONVEX_URL`.

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

PIN-based, 4 digits, **argon2id hashed in a Convex action** (not a mutation — verify is long-running) ([ADR-001](./docs/ADR/001-pin-only-authentication.md), [ADR-004](./docs/ADR/004-pin-hashing-server-side.md)). Session = `staff_sessions` row, no auto-logout, ends on explicit Lock ([ADR-003](./docs/ADR/003-shared-device-ephemeral-session.md)). 3 failed PINs = 60s lockout in `pos_auth_attempts` ([ADR-002](./docs/ADR/002-lockout-policy.md)). Devices must be registered via a one-time 6-digit setup code ([foundations §6](./docs/ADR/000-strategic-foundations.md#6-device-registration-before-login-security-control)). In dev, `seed:reset` pre-registers a fixed device (`dev-booth-device`) and `useDeviceId` returns it under `vite dev` (`MODE==="development"`), so local / Chrome-MCP loads skip `/activate` (prod/test keep the random UUID path).

Manager actions are **one-off PIN entries**, not modes ([ADR-005](./docs/ADR/005-manager-pin-one-off.md)). Off-booth flows route through Telegram approval ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md)). PIN management = 3 flows, 1 commit funnel (`_changePinCommit_internal`) — see business rule #18.

## Crons

In `convex/crons.ts`. Currently one: **`founders-shift-summary`** at 22:00 WIB / 15:00 UTC → `telegram/foundersSummary.sendFoundersSummaryResilient`. On-demand: `npx convex run telegram/foundersSummary:sendFoundersSummary` (needs `founders` role bound + toggle on).

## Telegram

Env vars, role table, and ops troubleshooting: [`docs/RUNBOOK-telegram.md`](./docs/RUNBOOK-telegram.md). Roles (`KNOWN_TELEGRAM_ROLES` in `convex/telegram/config.ts`): `managers` (approvals — bind first), `founders` (shift summary), `inventory` (recount + low-stock alerts). Set env vars on **both** dev and prod.

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
