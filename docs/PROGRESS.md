# Progress

Living kanban for Frollie POS. Update as work lands. AI agents read this before starting a task and update it after.

**Legend:** ✅ done · 🔄 in progress · 📋 planned (next up) · 🗂️ backlog (not yet planned)

**Source of truth:** phase definitions come from [`WORKFLOW.md` § Releases](./WORKFLOW.md#releases). Behaviour rules come from [`ADR/`](./ADR/). Screen layouts come from `frollie-pos design files/project/wireframes/*.jsx` (gitignored — local only).

**How to read a row:** each phase is broken into three lanes — **Backend** (`convex/`), **Frontend** (`src/`), **Cross-cutting** (ADRs, schema, infra). A phase ships when every item in every lane is ✅.

---

## v0.2 — auth + catalog ✅ SHIPPED
Merged 2026-05-26 via PR #1 (commit `c051211`). 110 tests passing.

### Backend (`convex/`)
- ✅ `schema.ts` — 11 tables (staff, sessions, auth_attempts, devices, pending_setups, inventory_skus, products, components, stock_levels, idempotency, audit_log)
- ✅ `auth.ts` + `authActions.ts` — argon2id PIN hashing in Node action, V8/Node split per ADR-004; 3-strike 60s lockout (ADR-002); idempotent fail-record; repeat-lock audit
- ✅ `staff.ts` — `createStaff`, device registration (`generateDeviceSetupCode`, `activateDevice` with crypto-secure codes), `isDeviceRegistered`
- ✅ `products.ts` — `catalog` query (filtered by active product + active SKU)
- ✅ `audit.ts` — append-only `logAudit` helper, manager-gated `list` query (ADR-007)
- ✅ `idempotency.ts` — `withIdempotency` HOF with pre-cache `authCheck`, duplicate-tolerant reads (ADR-013)
- ✅ `seed.ts` + `seedActions.ts` — dev-only reset with prod-slug deny-list

### Frontend (`src/`)
- ✅ `hooks/useSession.ts` — localStorage + Convex validation, same-tab subscriber sync
- ✅ `hooks/useDeviceId.ts` — localStorage + IDB backup (strategic-§6), returns null while resolving
- ✅ `hooks/useIdempotency.ts` — stable UUID per intent
- ✅ `hooks/useCatalogCache.ts` — IDB snapshot of catalog (ADR-025), Effect race-guard
- ✅ `lib/format.ts` — `rp()` (IDR) + Jakarta-tz date helpers (ADR-015)
- ✅ `components/layout/{ConnDot, DeviceActivation, RootLayout}` — gates, connection indicator
- ✅ `components/auth/{PinEntry, StaffListItem}` — 4-dot indicator + NumericKeypad
- ✅ `routes/{login, home, activate}` — LoginA + HomeNav wireframes
- ✅ `router.tsx` — `/activate` public route added

### Cross-cutting
- ✅ vitest + jsdom (frontend) + edge-runtime (backend) env split, convex-test, fake-indexeddb
- ✅ TDD per task, atomic commits, every public mutation accepts `idempotencyKey`
- ✅ ADRs honored: 001-005 (auth), 007 (audit), 013 (idempotency), 015 (IDR), 016+017 (product/inventory split), 025 (offline catalog), 031 (server time), strategic-§1 + §6

### v0.2 follow-ups deferred to later phases
- 🗂️ `useIdempotency` IDB persistence → v0.3 (when payments expose the cost of reload-mid-payment)
- 🗂️ `withIdempotency` error-caching design re-evaluation → v0.3
- 🗂️ `listStaff` pin_hash strip → v0.5 (when manager portal lands)
- 🗂️ `rp()` negative-amount handling → v0.5 (refunds)
- 🗂️ Playwright E2E for offline catalog + device activation → v0.6

---

## v0.3 — sale flow + Xendit 📋 PLANNED (next up)
Plan to be written. Scope per WORKFLOW.md: sale flow + QRIS + BCA VA + webhook + idempotency harness updates.

### Backend (`convex/`)
- 📋 `transactions.ts` — cart, draft, void; snapshot prices + names on lines (CLAUDE.md rule 1)
- 📋 `payments.ts` — Xendit Invoice API lifecycle, single active invoice per txn (ADR-014)
- 📋 `xendit/invoice.ts` — invoice creation with `payment_methods: ["QRIS", "BCA"]` (ADR-011)
- 📋 `xendit/webhook.ts` — Convex `httpAction`, **signature verification mandatory** via `XENDIT_CALLBACK_TOKEN`
- 📋 `xendit/polling.ts` — fallback after 2s, every 2s, 60s ceiling (strategic-§8)
- 📋 `transactions.ts` updates — drafts queue, `pos_drafts` table

### Frontend (`src/`)
- 📋 `routes/sale.tsx` — CartA wireframe (`sale.jsx` artboard)
- 📋 `routes/sale/drafts.tsx` — saved drafts list
- 📋 `routes/sale/voucher.tsx` — voucher apply (cached, ADR-009)
- 📋 `routes/sale/charge.tsx` — ChargeA wireframe (QR + BCA VA toggle)
- 📋 `routes/sale/charge-success.tsx` — paid confirmation
- 📋 `hooks/useCart.ts` — Zustand store for cart-build (local state where Convex reactivity isn't enough)
- 📋 `hooks/useXenditPayment.ts` — payment lifecycle hook
- 📋 `hooks/useOfflineQueue.ts` — IDB-backed drafts queue
- 📋 `hooks/useIdempotency.ts` — UPDATE: IDB persistence so reload-mid-payment doesn't double-execute

### Cross-cutting
- 📋 Three-path payment confirmation: webhook primary, polling fallback, manual override (strategic-§8)
- 📋 Negative-stock allowed at sale, flagged via `pos_transactions.flags |= NEG_STOCK` (ADR-018)
- 📋 Schema additions: `pos_transactions`, `pos_transaction_lines`, `pos_drafts`, `pos_xendit_invoices`
- 📋 Xendit test mode setup (test keys in `.env.local`, webhook URL configured in Xendit dashboard)
- 📋 SCHEMA.md audit enum: `transaction.created`, `transaction.line_*`, `transaction.discount_applied`, `transaction.voucher_redeemed`, `transaction.saved_as_draft`, `transaction.draft_resumed`, `payment.invoice_created`, `payment.confirmed`

---

## v0.4 — WA approval + manager mobile + founders share 🗂️ BACKLOG
Plan not yet written. Scope per WORKFLOW.md: polling + manual override + audit log + WA approval pattern + manager home (mobile) + founders share.

### Backend (`convex/`)
- 🗂️ `approvals.ts` — `create_internal`, `approve`, `deny`; manager-PIN gates routed via WA share-intent
- 🗂️ Approval tokens: 32-byte URL-safe random, single-use, 60-min TTL (ADR-029 — token authorizes VIEW, PIN authorizes ACT)
- 🗂️ Manual payment override path (manager PIN OR WA approval, audit-logged with reason)
- 🗂️ `dashboard.ts` (partial — mobile manager view only)
- 🗂️ `audit.ts` updates — `mgr_approver_id` populated when source is `wa_approval`
- 🗂️ Convex scheduler for token reaping

### Frontend (`src/`)
- 🗂️ `routes/wait/[requestId].tsx` — StaffWaitingApproval screen (the requester's view)
- 🗂️ `routes/approve/[token].tsx` — PUBLIC landing, opens from WA link (no auth gate)
- 🗂️ `routes/approve/[token]/pin.tsx` — PIN sheet continuation
- 🗂️ `routes/mgr/home.tsx` — MgrHomeMobile wireframe (live tape + approvals queue)
- 🗂️ `routes/lock.tsx` — partial: founders shift-summary share toggle (ADR-033)
- 🗂️ `lib/wa-link.ts` — wa.me share-intent template builder
- 🗂️ `hooks/useApproval.ts`

### Cross-cutting
- 🗂️ ADR-005 (manager-PIN gates) wired to WA flow (ADR-027) as the v0.4+ default when no manager at booth
- 🗂️ ADR-033 (founders shift-summary share to Frollie · Founders group via wa.me)
- 🗂️ Schema additions: `pos_approval_requests`, `pos_approval_tokens`
- 🗂️ SCHEMA.md audit enum: `approval.requested`, `approval.viewed`, `approval.approved`, `approval.denied`, `payment.manual_override`

---

## v0.5 — refunds + receipts + history + dashboard + stock 🗂️ BACKLOG
Plan not yet written. Largest phase. Scope per WORKFLOW.md.

### Backend (`convex/`)
- 🗂️ `refunds.ts` — refund as new row (ADR-008), never mutate paid txn status
- 🗂️ `stock.ts` — `pos_stock_movements` table, stock-in mutations, reconciliation, nightly job
- 🗂️ `settings.ts` — `pos_settings` singleton CRUD
- 🗂️ `staff.ts` updates — `resetPin`, `deactivateStaff`, `updateStaff` + strip pin_hash from `listStaff` response (v0.2 follow-up)
- 🗂️ `dashboard.ts` — full manager dashboard queries
- 🗂️ `receipt.ts` — receipt token generation, public lookup
- 🗂️ `settlements.ts` — full reconciliation (Xendit settlement webhook + nightly recon)

### Frontend (`src/`)
- 🗂️ `routes/refund/[txnId].tsx` — refund flow (mgr-PIN gated via WA from v0.4)
- 🗂️ `routes/receipt/[receiptNumber].tsx` — public receipt page `/r/:n` (signed URL)
- 🗂️ `routes/history.tsx` — staff sees own + today
- 🗂️ `routes/settlements.tsx` — payout reconciliation
- 🗂️ `routes/stock.tsx` — stock check (inventory)
- 🗂️ `routes/stock/in.tsx` — stock-in entry (with NumericKeypad qty input)
- 🗂️ `routes/lock.tsx` — full lock + handoff (end-of-shift)
- 🗂️ `routes/mgr/dashboard.tsx` — DashA wireframe (laptop-first)
- 🗂️ `routes/mgr/products.tsx` — ProductsManager (taxonomy editor)
- 🗂️ `routes/mgr/receipt.tsx` — ReceiptConfig
- 🗂️ `lib/receipt-template.ts` — receipt HTML rendering

### Cross-cutting
- 🗂️ ADR-008 (refunds as new rows, status computed on read)
- 🗂️ ADR-018 reconciliation tools (negative-stock manager workflow)
- 🗂️ `rp()` negative-amount handling (v0.2 follow-up)
- 🗂️ Schema additions: `pos_refunds`, `pos_stock_movements`, `pos_receipt_counters`, `pos_settings`
- 🗂️ SCHEMA.md audit enum: `refund.*`, `stock.*`, `settings.*`, `settlement.*`

---

## v0.6 — vouchers + reconciliation + spoilage + e2e 🗂️ BACKLOG
Plan not yet written.

### Backend (`convex/`)
- 🗂️ `vouchers.ts` / `discounts.ts` — CRUD + redemption (ADR-009 cache offline, ADR-010 no stacking)
- 🗂️ Spoilage tracking (manager-gated)
- 🗂️ Nightly reconciliation jobs (stock_levels denorm cache rebuild)

### Frontend (`src/`)
- 🗂️ Voucher management UI in `routes/mgr/`
- 🗂️ Spoilage entry UI
- 🗂️ Playwright e2e suite covering: offline catalog hydration, device activation, full sale flow, refund via WA approval

### Cross-cutting
- 🗂️ ADR-009 (voucher cache offline + server re-validates on sync)
- 🗂️ ADR-010 (no voucher stacking)
- 🗂️ E2E infra: Playwright config, fixtures, device emulation

---

## v1.0 — launch polish 🗂️ BACKLOG
Plan not yet written.

### Backend (`convex/`)
- 🗂️ Negative-stock reconciliation manager tools
- 🗂️ Settlement reconciliation polish (variance detection, alerts)

### Frontend (`src/`)
- 🗂️ PWA install prompt polish (Android Chrome A2HS UX)
- 🗂️ Final empty/error states across all screens

### Cross-cutting
- 🗂️ Full e2e pass on real Android device
- 🗂️ Production deployment to `savory-zebra-800`
- 🗂️ Operational runbook (oncall, dashboards, alert thresholds)

---

## How agents update this file

When starting a task that delivers an item on this board:
1. Move it from 📋 → 🔄 (in progress).
2. When the task lands (commit), move it to ✅ (done) with the commit SHA in parentheses.
3. If you discover a new item needed for the current phase, add it under that phase's lane with 📋. If it's clearly for a later phase, add it there with 🗂️.
4. Don't reword existing items unless they were wrong — keep the diff minimal and traceable.

When a phase ships:
1. Confirm every item under it is ✅.
2. Add a `Merged YYYY-MM-DD via PR #N` line under the phase header.
3. Move the next phase from 🗂️ to 📋.
