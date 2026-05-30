# CLAUDE.md

AI agent context for the Frollie POS repo. Read this first before touching code.

## Progress tracker — read FIRST, update LAST

The living roadmap lives in [`docs/PROGRESS.md`](./docs/PROGRESS.md). Every task is addressable by a stable **Task ID** (`<phase>-<lane>-<slug>`, e.g., `v03-be-transactions`) with metadata (agent, deps, docs, subtasks, notes).

A rendered HTML view sits beside it at [`docs/progress.html`](./docs/progress.html) — open it in a browser tab for the bird's-eye view, filtering, and drill-down. The HTML is generated from the markdown; the markdown is the source of truth.

**Mandatory workflow for every coding session and every dispatched agent:**

1. **Before starting work**: run `/progress --ready` to see which tasks have all deps satisfied. Pick one whose `agent:` matches you (or whose lane matches the work). Read the task's metadata block: `agent`, `deps`, `docs`, `subtasks`.
2. **When you start**: `/progress-update <task-id> --status in-progress --owner <your-name>`. This claims the task so two agents don't double-work it.
3. **As you tick subtasks**: `/progress-update <task-id> --subtask "<substring>"` — keeps the bird's-eye view honest.
4. **When the work commits**: `/progress-update <task-id> --status done --commit <sha>`.
5. **If you discover a new task mid-phase**: `/progress-update <new-id> --new-task "<title>" --phase vX.Y --lane be|fe|xc --agent <name> [--deps ...]`.
6. **After any `/progress-update`**: run `npx ceo-report build --src docs/PROGRESS.md --out docs/progress.html` to regenerate the HTML view. (Cheap — ~50ms. Skipping it leaves the rendered board stale.)

