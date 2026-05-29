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
6. **After any `/progress-update`**: run `node scripts/build-progress-html.mjs` to regenerate the HTML view. (Cheap — ~50ms. Skipping it leaves the rendered board stale.)

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
10. **WhatsApp approval routes manager-PIN gates** to the **Frollie · Managers** group via wa.me share-intent. Any manager in the group can approve from anywhere by tapping the link + entering their PIN ([ADR-027](./docs/ADR/027-wa-approval-via-staff-own-wa.md)). No business bot; sends come from the staff member's own WhatsApp.
11. **Approval tokens authorise VIEW; PINs authorise ACT** ([ADR-029](./docs/ADR/029-token-authorizes-view-pin-authorizes-act.md)). Token = 32-byte URL-safe random, single-use, 60-minute TTL.
12. **Founders shift-summary share** uses the same wa.me model — Lock screen has an opt-in toggle (default ON), posts a structured summary to **Frollie · Founders** ([ADR-033](./docs/ADR/033-founders-shift-summary-share.md)).
13. **Vouchers are static**, manager-created, manager-distributed out-of-band. No voucher stacking ([ADR-010](./docs/ADR/010-no-voucher-stacking.md)). Cached on device for offline apply, server re-validates on sync ([ADR-009](./docs/ADR/009-voucher-cache-offline.md)).
14. **All money as integer rupiah.** No floats, no cents. Format with `Intl.NumberFormat("id-ID")` in `src/lib/format.ts` ([ADR-015](./docs/ADR/015-idr-integer-rupiah.md)).
15. **Every public mutation accepts `idempotencyKey`.** Server dedupes for 24h via `pos_idempotency` ([ADR-013](./docs/ADR/013-idempotency-keys.md)). Mutation harness wraps every public mutation so individual functions don't have to think about it.
16. **Server time wins.** Every `_at` field is set via `Date.now()` inside the Convex function — never client-supplied ([ADR-031](./docs/ADR/031-convex-server-time-wins.md)).
17. **PWA partial offline:** catalog cached, cart builds, drafts queue, stock-in queues. Payments / auth / refunds block offline with clear UI ([ADR-025](./docs/ADR/025-service-worker-cache.md)).
18. **Reconciliation on reload (QRIS/FVA — manual-only):** `useStartupReconciliation` is a thin no-op shell — the poll body was gutted because QR status polling is architecturally impossible and the `checkInvoiceStatus` action was removed ([ADR-036](./docs/ADR/036-xendit-dedicated-apis-inline.md) amends [ADR-026](./docs/ADR/026-reconciliation-on-reload.md)). Missed-webhook recovery for QRIS/BCA VA is manager-PIN manual override only. Double-decrement is still prevented by the `pos_stock_movements.by_line_and_sku` index — one `sale` movement per `(source_transaction_line_id, inventory_sku_id)`. *(v0.3 shipped this index rather than a unique `(ref_type, ref_id, sku_id)` constraint.)*
19. **PIN changes funnel through one mutation.** `auth.changePin` (self), `auth.resetStaffPin` (manager at booth), and `approvals.approveStaffPinReset` (off-booth) all commit via the shared internal `_changePinCommit_internal`. Branch on `actor.kind`: `"self"` → logs `staff.pin_changed`; `"manager_reset"` → logs `staff.pin_reset`, clears `pos_auth_attempts` (lockout unwind), and stamps `source` (`booth_inline` at booth, `wa_approval` off-booth). Never log PIN values — the payload has no PIN fields. Don't add a fourth reset path that bypasses this funnel.

## File locations