**Refusal conditions** (the skill enforces these — don't try to bypass):
- `--status in-progress` requires `--owner` (in same call or already present).
- `--status done` requires `--commit <sha>` (in same call or already present on title line).
- `--subtask` substring must match exactly one subtask under the task.

**Do NOT** edit `docs/PROGRESS.md` directly with Edit/Write for status, subtask, owner, or commit fields — always go through `/progress-update`. Direct edits are reserved for: adding a brand-new phase header, fixing typos in titles/descriptions, restructuring lane layouts. If you're unsure, ask.

**Do NOT** edit `docs/progress.html` by hand — it's regenerated from the markdown. Edit the markdown (via `/progress-update`) then run the build script.

For phases v0.4–v1.0 (currently `🗂️ BACKLOG`), tasks don't yet have IDs. They get retrofitted when a phase enters planning — not before. Don't preemptively retrofit.

## What this is

Internal point-of-sale system for the Frollie booth (Pakuwon Mall / wherever the booth is currently sited). Single device (Android), mobile web app installed as a PWA, 2-3 staff with overlapping shifts. Digital payments only via Xendit (QRIS primary + BCA Virtual Account secondary). Sells Dubai chocolate cookies and related SKUs in multiple pack sizes (1pc, 3pcs, 8pcs, Mixed Box 4pcs).

Not a revenue product. Internal operational tool. The real prize is validating the user flows so this folds into Frollie Pro cleanly.

## What this is not

- Not multi-stall (yet).
- Not cash-handling (yet). Digital payments only.
- Not a recipe or kitchen inventory system. Stock is finished-goods only.
- Not a customer-facing app. Staff + manager only.
- Not for the Play Store. PWA installed on the staff device home screen.

## Relationship to Frollie Pro

POS runs in its **own Convex project** — separate from [`product_master`](https://github.com/lucasyhzhu-debug/product_master). The architectural relationship is logical, not infrastructural: POS mirrors Frollie Pro schema patterns where it makes sense, but POS tables (`pos_*`, `staff`, `staff_sessions`, `registered_devices`, `audit_log`) live in the POS deployment only. In v1 POS uses its own `pos_products` + `pos_inventory_skus` tables ([ADR-016](./docs/ADR/016-product-inventory-separation.md)). v1.1+ integration with Frollie Pro `products`/recipe data will need a cross-deployment integration pattern (sync, API call, or shared package) — not in v1 scope.

Treat POS as a new revenue channel inside Frollie Pro's data model, not a sibling system — but at the infrastructure layer it is genuinely a sibling.

## Stack

Mirror Frollie Pro for **stack choices** (framework, language, libraries). POS **data shape is independent** of Frollie Pro per [ADR-034](./docs/ADR/034-deep-modules-surface-apis.md) — integration happens via a versioned HTTP API surface (`convex/api/v1/`), not schema mirroring. Stack deviations still require an ADR.

- **Convex 1.31.7** (serverless backend, real-time sync)
- **React 19 + TypeScript + Vite**
- **Tailwind CSS 4** (CSS-based config in `src/index.css`)
- **shadcn/ui** new-york style, stone base, tuned to Frollie teal
- **Framer Motion** for transitions
- **React Router v7** (library mode)
- **Vercel hosting** (frontend)
- **PWA** (`vite-plugin-pwa` — service worker + manifest, installable on Android)
- **Xendit** for payments (QR Codes API for QRIS, Virtual Accounts FVA API for BCA VA — [ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md))
- **Sonner** for toast notifications
- **Zustand** for local state where Convex reactivity isn't enough (cart-build only)
- **IDB** for offline queue

Design tokens (Inter font, Frollie teal palette, role/channel/station colors) mirror the Frollie Pro design system — see `src/index.css`. Sourced from `frollie-pos design files/lucas-frollie-design-system`.

## Business rules that affect code

1. **Snapshot prices and names on transaction lines.** Never join `pos_transaction_lines` to `pos_products` for historical price. `unit_price` and `product_name_snapshot` are frozen at sale time.
2. **Audit log is append-only.** Never update or delete a row in `audit_log` ([ADR-007](./docs/ADR/007-audit-log-append-only.md)). Enforced at the mutation layer; code review catches violations.
3. **PPN is 0 today, schema-ready for 11% later.** Don't hardcode 0. Read from `pos_products.tax_rate` (default 0). When Frollie hits PKP threshold, flip `pos_settings.is_pkp` and the default — no migration ([strategic foundations §4](./docs/ADR/000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp)).
4. **Refunds are their own entity.** Never mutate a paid transaction's status to "refunded" — create a `pos_refunds` row; status is computed on read ([ADR-008](./docs/ADR/008-refunds-as-new-rows.md)).
5. **Payment confirmation has two paths for QRIS/BCA VA.** Webhook (primary — Xendit POSTs `qr.payment` / `virtual_account.payment` to `convex/payments/webhook.ts`) and manager-PIN manual override (fallback — audit-logged with reason). Polling retired for these methods ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) amends [strategic foundations §8](./docs/ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)).
6. **Stock-in only at inventory-SKU level.** Products are never restocked directly — selling a "Dubai 8pcs" decrements 8 from the `dubai` SKU ([ADR-016](./docs/ADR/016-product-inventory-separation.md)).
7. **Negative stock allowed at sale, flagged.** Don't hard-block; set `pos_transactions.flags |= NEG_STOCK` and let manager reconcile ([ADR-018](./docs/ADR/018-negative-stock-allowed-flagged.md)).
8. **Stock-in is a logged movement, never a number edit.** Every stock change writes a `pos_stock_movements` row with required `source` enum. `pos_stock_levels` is a denormalised cache, reconciled nightly.
9. **Manager-PIN required for:** refunds, voids of paid txns, manual payment override, ad-hoc/manual discounts, stock adjustments, spoilage, on-device settings edits, PIN resets ([ADR-005](./docs/ADR/005-manager-pin-one-off.md)).
10. **Telegram approval routes manager-PIN gates** to the **Frollie · Managers** Telegram group. From v0.4, off-booth approval requests (PIN resets, manual payment overrides) are delivered as Telegram messages with a single-use `/approve/:token` URL button. Any manager in the group can approve from anywhere by tapping the link + entering their PIN ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md), [ADR-027](./docs/ADR/027-wa-approval-via-staff-own-wa.md) superseded for these flows). The `wa_approval` literal remains in the schema for historical rows; post-v0.4 production code emits `telegram_approval` as the audit source for all off-booth actions.
11. **Approval tokens authorise VIEW; PINs authorise ACT** ([ADR-029](./docs/ADR/029-token-authorizes-view-pin-authorizes-act.md)). Token = 32-byte URL-safe random, single-use, 60-minute TTL.
12. **Founders shift-summary** is a daily cron (22:00 WIB / 15:00 UTC) that posts a structured summary to **Frollie · Founders** via Telegram ([ADR-033](./docs/ADR/033-founders-shift-summary-share.md)). Opt-out via `pos_settings.founders_summary_enabled` (defaults `true` if the row is absent). An audited skip (`founders.summary_skipped`) is written on disable or when the `founders` role is unbound; no retry storm.
13. **Vouchers are static**, manager-created, manager-distributed out-of-band. No voucher stacking ([ADR-010](./docs/ADR/010-no-voucher-stacking.md)). Cached on device for offline apply, server re-validates on sync ([ADR-009](./docs/ADR/009-voucher-cache-offline.md)).
14. **All money as integer rupiah.** No floats, no cents. Format with `Intl.NumberFormat("id-ID")` in `src/lib/format.ts` ([ADR-015](./docs/ADR/015-idr-integer-rupiah.md)).
15. **Every public mutation accepts `idempotencyKey`.** Server dedupes for 24h via `pos_idempotency` ([ADR-013](./docs/ADR/013-idempotency-keys.md)). Mutation harness wraps every public mutation so individual functions don't have to think about it.
16. **Server time wins.** Every `_at` field is set via `Date.now()` inside the Convex function — never client-supplied ([ADR-031](./docs/ADR/031-convex-server-time-wins.md)).
17. **PWA partial offline:** catalog cached, cart builds, drafts queue, stock-in queues. Payments / auth / refunds block offline with clear UI ([ADR-025](./docs/ADR/025-service-worker-cache.md)).
18. **Reconciliation on reload (QRIS/FVA — manual-only):** `useStartupReconciliation` is a thin no-op shell — the poll body was gutted because QR status polling is architecturally impossible and the `checkInvoiceStatus` action was removed ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) amends [ADR-026](./docs/ADR/026-reconciliation-on-reload.md)). Missed-webhook recovery for QRIS/BCA VA is manager-PIN manual override only. Double-decrement is still prevented by the `pos_stock_movements.by_line_and_sku` index — one `sale` movement per `(source_transaction_line_id, inventory_sku_id)`. *(v0.3 shipped this index rather than a unique `(ref_type, ref_id, sku_id)` constraint.)*
19. **PIN changes funnel through one mutation.** `auth.changePin` (self), `auth.resetStaffPin` (manager at booth), and `approvals.approveStaffPinReset` (off-booth) all commit via the shared internal `_changePinCommit_internal`. Branch on `actor.kind`: `"self"` → logs `staff.pin_changed`; `"manager_reset"` → logs `staff.pin_reset`, clears `pos_auth_attempts` (lockout unwind), and stamps `source` (`booth_inline` at booth, `telegram_approval` for the off-booth Telegram path). Never log PIN values — the payload has no PIN fields. Don't add a fourth reset path that bypasses this funnel.
20. **`APPROVAL_KINDS` is the add-a-kind mechanism.** Every new approval kind requires editing `convex/approvals/kinds.ts` (the `ApprovalKind` union + `validateContext` switch + `KIND_TEMPLATE` entry) and the 4 touch-points in "How to add a feature" #8. The schema's `kind` union, `_createRequest_internal`'s validator, the Telegram template renderer, and the `/approve` UI variant must stay in sync. `validateContext` is the single-writer invariant: it rejects invalid context payloads before any DB write. The `KIND_AUDIT` map records which audit action strings apply to each kind.
21. **Public mutations require `idempotencyKey` + `withIdempotency` + `authCheck`.** Every public mutation accepts `idempotencyKey` in args + wraps its handler in `withIdempotency(...)` with an `authCheck` arg in the options object. ESLint enforces. The handler RE-CALLS `require*Session(...)` to get the typed session object — the `authCheck` slot runs BEFORE the idempotency cache lookup (closes the cached-response-to-unauthorized-caller hole), and the handler's inline re-call is intentional and cheap (one indexed query against `staff_sessions`). The duplication is what keeps the rule mechanical; do not collapse it. See [`docs/PATTERNS/idempotency-dual-call-authcheck.md`](./docs/PATTERNS/idempotency-dual-call-authcheck.md).

## File locations

- `convex/` — Convex backend, organized by domain module per [ADR-034](./docs/ADR/034-deep-modules-surface-apis.md)
- `convex/schema.ts` — root schema, composed from per-module fragments
- `convex/auth/` — staff, sessions, devices, PIN auth (public.ts, internal.ts, actions.ts, sessions.ts, schema.ts)
- `convex/staff/` — staff CRUD + device registration (public.ts, internal.ts). `listActiveManagers` *(v0.5.0)* — session-gated query returning all active managers; used by the booth manager-picker on the charge screen for manager-PIN override flows.
- `convex/catalog/` — products + inventory SKUs + components + stock levels (public.ts, schema.ts)
- `convex/audit/` — append-only audit log (public.ts, internal.ts, schema.ts). `logAudit` is a plain helper called from every state-changing mutation
- `convex/idempotency/` — mutation harness, dedupe helpers (internal.ts, schema.ts)
- `convex/seed/` — dev seeding (internal.ts, actions.ts)
- `convex/transactions/` *(v0.3)* — sale records: `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters` (public.ts, internal.ts, actions.ts, flags.ts, schema.ts). `flags.ts` holds the `NEG_STOCK` bitset. Cart commit + `_confirmPaid` live here. `cancelAwaitingPayment` *(v0.5.0)* — manager-or-self mutation that cancels an `awaiting_payment` transaction and its pending approval requests via `_cancelPendingApprovalsForTxn_internal`.
- `convex/payments/` *(v0.3)* — Xendit charge: `pos_xendit_invoices` audit table (public.ts, internal.ts, actions.ts, webhook.ts, schema.ts). `webhook.ts` is the signature-verified Convex httpAction
- `convex/inventory/` *(v0.3)* — `pos_stock_movements` + `pos_stock_levels` (public.ts, internal.ts, schema.ts). **Moved out of `catalog/` in v0.3** (ADR-034). Sale decrement writes a signed-negative movement
- `convex/vouchers/` *(v0.3)* — `pos_vouchers` + `pos_voucher_redemptions` (public.ts, internal.ts, schema.ts). Discount carried inline (`type`+`value`); one voucher per txn
- `convex/approvals/` *(v0.3+)* — off-booth approval flow: `pos_approval_requests` (public.ts, internal.ts, actions.ts, schema.ts). v0.4 adds `manual_payment_override` kind and `denied` lifecycle state; token collapsed onto the request row. `kinds.ts` *(v0.4)* — `APPROVAL_KINDS` registry: `ApprovalKind` union, `validateContext`, `KIND_AUDIT`, `KIND_TEMPLATE`. This is the canonical touch-point for adding new approval kinds. `cancelPendingRequest` *(v0.5.0)* — manager-gated mutation that transitions a pending request to `denied` (with `denied_by_manager_id: "system"` sentinel) for cleaning up stuck approvals.
- `convex/approvals/lib.ts` *(v0.5.0)* — `effectiveStatus(row)` helper (centralises the four-state lifecycle derivation: pending / resolved / denied / expired) + `TOKEN_PIN_ATTEMPT_CAP` constant (5). Imported by public.ts and actions.ts.
- `convex/settings/` *(v0.4)* — `pos_settings` singleton table (public.ts, internal.ts, schema.ts). `getSettings` / `setFoundersSummaryEnabled` (manager-gated). Internal `_getSettings_internal` returns defaults when the row is absent.
- `convex/crons.ts` *(v0.4)* — registers all Convex cron jobs. Currently: `founders-shift-summary` daily at 22:00 WIB / 15:00 UTC via `telegram/foundersSummary.sendFoundersSummaryResilient`.
- `convex/api/v1/` — external API surface (httpActions for Frollie Pro consumption). v0.2.1: scaffold only — endpoints ship from v0.3
- `convex/telegram/` *(v0.4 rewrite)* — production Telegram integration. Key files:
  - `chatRegistry/public.ts` — manager-session-gated public mutations: `mgrListChats` / `mgrAssignRole` / `mgrArchiveChat` / `mgrRestoreChat` / `mgrSendTest` (public surface at `api.telegram.chatRegistry.public.mgr*`). Split from former `chatRegistry.ts` in v0.5.0 per ADR-034.
  - `chatRegistry/internal.ts` — internal helpers: `getChatIdByRole` (role-based routing with `TELEGRAM_CHAT_ID` env-fallback); `telegramChats` table management; `seedChatFromEnv` one-shot migration bootstrap.
  - `commands.ts` — Telegram bot command handlers (`/register`, `/start`) dispatched by the webhook.
  - `registryCommands.ts` — `buildRegistryCommands` factory that wires commands to the chatRegistry actions.
  - `config.ts` — `KNOWN_TELEGRAM_ROLES`, `isKnownTelegramRole`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_URL` constants.
  - `foundersSummary.ts` — `sendFoundersSummary` (on-demand) + `sendFoundersSummaryResilient` (cron entry-point with cronRetry back-off).
  - `internal.ts` — `_auditSkip_internal` (founders summary audited skip), `_auditSendFailed_internal` (send failure audit). Kept in a plain V8 file because "use node" files may only export actions.
  - `send.ts` — `sendTemplate` (role-routed, typed payload union, action-level idempotent, audited send-failures). `schema.ts` — `telegramChats` + `telegramUpdates` table definitions.
  - `webhook.ts` — Convex HTTP action at `/telegram-webhook` built with `buildHandleTelegramWebhook` + `buildRegistryCommands`; replaces the v0.3 POC callback handler.
- `convex/http.ts` — registers httpAction routes
- `convex/lib/` — cross-cutting utilities (`telegramHtml.ts` message renderers + `sendTelegramHtml` + `escapeHtml` + `formatIdr`; `time.ts` WIB-calendar helpers including `wibDayWindow`; `cronRetry.ts` retry policy constants; `dateAnchors.ts` date window helpers)
- `src/routes/` — page-level routes. Implemented in v0.3: `sale/index` (cart), `sale/drafts`, `sale/voucher`, `sale/charge`, `sale/charge-success`, `approve/index` (`/approve/:token` landing) + `approve/pin`. Added in v0.4: `mgr/telegram-chats` (Telegram chat registry admin — manager session required). Still stubbed: refund, history, settlements, remaining `mgr/*`
- `src/components/ui/` — shadcn primitives (new-york style, stone base): `button`, `badge`, `card`, `input`, `label`, `separator`, `dialog`, `dropdown-menu`, `popover`, `select`, `switch`, `tabs`, `tooltip`, `progress`, `scroll-area`, `sonner` toast
- `src/components/layout/` — `RootLayout` (app shell, session gate), `Stub` (route placeholder), `AppHeader.tsx` *(v0.5.0)* (sticky spoke-route header with back-to-home affordance), `SpokeLayout.tsx` *(v0.5.0)* (wrapper that composes AppHeader into spoke routes)
- `src/components/pos/` — POS-specific shared components. `NumericKeypad` is the canonical PIN + qty input (3-col grid, keyboard-friendly, two sizes via `size: "compact" | "comfortable"`). `PinSheet` *(v0.3)* is the reusable PIN-entry sheet (built on `NumericKeypad`) used by change-PIN, manager reset, and the `/approve/:token` landing. `ApprovalPending` *(v0.4)* — reusable approval-pending overlay: subscribes to `approvals.public.getRequestStatus`, renders status (pending/resolved/denied/expired) reactively, and renders the correct CTA for each state. `AbandonCartDialog.tsx` *(v0.5.0)* — shared dialog for cart-abandon (Save as draft / Discard / Cancel) and cancel-payment (Cancel payment / Keep waiting) flows; variant-controlled via props.
- `src/hooks/` — `useDeviceId`, `useSession`, `useCatalogCache`, `useIdempotency` (v0.3: IDB-backed so a reload mid-payment doesn't double-execute). Added in v0.3: `useCart`, `useOfflineQueue`, `useXenditPayment`, `useStartupReconciliation` (no-op shell since [ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) downgraded the ADR-026 re-check to manual-only). Added in v0.4: `useApproval` — reactive hook that wraps `approvals.public.getRequestStatus` + `requestManualPaymentApproval` action dispatch + idempotency key lifecycle; used by `ApprovalPending` and the charge screen. Added in v0.5.0: `useLastStaff` — persists the last logged-in staff ID to localStorage for the lock-resume UX (pre-stages PIN entry for returning staffer); `useCountdown` — generic mm:ss countdown driven by an expiry timestamp (used by the charge-screen invoice countdown).
- `src/lib/utils.ts` — `cn()` helper (clsx + tailwind-merge). Other utilities (`format.ts`, `wa-link.ts`, `receipt-template.ts`) land per phase
- `src/lib/storage-keys.ts` *(v0.5.0)* — centralised localStorage key namespace. All constants exported from here; `storeSession(sessionId, staffId)` writes both `SESSION_KEY` and `STAFF_KEY` atomically. Import from here rather than inlining bare strings.
- `src/pwa/` — service worker bootstrap (vite-plugin-pwa handles registration)
- `docs/SCHEMA.md` — POS tables plus relationship to Frollie Pro schema
- `docs/ADR/` — 37 numbered ADRs (ADR-037 added in v0.4) + `000-strategic-foundations.md` for the consolidated strategic decisions
- `docs/DECISIONS.md` — product and flow decisions (not architectural) — legacy reference
- `docs/CHANGELOG.md` — version history
- `docs/WORKFLOW.md` — references Frollie Pro's; documents POS-specific deviations
- `docs/API_REFERENCE.md` — Convex function reference
- `frollie-pos design files/` — wireframe handoff bundle (NOT committed; in `.gitignore`). Source of truth for screen layouts and the 33-ADR registry
- `archive/files.zip` — original delivery bundle (NOT committed)
- `packages/ceo-progress-report/` — frozen v0.1.0 snapshot of the PROGRESS.md → progress.html renderer + Claude Code plugin. **Snapshot retired as the build path** — the rendered board is now generated by the published [`ceo-progress-report`](https://www.npmjs.com/package/ceo-progress-report) npm package (in devDependencies), via `npx ceo-report build --src docs/PROGRESS.md --out docs/progress.html`, configured by `buildlog.config.mjs` at the repo root. The in-tree `scripts/build-progress-html.mjs` was deleted in the cutover. Future renderer development happens in the standalone repo at [lucasyhzhu-debug/ceo-progress-report](https://github.com/lucasyhzhu-debug/ceo-progress-report), not here.
- `buildlog.config.mjs` — config for `ceo-report build` (title/monogram/location/lanes). Replaces the hardcoded values that lived in the retired in-tree script.

## Commands

```bash
# install
npm install

# dev (two terminals)
npm run dev               # vite dev server on :5173
npx convex dev            # convex local dev (deployment: helpful-grasshopper-46)

# build
npm run build             # tsc -b && vite build
npm run typecheck         # tsc --noEmit
npm run lint

# deploy
npm run deploy            # frontend to vercel
npx convex deploy         # backend to convex prod (POS prod deployment — own project)
```

## Convex deployment

POS has its **own Convex project**, separate from `product_master`. Two deployments:

- **dev:** `helpful-grasshopper-46` — `https://helpful-grasshopper-46.convex.cloud` (client / WS) and `https://helpful-grasshopper-46.convex.site` (httpAction webhooks). Currently set in `.env.local` as `VITE_CONVEX_URL`. This is what `npx convex dev` targets.
- **prod:** `savory-zebra-800` — `https://savory-zebra-800.convex.cloud` (client / WS) and `https://savory-zebra-800.convex.site` (httpAction webhooks). Populated via `npx convex deploy`. The Vercel build must inject this URL as `VITE_CONVEX_URL`, not the dev one.

If you need to add a table, update `convex/schema.ts` in this repo — POS tables live here independently of `product_master`. Where POS mirrors a Frollie Pro concept (e.g., a `products` analogue), pattern your schema after `product_master`'s, but the tables themselves are POS-owned. v1.1+ may sync `products` data from `product_master` via a cross-deployment integration; that integration is not in v1.

## Xendit integration notes

- Test mode keys in `.env.local`, prod keys in Vercel + Convex env.
- **QRIS** uses the **QR Codes API** (`POST /qr_codes`, returns inline `qr_string`). **BCA VA** uses the **Virtual Accounts (FVA) API** (`POST /callback_virtual_accounts`, returns inline `account_number`). Both render inside the POS — no redirect to a hosted invoice page. The Invoice API (`POST /v2/invoices`) is **not used** ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) supersedes [ADR-011](./docs/ADR/011-qris-via-xendit-bca-va-secondary.md)).
- **`api-version: 2022-07-31` header is load-bearing** on QR creation — without it, the `qr.payment` webhook never fires. Asserted by the `buildQrisHeaders()` unit test.
- Webhook endpoint: `convex/payments/webhook.ts` exposed as a Convex HTTP action. **Signature verification mandatory** via `XENDIT_CALLBACK_TOKEN`. Always returns 200 (missing config or wrong token → 401). Parses two webhook shapes: QRIS (`event: "qr.payment"`, match on `data.qr_id`, status `SUCCEEDED`) and BCA VA (flat FVA callback, match on `callback_virtual_account_id`).
- **No polling.** Polling retired for QRIS/FVA — confirmation paths are webhook + manager-PIN manual override only.
- **Idempotency at two levels:** every public mutation has client-supplied `idempotencyKey` ([ADR-013](./docs/ADR/013-idempotency-keys.md)); webhook handler also dedupes by `xendit_invoice_id` because Xendit retries.
- **Single active invoice per transaction (local supersede):** on cart edit + retry, mint a fresh QR/VA and mark the prior `pos_xendit_invoices` row cancelled + `replaced_by_invoice_id` locally. No Xendit cancel-API call for QR codes ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) adjusts [ADR-014](./docs/ADR/014-single-xendit-invoice-per-transaction.md)). Prior invoice ids audit-logged to `pos_xendit_invoices`.

## Auth

PIN-based ([ADR-001](./docs/ADR/001-pin-only-authentication.md)). 4 digits, **argon2id** hashed in a Convex action ([ADR-004](./docs/ADR/004-pin-hashing-server-side.md)) (not a mutation — bcrypt/argon2id verify is long-running and would block the event loop in a mutation). Session is a row in `staff_sessions`; no auto-logout, ends on explicit Lock ([ADR-003](./docs/ADR/003-shared-device-ephemeral-session.md)). Three failed PINs in a row = 60-second lockout for that staff record, persisted in `pos_auth_attempts` ([ADR-002](./docs/ADR/002-lockout-policy.md)).

Devices must be registered ([strategic foundations §6](./docs/ADR/000-strategic-foundations.md#6-device-registration-before-login-security-control)). A one-time 6-digit setup code from a manager activates a device. Sessions bound to `device_id`.

Manager actions ([ADR-005](./docs/ADR/005-manager-pin-one-off.md)) are **one-off PIN entries**, not persistent modes. From v0.4, off-booth flows (PIN resets, manual payment overrides) route through the **Telegram approval flow** ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md), superseding [ADR-027](./docs/ADR/027-wa-approval-via-staff-own-wa.md) for these flows) when no manager is at the booth. The audit `source` for all off-booth approve/deny actions is `telegram_approval`; the legacy `wa_approval` literal is preserved in the schema for rows created by v0.3 but no production code emits it post-v0.4.

**PIN management (v0.3):** three flows, one commit funnel (`_changePinCommit_internal` — see business rule #19).

- **`auth.changePin` (self):** staff change their own PIN. Verifies the current PIN with argon2, rejects same-PIN, respects lockout. Logs `staff.pin_changed`.
- **`auth.resetStaffPin` (manager at booth):** a manager resets a target staff PIN by proving the **manager's own** PIN (never the target's). Rejects self-reset (use `changePin`), rejects non-managers. On commit it clears the target's lockout and logs `staff.pin_reset` (`source: booth_inline`).
- **Off-booth lockout → reset (Telegram, [ADR-035](./docs/ADR/035-telegram-as-internal-comms.md) + [ADR-029](./docs/ADR/029-token-authorizes-view-pin-authorizes-act.md)):** a 3-strike lockout schedules `approvals.notifyStaffLockout`, which mints a 32-byte URL-safe token (only the SHA-256 hash is persisted on the `pos_approval_requests` row), posts a single-use 60-minute `/approve/:token` URL button to the managers' **Telegram** group via `sendTemplate`, and stamps `notified_at`. A dedup guard skips a second notification while a live pending request exists; if the Telegram send fails the pending row is deleted so the next cycle retries cleanly. A manager opens the link (**token authorises VIEW**), enters their own manager PIN (**PIN authorises ACT**), and `approvals.approveStaffPinReset` verifies the PIN, commits the reset via the shared funnel (`source: telegram_approval`, logs `staff.pin_reset`), and marks the request `resolved`. A locked-out manager can still approve their own reset link — the token + correct PIN are sufficient authority (lockout state is deliberately not re-checked on the approve path).

## Crons

Registered in `convex/crons.ts`. One job currently:

- **`founders-shift-summary`** — fires daily at **22:00 WIB / 15:00 UTC**. Calls `telegram/foundersSummary.sendFoundersSummaryResilient` with `{ attempt: 0 }`. The resilient wrapper retries transient errors up to `RESILIENT_MAX_ATTEMPTS` times with linear back-off; non-transient errors surface in the Convex cron dashboard. An audited skip (`founders.summary_skipped`) is written when the `founders_summary_enabled` toggle is off or when the `founders` Telegram role is unbound — neither case causes a retry storm.

To fire on-demand (dev or manual re-trigger): `npx convex run telegram/foundersSummary:sendFoundersSummary` (requires the `founders` role to be bound and the toggle to be on).

## Required environment variables (Telegram)

Set these on both dev (`npx convex env set KEY VALUE`) and prod (`npx convex env set KEY VALUE --prod`):

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From BotFather. Never share. Use separate bots for dev and prod. |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Random string; passed as `secret_token` to `setWebhook`. Verified on every inbound update. |
| `POS_BASE_URL` | Yes | Base URL of the frontend (e.g. `https://frollie-pos.vercel.app`). Used to build `/approve/:token` URLs in Telegram messages. |
| `TELEGRAM_CHAT_ID` | Fallback only | Legacy env-fallback for the `managers` role until `getChatIdByRole` finds a bound row. Required during initial setup before the `/mgr/telegram-chats` UI is used to assign roles. Keep set during prod cutover. |
| `TELEGRAM_FALLBACK_ROLE` | Fallback only | Which role the `TELEGRAM_CHAT_ID` fallback applies to (usually `managers`). Must match `TELEGRAM_CHAT_ID` to make the fallback work. |
| `TELEGRAM_BOT_USERNAME` | Optional | Used in `/start` help text and test-message copy. Defaults to `FrolliePOS_Bot` in `config.ts`. |
| `TELEGRAM_ADMIN_URL` | Optional | URL to the `/mgr/telegram-chats` admin UI. Shown in `/register` confirmation messages. Defaults to `POS_BASE_URL/mgr/telegram-chats`. |

## How to add a feature

1. Read the relevant ADR(s) in `docs/ADR/`. For strategic context, read [`000-strategic-foundations.md`](./docs/ADR/000-strategic-foundations.md).
2. Check if Frollie Pro already has a pattern for this. If yes, reuse. If no, document the new pattern in `docs/DECISIONS.md`.
3. If the feature adds a table or column, update `docs/SCHEMA.md` first, then `convex/schema.ts`.
4. If the feature is a state-changing action, add it to the audit action enum in `convex/audit.ts` and `docs/SCHEMA.md`, and emit a `logAudit` row from the mutation.
5. If the feature is a public mutation, accept `idempotencyKey` in args and wrap with the idempotency helper.
6. If the feature is a manager-PIN gate, decide: inline (manager at booth) or Telegram-approval (the v0.4+ default for off-booth flows). Both update the same `pos_approval_requests` row for audit coherence.
7. If the feature affects payment, refund, or stock, write tests. Other features, tests are optional but encouraged.
8. If the feature adds a new **approval KIND** (the v0.4+ pattern — refund, manual-payment override, etc.), wire all four touch-points so the off-booth flow stays coherent: (a) add the literal to `convex/approvals/kinds.ts` — the `ApprovalKind` union, the `validateContext` switch case, `KIND_AUDIT`, and `KIND_TEMPLATE`. Then add the matching validator to `approvals/schema.ts` `kind` union and `approvals/internal.ts`; (b) add a Telegram template kind — a new literal in `sendTemplate`'s `kind` union in `convex/telegram/send.ts` plus a `renderXxx` payload type + renderer in `convex/lib/telegramHtml.ts`. The message must use a URL button (not `callback_data`) pointing at `${POS_BASE_URL}/approve/${rawToken}`; (c) add the UI variant to the `/approve/:token` landing in `src/routes/approve/index.tsx` (token authorises VIEW — discriminate on `kind` in the `getByToken` result) and the PIN continuation `approve/pin.tsx` (PIN authorises ACT); (d) add a public action to `convex/approvals/actions.ts` (or a new `approvals/<kind>.ts`) that follows the `requestManualPaymentApproval` / `approveManualPayment` / `denyRequest` pattern: mint token → `_createRequest_internal` → `sendTemplate` → `_markNotified_internal`, approve via argon2 verify + kind-specific funnel → `_markResolved_internal`, deny via `denyRequest` (already kind-agnostic). Reuse `_createRequest_internal` / `_markNotified_internal` / `_markResolved_internal` / `_markDenied_internal` rather than hand-rolling lifecycle writes. Thread `source: "telegram_approval"` to every audit-emitting mutation so the audit trail is consistent. The mgr admin surface lives at `api.telegram.chatRegistry.public.mgr*` (NOT `api.telegram.mgrAdmin.*`).
9. Update `docs/CHANGELOG.md` in the same PR.

## When to push back on the request

- **"Add cash handling."** Future phase, not v1. See [ADR-006](./docs/ADR/006-no-cash-no-shift-open-close.md).
- **"Track packaging stock."** Out of scope. POS is finished-goods only ([strategic foundations §5](./docs/ADR/000-strategic-foundations.md#5-finished-goods-only--no-kitchen-inventory-in-v1)).
- **"Add a customer-facing screen."** Out of scope. Staff + manager only.
- **"Switch to Firebase / Supabase / a different backend."** Requires an ADR with strong justification against Frollie Pro alignment.
- **"Add multi-stall."** Future phase. Schema is single-tenant in v1.
- **"Allow voucher stacking."** Rejected by [ADR-010](./docs/ADR/010-no-voucher-stacking.md). Combinatorics not justified by business.
- **"Hard-block sales at zero stock."** Rejected by [ADR-018](./docs/ADR/018-negative-stock-allowed-flagged.md). Counter velocity > pre-sale blocking.
- **"Use the WhatsApp Cloud API for the approval flow."** v1.1+ consideration. v1 uses Telegram for off-booth approvals ([ADR-035](./docs/ADR/035-telegram-as-internal-comms.md)). The wa.me share-intent model ([ADR-027](./docs/ADR/027-wa-approval-via-staff-own-wa.md)) was the v0.2/v0.3 design; Telegram graduated it in v0.3/v0.4.
- **"Skip idempotency, just disable the button while in-flight."** Doesn't cover network retries, service-worker re-fires, or page reloads mid-action. See [ADR-013](./docs/ADR/013-idempotency-keys.md).

## When in doubt

Ask. Don't ship an assumption that locks the Frollie Pro graft. The cost of clarifying is one message. The cost of a bad foundation is a rewrite.

## Wireframe bundle reference

The screen designs live at `frollie-pos design files/project/Frollie POS Wireframes.html`. That file is the canonical IA + flow source for v0.5 — when implementing a screen, open the corresponding artboard's source (`wireframes/<name>.jsx`) for layout intent. The hand-drawn aesthetic in the wireframes is a *wireframe convention* — implement in production-polish using the shadcn/Tailwind tokens in `src/index.css`, not the sketch fonts.

## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows.
Install it for the best experience:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Skills like /qa, /ship, /review, /investigate, and /browse become available after install.
Use /browse for all web browsing. Use ~/.claude/skills/gstack/... for gstack file paths.