- `convex/` — Convex backend, organized by domain module per [ADR-034](./docs/ADR/034-deep-modules-surface-apis.md)
- `convex/schema.ts` — root schema, composed from per-module fragments
- `convex/auth/` — staff, sessions, devices, PIN auth (public.ts, internal.ts, actions.ts, sessions.ts, schema.ts)
- `convex/staff/` — staff CRUD + device registration (public.ts, internal.ts)
- `convex/catalog/` — products + inventory SKUs + components + stock levels (public.ts, schema.ts)
- `convex/audit/` — append-only audit log (public.ts, internal.ts, schema.ts). `logAudit` is a plain helper called from every state-changing mutation
- `convex/idempotency/` — mutation harness, dedupe helpers (internal.ts, schema.ts)
- `convex/seed/` — dev seeding (internal.ts, actions.ts)
- `convex/transactions/` *(v0.3)* — sale records: `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters` (public.ts, internal.ts, actions.ts, flags.ts, schema.ts). `flags.ts` holds the `NEG_STOCK` bitset. Cart commit + `_confirmPaid` live here
- `convex/payments/` *(v0.3)* — Xendit charge: `pos_xendit_invoices` audit table (public.ts, internal.ts, actions.ts, webhook.ts, schema.ts). `webhook.ts` is the signature-verified Convex httpAction
- `convex/inventory/` *(v0.3)* — `pos_stock_movements` + `pos_stock_levels` (public.ts, internal.ts, schema.ts). **Moved out of `catalog/` in v0.3** (ADR-034). Sale decrement writes a signed-negative movement
- `convex/vouchers/` *(v0.3)* — `pos_vouchers` + `pos_voucher_redemptions` (public.ts, internal.ts, schema.ts). Discount carried inline (`type`+`value`); one voucher per txn
- `convex/approvals/` *(v0.3)* — off-booth approval flow: `pos_approval_requests` (public.ts, internal.ts, actions.ts, schema.ts). v0.3 kind = `staff_pin_reset` only; token collapsed onto the request row
- `convex/api/v1/` — external API surface (httpActions for Frollie Pro consumption). v0.2.1: scaffold only — endpoints ship from v0.3
- `convex/telegram/` — Telegram bot POC (queries.ts, send.ts, webhook.ts, schema.ts). v0.3 uses `telegram:send:sendTemplate` (kind `staff_pin_reset`) for the off-booth lockout link (ADR-035). Graduates to `convex/approvals/telegram/` in v0.4
- `convex/http.ts` — registers httpAction routes
- `convex/lib/` — cross-cutting utilities (`telegramHtml.ts` message renderers, `time.ts` WIB-calendar helpers)
- `src/routes/` — page-level routes. Implemented in v0.3: `sale/index` (cart), `sale/drafts`, `sale/voucher`, `sale/charge`, `sale/charge-success`, `approve/index` (`/approve/:token` landing) + `approve/pin`. Still stubbed: refund, history, settlements, mgr/*
- `src/components/ui/` — shadcn primitives (new-york style, stone base): `button`, `badge`, `card`, `input`, `label`, `separator`, `dialog`, `dropdown-menu`, `popover`, `select`, `switch`, `tabs`, `tooltip`, `progress`, `scroll-area`, `sonner` toast
- `src/components/layout/` — `RootLayout` (app shell, session gate), `Stub` (route placeholder)
- `src/components/pos/` — POS-specific shared components. `NumericKeypad` is the canonical PIN + qty input (3-col grid, keyboard-friendly, two sizes via `size: "compact" | "comfortable"`). `PinSheet` *(v0.3)* is the reusable PIN-entry sheet (built on `NumericKeypad`) used by change-PIN, manager reset, and the `/approve/:token` landing
- `src/hooks/` — `useDeviceId`, `useSession`, `useCatalogCache`, `useIdempotency` (v0.3: IDB-backed so a reload mid-payment doesn't double-execute). Added in v0.3: `useCart`, `useOfflineQueue`, `useXenditPayment`, `useStartupReconciliation` (ADR-026 re-check on startup)
- `src/lib/utils.ts` — `cn()` helper (clsx + tailwind-merge). Other utilities (`format.ts`, `wa-link.ts`, `receipt-template.ts`) land per phase
- `src/pwa/` — service worker bootstrap (vite-plugin-pwa handles registration)
- `docs/SCHEMA.md` — POS tables plus relationship to Frollie Pro schema
- `docs/ADR/` — 33 numbered ADRs + `000-strategic-foundations.md` for the consolidated strategic decisions
- `docs/DECISIONS.md` — product and flow decisions (not architectural) — legacy reference
- `docs/CHANGELOG.md` — version history
- `docs/WORKFLOW.md` — references Frollie Pro's; documents POS-specific deviations
- `docs/API_REFERENCE.md` — Convex function reference
- `frollie-pos design files/` — wireframe handoff bundle (NOT committed; in `.gitignore`). Source of truth for screen layouts and the 33-ADR registry
- `archive/files.zip` — original delivery bundle (NOT committed)
- `packages/ceo-progress-report/` — extracted PROGRESS.md → progress.html renderer + Claude Code plugin. **Published as [`ceo-progress-report`](https://www.npmjs.com/package/ceo-progress-report) on npm and as a standalone repo at [lucasyhzhu-debug/ceo-progress-report](https://github.com/lucasyhzhu-debug/ceo-progress-report).** The package in this directory is a frozen snapshot at v0.1.0; future development happens in the standalone repo, not here. **Hard commitment: immediately after Frollie POS v0.3 ships to prod, retire `scripts/build-progress-html.mjs` and replace all callers with `npx ceo-report build`.** See [the original extraction plan](./docs/superpowers/plans/2026-05-27-ceo-progress-report-extraction.md) §"Open follow-ups #5".

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

Manager actions ([ADR-005](./docs/ADR/005-manager-pin-one-off.md)) are **one-off PIN entries**, not persistent modes. From v0.4 they route through the **WhatsApp approval flow** ([ADR-027](./docs/ADR/027-wa-approval-via-staff-own-wa.md)) when no manager is at the booth.

**PIN management (v0.3):** three flows, one commit funnel (`_changePinCommit_internal` — see business rule #19).

- **`auth.changePin` (self):** staff change their own PIN. Verifies the current PIN with argon2, rejects same-PIN, respects lockout. Logs `staff.pin_changed`.
- **`auth.resetStaffPin` (manager at booth):** a manager resets a target staff PIN by proving the **manager's own** PIN (never the target's). Rejects self-reset (use `changePin`), rejects non-managers. On commit it clears the target's lockout and logs `staff.pin_reset` (`source: booth_inline`).
- **Off-booth lockout → reset (Telegram, [ADR-035](./docs/ADR/035-telegram-as-internal-comms.md) + [ADR-029](./docs/ADR/029-token-authorizes-view-pin-authorizes-act.md)):** a 3-strike lockout schedules `approvals.notifyStaffLockout`, which mints a 32-byte URL-safe token (only the SHA-256 hash is persisted on the `pos_approval_requests` row), posts a single-use 60-minute `/approve/:token` link to the managers' **Telegram** group, and stamps `notified_at`. A dedup guard skips a second notification while a live pending request exists; if the Telegram send fails the pending row is deleted so the next cycle retries cleanly. A manager opens the link (**token authorises VIEW**), enters their own manager PIN (**PIN authorises ACT**), and `approvals.approveStaffPinReset` verifies the PIN, commits the reset via the same funnel (`source: wa_approval`, logs `staff.pin_reset`), and marks the request `resolved`. A locked-out manager can still approve their own reset link — the token + correct PIN are sufficient authority.

## How to add a feature

1. Read the relevant ADR(s) in `docs/ADR/`. For strategic context, read [`000-strategic-foundations.md`](./docs/ADR/000-strategic-foundations.md).
2. Check if Frollie Pro already has a pattern for this. If yes, reuse. If no, document the new pattern in `docs/DECISIONS.md`.
3. If the feature adds a table or column, update `docs/SCHEMA.md` first, then `convex/schema.ts`.
4. If the feature is a state-changing action, add it to the audit action enum in `convex/audit.ts` and `docs/SCHEMA.md`, and emit a `logAudit` row from the mutation.
5. If the feature is a public mutation, accept `idempotencyKey` in args and wrap with the idempotency helper.
6. If the feature is a manager-PIN gate, decide: inline (manager at booth) or WA-approval (the v0.4+ default). Both update the same `pos_approval_requests` row for audit coherence.
7. If the feature affects payment, refund, or stock, write tests. Other features, tests are optional but encouraged.
8. If the feature adds a new **approval KIND** (the v0.4+ pattern — refund, manual-payment override, etc.), wire all four touch-points so the off-booth flow stays coherent: (a) add the literal to the `pos_approval_requests.kind` union in `convex/approvals/schema.ts` (and the matching arg validators in `approvals/internal.ts` + `approvals/actions.ts`); (b) add a Telegram template kind — a new literal in `sendTemplate`'s `kind` union in `convex/telegram/send.ts` plus a `renderXxx` payload type + renderer in `convex/lib/telegramHtml.ts`; (c) add the UI variant to the `/approve/:token` landing in `src/routes/approve/index.tsx` (token authorises VIEW) and its PIN continuation `approve/pin.tsx` (PIN authorises ACT); (d) commit the state change through an internal funnel so the audit + idempotency story matches the PIN-reset path. Reuse `_createRequest_internal` / `_markNotified_internal` / `_markResolved_internal` rather than hand-rolling lifecycle writes.
9. Update `docs/CHANGELOG.md` in the same PR.

## When to push back on the request

- **"Add cash handling."** Future phase, not v1. See [ADR-006](./docs/ADR/006-no-cash-no-shift-open-close.md).
- **"Track packaging stock."** Out of scope. POS is finished-goods only ([strategic foundations §5](./docs/ADR/000-strategic-foundations.md#5-finished-goods-only--no-kitchen-inventory-in-v1)).
- **"Add a customer-facing screen."** Out of scope. Staff + manager only.
- **"Switch to Firebase / Supabase / a different backend."** Requires an ADR with strong justification against Frollie Pro alignment.
- **"Add multi-stall."** Future phase. Schema is single-tenant in v1.
- **"Allow voucher stacking."** Rejected by [ADR-010](./docs/ADR/010-no-voucher-stacking.md). Combinatorics not justified by business.
- **"Hard-block sales at zero stock."** Rejected by [ADR-018](./docs/ADR/018-negative-stock-allowed-flagged.md). Counter velocity > pre-sale blocking.
- **"Use the WhatsApp Cloud API for the approval flow."** v1.1+ consideration. v1 uses wa.me share-intent for zero infra ([ADR-027](./docs/ADR/027-wa-approval-via-staff-own-wa.md)).
- **"Skip idempotency, just disable the button while in-flight."** Doesn't cover network retries, service-worker re-fires, or page reloads mid-action. See [ADR-013](./docs/ADR/013-idempotency-keys.md).

## When in doubt

Ask. Don't ship an assumption that locks the Frollie Pro graft. The cost of clarifying is one message. The cost of a bad foundation is a rewrite.

## Wireframe bundle reference

The screen designs live at `frollie-pos design files/project/Frollie POS Wireframes.html`. That file is the canonical IA + flow source for v0.5 — when implementing a screen, open the corresponding artboard's source (`wireframes/<name>.jsx`) for layout intent. The hand-drawn aesthetic in the wireframes is a *wireframe convention* — implement in production-polish using the shadcn/Tailwind tokens in `src/index.css`, not the sketch fonts.

## Post-v0.3 tracking note: retire `scripts/build-progress-html.mjs`

**For the agent picking this up after Frollie POS v0.3 ships to prod.**

The 2343-line in-tree script at `scripts/build-progress-html.mjs` was extracted into a published npm package + Claude Code plugin (`ceo-progress-report`) on 2026-05-27. The in-tree script and the package's `src/render.mjs` are byte-equivalent renderers at extraction time (golden-diff verified). Maintaining two copies is a known drift risk explicitly called out in the extraction plan.

**Hard commitment from the extraction plan:** retire `scripts/build-progress-html.mjs` IMMEDIATELY after Frollie POS v0.3 ships to prod.

**Concrete steps when the time comes:**

1. Add the package to Frollie's npm devDependencies: `npm install --save-dev ceo-progress-report`.
2. Create a `buildlog.config.mjs` at the project root with Frollie's values (title "Frollie POS", monogram "F", location "Jakarta", v1Label "v1.0"). The temp config at `.cpr-tmp/frollie.config.mjs` (gitignored) is the template.
3. Replace `node scripts/build-progress-html.mjs` everywhere it's referenced with `npx ceo-report build`. Known call sites:
   - The `/progress-update` skill workflow in this CLAUDE.md (search for "build-progress-html")
   - Any GH Action or pre-commit hook (currently none, but check)
   - Manual invocations documented in `docs/PROGRESS.md` (search for the same string)
4. Delete `scripts/build-progress-html.mjs`.
5. Verify: run `npx ceo-report build` and confirm `docs/progress.html` regenerates with the expected output (compare against a previous commit's progress.html via timestamp-stripped diff).
6. Update this CLAUDE.md: remove this whole section, change the `packages/ceo-progress-report/` bullet in "File locations" to say "snapshot retired, see npm package" (or delete the snapshot dir entirely if you're feeling tidy).

The plan reference: [`docs/superpowers/plans/2026-05-27-ceo-progress-report-extraction.md`](./docs/superpowers/plans/2026-05-27-ceo-progress-report-extraction.md) — search for "Open follow-ups #5" for the original commitment.
