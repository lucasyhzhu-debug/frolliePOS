# Progress

**Mission.** Build the nervous system of the Frollie booth — sign-in, sale, payment, refund, stock — on a single Android device, in production, replacing the manual paper system before v1.0 ships.

Living kanban for Frollie POS. Update as work lands. AI agents read this before starting a task and update it after.

**Legend:** ✅ done · 🔄 in progress · 📋 planned (next up) · 🗂️ backlog (not yet planned)

**Source of truth:** phase definitions come from [`WORKFLOW.md` § Releases](./WORKFLOW.md#releases). Behaviour rules come from [`ADR/`](./ADR/). Screen layouts come from `frollie-pos design files/project/wireframes/*.jsx` (gitignored — local only).

**How to read a row:** each phase is broken into three lanes — **Backend** (`convex/`), **Frontend** (`src/`), **Cross-cutting** (ADRs, schema, infra). A phase ships when every item in every lane is ✅.

---

## Task ID format (for agent-addressable tasks)

From v0.3 onward, every task is addressable by a stable **Task ID** so agents can claim, update, and reference it atomically. v0.2 tasks (shipped) are unaddressed — historical record only.

**ID shape:** `<phase>-<lane>-<slug>`
- `phase` — `v02`, `v03`, `v04`, `v05`, `v06`, `v10` (dots stripped from `v0.X`)
- `lane` — `be` (backend, `convex/`), `fe` (frontend, `src/`), `xc` (cross-cutting)
- `slug` — short kebab-case noun, unique within the phase+lane

**Per-task metadata block** (indented bullets under the task line):

```markdown
- 📋 **[vXX-be-example]** `someFile.ts` — short description
  - **agent:** `convex-expert`
  - **deps:** `vXX-be-other`, `vXX-xc-schema`        (use other Task IDs, or `none`)
  - **docs:** [ADR-NNN](./ADR/...), [CLAUDE.md §section](../CLAUDE.md), [SCHEMA.md](./SCHEMA.md)
  - **subtasks:**
    - [ ] First concrete step
    - [ ] Second concrete step
    - [ ] Tests: the cases that prove it works
  - **notes:** _(empty)_
```

(The `vXX-be-example` placeholder is not a real Task ID — it's chosen to never collide with the regex parsers used by `/progress` and `/progress-update`.)

**Agent values** (from the available roster):
`convex-expert` · `frontend-integrator` · `ui-component-builder` · `code-reviewer` · `feature-dev:code-architect` · `general-purpose` · `—` (no specific agent — usually cross-cutting ADR/schema work)

**Slash-commands operating on this file:**
- `/progress` — read-only query: filter by phase, lane, agent, status, ID, or `--ready` (deps satisfied). Default shows in-progress + planned for the active phase.
- `/progress-update <task-id>` — atomic write: status, subtask checkbox, commit SHA, owner, note. Required when transitioning planned → in-progress → done.

When status changes to `🔄 in-progress`, the agent claiming it adds an `**owner:**` line. When status changes to `✅ done`, the title line gets `(commit-sha)` appended and the owner line is stripped.

---

## v0.2 — auth + catalog ✅ SHIPPED
**Outcome:** Staff sign in with a PIN on a registered device and see the menu.
Merged 2026-05-26 via PR #1 (commit `c051211`). 110 tests passing.

**You'll be able to:**
- Open the POS on a registered Android, tap your name, enter your 4-digit PIN, and land on the home screen
- Browse the menu (Dubai chocolate cookies, all pack sizes) — works offline, catalog is cached
- Get protected by a 3-strike, 60-second PIN lockout per staff member
- Activate a new device only via a one-time 6-digit code issued by a manager

**Still not yet:**
- Take a sale or accept payment
- See transaction history, issue refunds, or manage stock
- Anything beyond sign-in + browsing the menu

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
- ✅ Telegram POC playground at `/dev/telegram` — proves round-trip Convex ↔ Telegram (bot `@FrolliePOS_Bot`, dev chat `-5247663806`). Three templates (approval / shift summary / custom), HTML-escape helper, webhook with secret verification + idempotency, convex-test coverage. Spec `docs/superpowers/specs/2026-05-25-telegram-poc-design.md`, plan `docs/superpowers/plans/2026-05-25-telegram-poc.md`, runbook `docs/RUNBOOK-telegram.md`, portable pattern `docs/PATTERNS/telegram-bot-integration.md`. ADR-027 + ADR-033 graduation deferred to v0.4.

### v0.2 follow-ups deferred to later phases
- 🗂️ `useIdempotency` IDB persistence → v0.3 (when payments expose the cost of reload-mid-payment)
- 🗂️ `withIdempotency` error-caching design re-evaluation → v0.3
- 🗂️ `listStaff` pin_hash strip → v0.5 (when manager portal lands)
- 🗂️ `rp()` negative-amount handling → v0.5 (refunds)
- 🗂️ Playwright E2E for offline catalog + device activation → v0.6
- 🗂️ Telegram POC graduation → v0.4: replace ADR-027 (WA manager approval) + ADR-033 (founders shift summary) with the validated Telegram bot pattern. Also: error toasting (Sonner) in playground forms, replace `payload: v.any()` with per-kind discriminated union, integrate `pos_approval_requests` instead of sandbox `telegram_log` table.

---

## v0.2.1 — Architecture restructure ✅ SHIPPED
**Outcome:** `convex/` refactored into module layout per [ADR-034](./ADR/034-deep-modules-surface-apis.md). Module-boundary lint as hard CI gate. Stable string identifiers (staffCode, productCode, componentCode) added as optional fields + seed allocation + format conformance tests. External API surface scaffolded under `convex/api/v1/` (endpoints deferred to v0.3).
Merged 2026-05-26.

**You'll be able to:**
- _(nothing user-visible — purely engineering scaffolding to keep future phases shipping fast)_

**Still not yet:**
- Same as v0.2 — this phase changed nothing for end users

### Backend (`convex/`)
- ✅ Module-boundary ESLint rule + CI gate (`tools/eslint-rules/no-cross-module-db-access.js`, `eslint.config.js`)
- ✅ Schema composed from per-module fragments (`auth/`, `catalog/`, `idempotency/`, `audit/`, `telegram/`)
- ✅ All modules migrated: `auth/{public,internal,actions,sessions,schema}.ts`, `staff/{public,internal}.ts`, `catalog/{public,schema}.ts`, `audit/{public,internal,schema}.ts`, `idempotency/{internal,schema}.ts`, `seed/{internal,actions}.ts`
- ✅ Session helpers extracted to `auth/sessions.ts` (breaks audit→staff backwards dep)
- ✅ `logAudit` confirmed as plain helper (ADR-034 amended)
- ✅ Stable codes (`staffCode` `S-NNNN`, `productCode` `<PREFIX>_<N>PC`, `componentCode` UPPERCASE) added as optional fields + seed allocates them + format conformance tests in `convex/_codes/__tests__/`

### Frontend (`src/`)
- ✅ All `api.<module>.<fn>` → `api.<module>.public.<fn>` (or `.actions.<fn>` for Node actions) — 5 files: `useSession`, `RootLayout`, `DeviceActivation`, `login`, `home` (+ `useCatalogCache` doc comment)

### Cross-cutting
- ✅ `convex/api/v1/{_auth.ts,README.md}` scaffold (no endpoints yet)
- ✅ `docs/PUBLIC_API.md` stubbed
- ✅ `docs/SCHEMA.md` reframed as POS-internal
- ✅ `CLAUDE.md` file-locations updated for module layout
- ✅ ADR-034 amended (§"Cross-module patterns — Audit logging")
- ✅ CHANGELOG entry

### v0.2.1 follow-ups deferred
- 🗂️ Flip `code` fields to required → v0.3 (needs `createStaff` allocation logic for race-safe S-NNNN; cascades through `_seedStaffCommit_internal`, `_createStaffCommit_internal`, and raw test inserts)
- 🗂️ External API endpoints + bearer-token impl + PUBLIC_API.md endpoint specs + contract snapshot tests + `audit_log.source` `"api_consumer"` enum + PII scope tests → v0.3
- 🗂️ Telegram POC graduation → v0.4

---

## v0.3 — sale flow + Xendit 📋 PLANNED (next up)
**Outcome:** Staff take a sale and accept QRIS or BCA VA payment, with retries that don't double-charge.
**Target:** 29 May 2026
Plan to be written. Scope per WORKFLOW.md: sale flow + QRIS + BCA VA + webhook + idempotency harness updates.

**You'll be able to:**
- Build a cart with items + quantities, see live totals
- Charge customers via QRIS scan **or** BCA Virtual Account (Xendit)
- Auto-confirm via webhook **or** polling fallback — staff never wait wondering if it worked
- Save sales as drafts (offline too) and resume them later
- Sell even at zero stock — the sale never blocks; it's flagged for later manager review
- Bootstrap a fresh prod database with just Lucas (PIN 1111), then rotate that PIN immediately via in-app change-PIN

**Still not yet:**
- Issue refunds (lands in v0.5)
- Approve manager actions remotely — overrides still need a manager physically at the booth (v0.4)
- Add/edit staff or products in-app — both still managed via the Convex dashboard until the manager portal (v0.5)
- See receipts, transaction history, the dashboard, or stock management (v0.5)

### Backend (`convex/`)
- 📋 **[v03-be-bootstrap]** Bootstrap action: insert single manager "Lucas" with PIN 1111 on a fresh deployment
  - **agent:** `convex-expert`
  - **deps:** `none`
  - **docs:** [ADR-001](./ADR/001-pin-only-authentication.md), [ADR-004](./ADR/004-pin-hashing-server-side.md), [ADR-034 §stable identifiers](./ADR/034-deep-modules-surface-apis.md)
  - **why:** v0.2.1 ships dev seed (`seed/actions:reset`) that wipes + populates Lucas + 4 staff + 5 SKUs + 7 products as bootstrap test data. Code-wise the bootstrap action is needed early (v0.3) so the "fresh-deployment" code path is testable + exercised in dev. **Prod cutover is deferred to v1.0** — until then, all environments run on dev/staging deployments with the existing seed data; bootstrap is exercised against a wipe-and-bootstrap dev cycle, not against prod.
  - **subtasks:**
    - [ ] New `convex/seed/actions.ts` action: `bootstrap` — argon2id-hashes PIN 1111 + commits via internal mutation
    - [ ] Internal mutation: refuse if `staff` table has any row (idempotent — safe to re-run; errors clearly if already bootstrapped)
    - [ ] Insert single row: `{ name: "Lucas", code: "S-0001", role: "manager", active: true, pin_hash: argon2id("1111"), created_at: Date.now() }`
    - [ ] Audit log: `actor_id: "system"`, `action: "staff.bootstrapped"`, `source: "system"`, `entity_type: "staff"`, `entity_id: <new id>`
    - [ ] Document the bootstrap-then-change-pin sequence in `docs/RUNBOOK.md` (purely dev/staging instructions in v0.3 — prod section added at v1.0 cutover)
    - [ ] Tests: bootstrap on empty DB succeeds + creates exactly 1 row, bootstrap with any existing row throws, audit row written
  - **notes:** _Prod cutover postponed to v1.0 per [decision 2026-05-27]. Bootstrap ships in v0.3 as the code path that the eventual v1.0 cutover will use — keeping it implemented + tested early prevents a rushed bootstrap landing right before launch._

- 📋 **[v03-be-change-pin]** `auth/actions:changePin` — staff can change their own PIN
  - **agent:** `convex-expert`
  - **deps:** `none`
  - **docs:** [ADR-001](./ADR/001-pin-only-authentication.md), [ADR-002](./ADR/002-lockout-policy.md), [ADR-004](./ADR/004-pin-hashing-server-side.md), [ADR-005](./ADR/005-manager-pin-one-off.md), [ADR-013](./ADR/013-idempotency-keys.md)
  - **why:** General staff capability — any staff member rotates their own PIN. Also the cleanup path for the bootstrap PIN 1111 once a fresh deployment is bootstrapped via [v03-be-bootstrap].
  - **subtasks:**
    - [ ] `action: changePin(sessionId, currentPin, newPin, idempotencyKey)` in `convex/auth/actions.ts` — argon2id verify currentPin against `staff.pin_hash`, then argon2id-hash newPin, commit via internal mutation
    - [ ] Internal mutation: `_changePinCommit_internal` — atomic patch of `staff.pin_hash`, requires session resolves to same `staff_id` as PIN owner (no admin override; managers can't change others' PINs via this action — see [v03-be-reset-staff-pin] for the manager-reset flow)
    - [ ] PIN validation: 4 digits, numeric only, reject if equal to currentPin (force actual change)
    - [ ] Lockout interaction: failed currentPin verify counts toward the lockout in `pos_auth_attempts` — same counter as login per ADR-002. 3 failed change-PIN attempts triggers the same 60s lockout. **Decided 2026-05-27.**
    - [ ] Audit log: `actor_id: <staffId>`, `action: "staff.pin_changed"`, `source: "booth_inline"`, `entity_type: "staff"`, `entity_id: <staffId>`, no before/after pin (never log PINs)
    - [ ] Idempotency: wrap with `withIdempotency` — replay returns success without re-hashing (PIN already changed)
    - [ ] Tests: happy path, wrong currentPin throws + lockout counter increments, newPin == currentPin throws, replay via idempotencyKey returns same response, audit row written without PIN values, 3 failed verifies trigger lockout
  - **notes:** _Frontend UI deferred to v0.5 manager portal — interim staff-self-change-PIN UI not in v0.3 scope. Combined with prod-cutover deferral to v1.0, this is acceptable: bootstrap + changePin are exercised end-to-end via `npx convex run` against dev/staging in v0.3, real UI lands when manager portal does._

- 📋 **[v03-be-reset-staff-pin]** `auth/actions:resetStaffPin` — manager resets another staff member's PIN (manager-PIN-gated per ADR-005)
  - **agent:** `convex-expert`
  - **deps:** `v03-be-change-pin` _(shared `_changePinCommit_internal` patching path)_
  - **docs:** [ADR-005](./ADR/005-manager-pin-one-off.md), [ADR-001](./ADR/001-pin-only-authentication.md), [ADR-004](./ADR/004-pin-hashing-server-side.md), [ADR-013](./ADR/013-idempotency-keys.md), [ADR-027](./ADR/027-wa-approval-via-staff-own-wa.md) _(WA approval path superseded by Telegram in v0.4)_
  - **why:** Staff member forgets their PIN or is locked out → manager resets. Per ADR-005, "PIN resets" is on the manager-PIN-gated list. Without this, a locked-out or forgetful staff member is permanently locked out short of dashboard intervention. Manager-PIN gate is one-off (not a persistent mode).
  - **subtasks:**
    - [ ] `action: resetStaffPin(sessionId, targetStaffCode, newPin, managerPin, idempotencyKey)` in `convex/auth/actions.ts` — caller must have manager role on `sessionId`, re-verifies `managerPin` via argon2id (one-off gate per ADR-005), then argon2id-hashes `newPin` and commits via shared internal mutation
    - [ ] Use `staffCode` (S-NNNN) as target identifier — not `staff_id` — per ADR-034 stable IDs
    - [ ] Internal mutation: reuse `_changePinCommit_internal` from [v03-be-change-pin] with an arg shape that supports target-id + manager-approver-id (refactor needed when both tasks land)
    - [ ] Auth: `requireManagerSession` for caller, then explicit `managerPin` re-verify (defense-in-depth; manager-mode-not-persistent)
    - [ ] Reject if `targetStaffCode` is the manager themselves (use changePin instead)
    - [ ] Clear `pos_auth_attempts` row for the target staff on successful reset (unblocks them from any active lockout)
    - [ ] Audit log: `actor_id: <managerStaffId>`, `mgr_approver_id: <managerStaffId>` (same — booth_inline), `action: "staff.pin_reset"`, `source: "booth_inline"`, `entity_type: "staff"`, `entity_id: <targetStaffId>`, no PIN values logged
    - [ ] Idempotency: wrap with `withIdempotency` — replay returns success
    - [ ] Tests: happy path manager-resets-staff, non-manager session rejected, wrong managerPin rejected + counts toward lockout, target=self rejected, lockout row cleared for target, audit row has correct `mgr_approver_id`, replay deduped
    - [ ] Document v0.4 augmentation: when Telegram approval lands, this action gains an off-booth path via approval-request flow (manager not at booth approves via Telegram callback). v0.3 only supports the in-person manager-PIN path.
  - **notes:** _The shared `_changePinCommit_internal` mutation needs an arg shape that handles both self-change (no `mgr_approver_id`) and manager-reset (with `mgr_approver_id`). Whichever of [v03-be-change-pin] or [v03-be-reset-staff-pin] lands first defines the initial signature; second one refactors as needed. v0.4 graduation: per the recent Telegram pivot ([decision 2026-05-26]), this is the canonical action that the Telegram approval flow will gate at v0.4 — keep the action shape stable._

- 📋 **[v03-xc-schema]** Schema additions: `pos_transactions`, `pos_transaction_lines`, `pos_drafts`, `pos_xendit_invoices`
  - **agent:** `convex-expert`
  - **deps:** `none`
  - **docs:** [SCHEMA.md](./SCHEMA.md), [ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md), [ADR-018](./ADR/018-negative-stock-allowed-flagged.md), [CLAUDE.md §business-rules-1](../CLAUDE.md)
  - **subtasks:**
    - [ ] `pos_transactions` table (with `flags` bitfield for NEG_STOCK)
    - [ ] `pos_transaction_lines` table with `unit_price` + `product_name_snapshot`
    - [ ] `pos_drafts` table
    - [ ] `pos_xendit_invoices` table (audit log for invoice ids)
    - [ ] Update [SCHEMA.md](./SCHEMA.md) with the new tables before code
  - **notes:** _(empty)_

- 📋 **[v03-be-transactions]** `transactions.ts` — cart, draft, void; snapshot prices + names on lines
  - **agent:** `convex-expert`
  - **deps:** `v03-xc-schema`
  - **docs:** [CLAUDE.md §business-rules-1](../CLAUDE.md), [ADR-013](./ADR/013-idempotency-keys.md), [ADR-031](./ADR/031-convex-server-time-wins.md)
  - **subtasks:**
    - [ ] Mutation: `createDraft(args, idempotencyKey)`
    - [ ] Mutation: `addLine(txnId, productId, qty)` — snapshot `unit_price` + `product_name`
    - [ ] Mutation: `removeLine(txnId, lineId)`
    - [ ] Mutation: `voidTransaction(txnId, reason)` + audit log
    - [ ] Mutation: `saveAsDraft(txnId)` / `resumeDraft(draftId)`
    - [ ] Tests: snapshot pricing immutability, idempotency dedup, void path, draft round-trip
  - **notes:** _(empty)_

- 📋 **[v03-be-xendit-invoice]** `xendit/invoice.ts` — invoice creation with `payment_methods: ["QRIS", "BCA"]`
  - **agent:** `convex-expert`
  - **deps:** `v03-xc-schema`
  - **docs:** [ADR-011](./ADR/011-qris-via-xendit-bca-va-secondary.md), [ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md)
  - **subtasks:**
    - [ ] `createInvoice(txnId)` — POST to Xendit Invoice API
    - [ ] `cancelInvoice(invoiceId)` — called before retry on cart-edit
    - [ ] Persist `xendit_invoice_id` + prior-invoice audit row
    - [ ] Tests: invoice creation, cancel-before-retry, single-active enforcement
  - **notes:** _(empty)_

- 📋 **[v03-be-payments]** `payments.ts` — Xendit Invoice API lifecycle, single active invoice per txn
  - **agent:** `convex-expert`
  - **deps:** `v03-be-transactions`, `v03-be-xendit-invoice`
  - **docs:** [ADR-014](./ADR/014-single-xendit-invoice-per-transaction.md), [CLAUDE.md §business-rules-5](../CLAUDE.md)
  - **subtasks:**
    - [ ] `requestPayment(txnId)` — orchestrates createInvoice + state transition
    - [ ] `confirmPayment(txnId, source)` — idempotent, source ∈ {webhook, polling, manual}
    - [ ] State machine: draft → awaiting_payment → paid | cancelled
    - [ ] Tests: three confirmation paths, idempotent re-fire, state-transition guard
  - **notes:** _(empty)_

- 📋 **[v03-be-xendit-webhook]** `xendit/webhook.ts` — Convex `httpAction`, signature verification mandatory
  - **agent:** `convex-expert`
  - **deps:** `v03-be-payments`
  - **docs:** [CLAUDE.md §Xendit-integration-notes](../CLAUDE.md#xendit-integration-notes), [ADR-013](./ADR/013-idempotency-keys.md)
  - **subtasks:**
    - [ ] Convex `httpAction` exposing webhook endpoint
    - [ ] HMAC signature verification via `XENDIT_CALLBACK_TOKEN` (reject on mismatch)
    - [ ] Dedupe by `xendit_invoice_id` (Xendit retries)
    - [ ] Call `confirmPayment(txnId, "webhook")`
    - [ ] Tests: valid sig accepted, invalid sig rejected, retry-dedup
  - **notes:** _(empty)_

- 📋 **[v03-be-xendit-polling]** `xendit/polling.ts` — fallback after 2s, every 2s, 60s ceiling
  - **agent:** `convex-expert`
  - **deps:** `v03-be-payments`
  - **docs:** [CLAUDE.md §strategic-foundations-§8](../CLAUDE.md), [ADR-000 §8](./ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)
  - **subtasks:**
    - [ ] `pollInvoice(invoiceId)` — GET `/v2/invoices/{id}`
    - [ ] Scheduler: kick off after 2s wait, repeat every 2s until 60s
    - [ ] On paid: call `confirmPayment(txnId, "polling")` — idempotent against webhook winning
    - [ ] Tests: polling stops once confirmed, ceiling honored, idempotency vs webhook
  - **notes:** _(empty)_

### Frontend (`src/`)
- 📋 **[v03-fe-use-cart]** `hooks/useCart.ts` — Zustand store for cart-build (local state where Convex reactivity isn't enough)
  - **agent:** `frontend-integrator`
  - **deps:** `none`
  - **docs:** [CLAUDE.md §stack](../CLAUDE.md#stack)
  - **subtasks:**
    - [ ] Zustand store: lines, totals, voucher slot
    - [ ] Actions: `addItem`, `removeItem`, `setQty`, `clear`, `applyVoucher`
    - [ ] Persist to sessionStorage so accidental reload mid-build doesn't nuke it
    - [ ] Tests: state transitions, voucher reset on clear
  - **notes:** _(empty)_

- 📋 **[v03-fe-use-xendit-payment]** `hooks/useXenditPayment.ts` — payment lifecycle hook
  - **agent:** `frontend-integrator`
  - **deps:** `v03-be-payments`
  - **docs:** [CLAUDE.md §business-rules-5](../CLAUDE.md)
  - **subtasks:**
    - [ ] Subscribe to txn state (Convex query)
    - [ ] Surface QR string + BCA VA details
    - [ ] Expose `retry()` (with cancel-prior-invoice on backend)
    - [ ] Polling-fallback awareness (UI shows "checking…")
  - **notes:** _(empty)_

- 📋 **[v03-fe-use-offline-queue]** `hooks/useOfflineQueue.ts` — IDB-backed drafts queue
  - **agent:** `frontend-integrator`
  - **deps:** `v03-be-transactions`
  - **docs:** [ADR-025](./ADR/025-service-worker-cache.md), [CLAUDE.md §business-rules-17](../CLAUDE.md)
  - **subtasks:**
    - [ ] IDB schema for queued drafts
    - [ ] Enqueue on offline, flush on reconnect
    - [ ] Tests: round-trip with fake-indexeddb
  - **notes:** _(empty)_

- 📋 **[v03-fe-use-idempotency-idb]** `hooks/useIdempotency.ts` — UPDATE: IDB persistence (v0.2 follow-up)
  - **agent:** `frontend-integrator`
  - **deps:** `none`
  - **docs:** [ADR-013](./ADR/013-idempotency-keys.md), [CLAUDE.md §business-rules-15](../CLAUDE.md)
  - **subtasks:**
    - [ ] Persist intent UUIDs to IDB so reload-mid-payment doesn't re-issue
    - [ ] TTL-based cleanup (24h, matching server dedupe window)
    - [ ] Tests: reload simulation, expiry
  - **notes:** _(empty)_

- 📋 **[v03-fe-sale-route]** `routes/sale.tsx` — CartA wireframe (`sale.jsx` artboard)
  - **agent:** `ui-component-builder`
  - **deps:** `v03-fe-use-cart`
  - **docs:** `frollie-pos design files/project/wireframes/sale.jsx` (local-only), [CLAUDE.md §wireframe-bundle](../CLAUDE.md#wireframe-bundle-reference)
  - **subtasks:**
    - [ ] Page shell + RootLayout wiring
    - [ ] Product grid bound to `catalog` query
    - [ ] Cart panel bound to `useCart`
    - [ ] Charge button + Save-as-draft button
  - **notes:** _(empty)_

- 📋 **[v03-fe-sale-drafts]** `routes/sale/drafts.tsx` — saved drafts list
  - **agent:** `ui-component-builder`
  - **deps:** `v03-be-transactions`, `v03-fe-use-offline-queue`
  - **docs:** `frollie-pos design files/project/wireframes/sale-drafts.jsx`
  - **subtasks:**
    - [ ] List queued + server drafts
    - [ ] Resume + delete actions
  - **notes:** _(empty)_

- 📋 **[v03-fe-sale-voucher]** `routes/sale/voucher.tsx` — voucher apply (cached, ADR-009)
  - **agent:** `ui-component-builder`
  - **deps:** `v03-fe-use-cart`
  - **docs:** [ADR-009](./ADR/009-voucher-cache-offline.md), [ADR-010](./ADR/010-no-voucher-stacking.md)
  - **subtasks:**
    - [ ] Voucher input + validation against cached list
    - [ ] One-voucher-at-a-time enforcement (ADR-010)
  - **notes:** _(empty)_

- 📋 **[v03-fe-sale-charge]** `routes/sale/charge.tsx` — ChargeA wireframe (QR + BCA VA toggle)
  - **agent:** `ui-component-builder`
  - **deps:** `v03-fe-use-xendit-payment`
  - **docs:** `frollie-pos design files/project/wireframes/charge.jsx`, [ADR-011](./ADR/011-qris-via-xendit-bca-va-secondary.md)
  - **subtasks:**
    - [ ] QRIS view with QR canvas render
    - [ ] BCA VA view with copy-to-clipboard + bank logo
    - [ ] Method toggle + retry affordance
    - [ ] Polling indicator
  - **notes:** _(empty)_

- 📋 **[v03-fe-sale-charge-success]** `routes/sale/charge-success.tsx` — paid confirmation
  - **agent:** `ui-component-builder`
  - **deps:** `v03-fe-sale-charge`
  - **docs:** `frollie-pos design files/project/wireframes/charge-success.jsx`
  - **subtasks:**
    - [ ] Success screen with receipt number + totals
    - [ ] "New sale" CTA returning to `/sale`
  - **notes:** _(empty)_

### Cross-cutting
- 📋 **[v03-xc-three-path-payment]** Three-path payment confirmation (webhook + polling + manual override)
  - **agent:** `—`
  - **deps:** `v03-be-xendit-webhook`, `v03-be-xendit-polling`
  - **docs:** [strategic-foundations §8](./ADR/000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern), [CLAUDE.md §business-rules-5](../CLAUDE.md)
  - **subtasks:**
    - [ ] Document the manual-override flow (deferred to v0.4 Telegram approval; v0.3 stubs it behind a feature flag)
    - [ ] Sequence diagram in ADR or PROGRESS notes
  - **notes:** _(empty)_

- 📋 **[v03-xc-neg-stock-flag]** Negative-stock allowed at sale, flagged via `pos_transactions.flags |= NEG_STOCK`
  - **agent:** `convex-expert`
  - **deps:** `v03-be-transactions`
  - **docs:** [ADR-018](./ADR/018-negative-stock-allowed-flagged.md)
  - **subtasks:**
    - [ ] Bitfield constant in shared module
    - [ ] Set on cart-confirm when any line crosses zero
    - [ ] Tests: flag set, flag not set, partial cart
  - **notes:** _(empty)_

- 📋 **[v03-xc-xendit-test-mode]** Xendit test mode setup (test keys in `.env.local`, webhook URL in Xendit dashboard)
  - **agent:** `—`
  - **deps:** `none`
  - **docs:** [CLAUDE.md §Xendit-integration-notes](../CLAUDE.md#xendit-integration-notes)
  - **subtasks:**
    - [ ] Add test keys to `.env.local` (gitignored)
    - [ ] Configure webhook URL pointing at `helpful-grasshopper-46.convex.site/xendit/webhook`
    - [ ] Verify with curl + signed payload
  - **notes:** _(empty)_

- 📋 **[v03-xc-schema-audit-enum]** Audit enum additions in [SCHEMA.md](./SCHEMA.md)
  - **agent:** `—`
  - **deps:** `v03-xc-schema`
  - **docs:** [SCHEMA.md](./SCHEMA.md), [ADR-007](./ADR/007-audit-log-append-only.md)
  - **subtasks:**
    - [ ] `transaction.created`, `transaction.line_added`, `transaction.line_removed`
    - [ ] `transaction.discount_applied`, `transaction.voucher_redeemed`
    - [ ] `transaction.saved_as_draft`, `transaction.draft_resumed`
    - [ ] `payment.invoice_created`, `payment.confirmed`
  - **notes:** _(empty)_

---

## v0.4 — Telegram approval + manager mobile + founders share 🗂️ BACKLOG
**Outcome:** Managers approve refunds and overrides from anywhere via a Telegram bot; no booth presence required. Founders get an automatic end-of-shift summary in their Telegram group.
**Target:** TBD
Plan not yet written. Scope per WORKFLOW.md: polling + manual override + audit log + Telegram approval pattern + manager home (mobile) + founders share. **Built on the v0.2 Telegram POC** — bot `@FrolliePOS_Bot` already deployed, dev group already wired (`-5247663806`), end-to-end round-trip validated. Reuse the pattern in `docs/PATTERNS/telegram-bot-integration.md`. ADR-027 (wa.me manager approval) and ADR-033 (founders wa.me share) are superseded by this phase.

**You'll be able to:**
- Approve refunds + overrides from your phone via Telegram — no booth presence required
- Receive auto-posted end-of-shift summaries in the Frollie · Founders Telegram group
- Use a mobile manager home screen with live sales tape + approvals queue
- Trust that approval links are single-use, 60-minute expiry, PIN-gated

**Still not yet:**
- Issue refunds end-to-end (approval path lands here; refund logic ships v0.5)
- Manage staff/products in-app (v0.5)
- View receipts, history, dashboard, or stock (v0.5)

### Backend (`convex/`)
- 🗂️ `approvals.ts` — `create_internal`, `approve`, `deny`; manager-PIN gates send an inline-button card to **Frollie · Managers** Telegram group via `convex/telegram/send.ts` (new template kind: `manager_approval`)
- 🗂️ Approval tokens: 32-byte URL-safe random, single-use, 60-min TTL (ADR-029 still applies — token authorizes VIEW, PIN authorizes ACT). Link is the `url` field of a Telegram inline button.
- 🗂️ Manual payment override path (manager PIN OR Telegram approval, audit-logged with reason)
- 🗂️ `dashboard.ts` (partial — mobile manager view only)
- 🗂️ `audit.ts` updates — `mgr_approver_id` populated when source is `telegram_approval`
- 🗂️ Convex scheduler for token reaping
- 🗂️ Replace POC's sandbox `telegram_log` with real integration: link Telegram messages to `pos_approval_requests` rows via `request_id` foreign key; keep `telegram_log` only as a debug/audit trail (or retire it).
- 🗂️ Webhook hardening (graduated from POC): wrap `sendTemplate` in `withIdempotency` (ADR-013), validate payload shape per `kind` (drop `v.any()`), surface `editMessageText` failures as audit-log entries, not just `console.warn`.

### Frontend (`src/`)
- 🗂️ `routes/wait/[requestId].tsx` — StaffWaitingApproval screen (the requester's view; status driven by reactive query on `pos_approval_requests`)
- 🗂️ `routes/approve/[token].tsx` — PUBLIC landing, opens when a manager taps the Telegram inline button (no auth gate; URL is the button's `url` field)
- 🗂️ `routes/approve/[token]/pin.tsx` — PIN sheet continuation
- 🗂️ `routes/mgr/home.tsx` — MgrHomeMobile wireframe (live tape + approvals queue)
- 🗂️ `routes/lock.tsx` — partial: founders shift-summary auto-post to Telegram (replaces ADR-033 wa.me toggle; either auto-on-lock or behind a manager-configurable setting)
- 🗂️ ~~`lib/wa-link.ts`~~ — **REMOVED from plan**: superseded by `convex/telegram/send.ts` (manager_approval template). The POS UI now triggers approvals via a Convex mutation, not a wa.me share-intent.
- 🗂️ `hooks/useApproval.ts` — subscribes to `pos_approval_requests`, dispatches approval-request mutation, surfaces "waiting" / "approved" / "denied" states + error toasting (Sonner) on Telegram delivery failure
- 🗂️ Optional: tiny error-toast UX layer in `/dev/telegram` playground forms — same Sonner pattern, makes the page production-grade enough to leave in

### Cross-cutting
- 🗂️ **Write the new ADR superseding ADR-027 + ADR-033** — title TBD (e.g., `ADR-034-telegram-as-internal-comms-channel.md`). Should reference the POC + pattern doc and explicitly mark ADR-027 / ADR-033 with `Status: superseded by ADR-034`. Decision date: 2026-05-26.
- 🗂️ ADR-005 (manager-PIN gates) wired to Telegram bot flow as the v0.4+ default when no manager at booth (the link in the inline button leads to `/approve/:token`; PIN entered on landing).
- 🗂️ Founders shift-summary auto-post to `Frollie · Founders` Telegram group (reuses POC's `shift_summary` template kind).
- 🗂️ Production Telegram setup: separate prod bot via BotFather, prod group(s), prod env vars on `savory-zebra-800`, prod `setWebhook` call (see `docs/RUNBOOK-telegram.md` § "Promoting Telegram from dev to prod — checklist").
- 🗂️ Schema additions: `pos_approval_requests`, `pos_approval_tokens` (plus consider retiring or repurposing `telegram_log` once `pos_approval_requests` carries the inbound state).
- 🗂️ SCHEMA.md audit enum: `approval.requested`, `approval.viewed`, `approval.approved`, `approval.denied`, `payment.manual_override`, `telegram.send_failed`

---

## v0.5 — refunds + receipts + history + dashboard + stock 🗂️ BACKLOG
**Outcome:** Staff issue refunds, share receipts, and reconcile stock; managers see the daily dashboard.
**Target:** TBD
Plan not yet written. Largest phase. Scope per WORKFLOW.md.

**You'll be able to:**
- Issue refunds end-to-end — staff initiate, manager approves via Telegram, refund logged as a new row (the original sale is never mutated)
- Share signed-URL receipts — customer scans/clicks, gets an itemized receipt
- View transaction history (staff: own + today; manager: everything)
- Log stock-in by SKU through the app, every change tracked as a logged movement with a reason
- Reconcile Xendit settlements (what they owe vs what they've paid out)
- Use the manager dashboard (laptop-first) for daily sales, top SKUs, flagged transactions, staff activity
- Manage staff + products fully in-app — the Convex dashboard is no longer required for day-to-day ops
- End-of-shift handoff via the Lock screen

**Still not yet:**
- Use vouchers / promo codes (v0.6)
- Track spoilage / wasted stock (v0.6)
- Rely on nightly auto-reconciliation of stock counts (v0.6)
- Launch in production with full operational polish (v1.0)

### Backend (`convex/`)
- 🗂️ `refunds.ts` — refund as new row (ADR-008), never mutate paid txn status
- 🗂️ `stock.ts` — `pos_stock_movements` table, stock-in mutations, reconciliation, nightly job
- 🗂️ `settings.ts` — `pos_settings` singleton CRUD
- 🗂️ `staff.ts` updates — `resetPin`, `deactivateStaff`, `updateStaff` + strip pin_hash from `listStaff` response (v0.2 follow-up)
- 🗂️ `dashboard.ts` — full manager dashboard queries
- 🗂️ `receipt.ts` — receipt token generation, public lookup
- 🗂️ `settlements.ts` — full reconciliation (Xendit settlement webhook + nightly recon)

### Frontend (`src/`)
- 🗂️ `routes/refund/[txnId].tsx` — refund flow (mgr-PIN gated via Telegram from v0.4)
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
**Outcome:** Vouchers redeem, spoilage is tracked, end-to-end browser tests pass on a real Android device.
**Target:** TBD
Plan not yet written.

**You'll be able to:**
- Create promo codes from the manager portal; staff apply at sale (one per transaction, cached offline)
- Log spoilage with manager gating — real margin numbers stop drifting from reported margins
- Watch nightly auto-reconciliation keep stock counts honest without manual intervention
- Trust that E2E browser tests have proven the full sale → payment → refund loop on real Android Chrome

**Still not yet:**
- Run in production (v1.0)
- See polished PWA install + empty/error states (v1.0)
- Lean on an operational runbook for incidents (v1.0)

### Backend (`convex/`)
- 🗂️ `vouchers.ts` / `discounts.ts` — CRUD + redemption (ADR-009 cache offline, ADR-010 no stacking)
- 🗂️ Spoilage tracking (manager-gated)
- 🗂️ Nightly reconciliation jobs (stock_levels denorm cache rebuild)

### Frontend (`src/`)
- 🗂️ Voucher management UI in `routes/mgr/`
- 🗂️ Spoilage entry UI
- 🗂️ Playwright e2e suite covering: offline catalog hydration, device activation, full sale flow, refund via Telegram approval

### Cross-cutting
- 🗂️ ADR-009 (voucher cache offline + server re-validates on sync)
- 🗂️ ADR-010 (no voucher stacking)
- 🗂️ E2E infra: Playwright config, fixtures, device emulation

---

## v1.0 — launch polish 🗂️ BACKLOG
**Outcome:** The POS replaces the manual paper system at the booth, in production, with an operational runbook.
**Target:** TBD
Plan not yet written.

**You'll be able to:**
- Run the POS in production on `savory-zebra-800` Convex (separate from dev)
- Have staff cleanly install the PWA via Android Chrome "Add to Home Screen"
- See proper empty + error states across every screen — no blank screens, no cryptic failures
- Lean on an operational runbook (oncall rotation, dashboards, alert thresholds) when things break
- **Retire the paper system at the booth — Frollie POS is live**

**Still not yet (deliberately out of scope for v1):**
- Multi-stall expansion — schema is single-tenant in v1
- Cash handling — digital payments only, by design (ADR-006)
- Customer-facing screens — staff + manager only
- Recipe / kitchen inventory — finished goods only
- Receipt printer hardware — decision pending; could land here or v1.1
- Cross-deployment integration with Frollie Pro `product_master` — decision pending; v1.1+

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

## Risks under watch

- **Xendit settlement timing** — payout latency vs cashflow visibility. v0.5 settlements module is the canary; if it ships clean, settlement risk is closed.
- **Single device, single point of failure** — the booth Android dies mid-shift = no sales. Offline draft queue (v0.3) helps but doesn't replace; spare-device protocol needed by v1.0.
- **Telegram bot single point of failure** — all internal staff/manager/founders comms now route through one bot identity (`@FrolliePOS_Bot` for dev, separate prod bot for prod). Failure modes: BotFather token revoked, bot removed from a group, Telegram service outage, or a group silently migrates basic→supergroup (chat_id format changes). Mitigations: secret-token + idempotency at the webhook (already shipped); add telegram delivery-failure alerts (e.g. nightly query on `telegram_log` for OUT rows with non-`ok` responses); document the token-rotation runbook in [`docs/RUNBOOK-telegram.md`](./RUNBOOK-telegram.md) (already covered).
- **PWA install conversion** — staff must add the app to their home screen for offline + reliable launch. Drives the launch playbook in v1.0.
- **Negative-stock discipline** — sales are allowed at zero stock with a flag (ADR-018). Requires manager actually reconciling, or counts drift. Reconciliation UI is v0.5.

## Decisions awaiting CTO

- **Cross-deployment integration with Frollie Pro `product_master`** — sync, API call, or shared package? Affects v1.1+ when POS starts reading Pro's `products` table.
- **Receipt printer hardware** — in scope for v1.0 or punt to v1.1? Currently not on the roadmap; booth may want thermal receipts at launch.
- ~~**WhatsApp Cloud API vs share-intent**~~ — **RESOLVED 2026-05-26**: chose Telegram bot over WhatsApp for internal staff/manager/founders comms. POC validated round-trip + buttons + idempotency. ADR-027 + ADR-033 superseded by v0.4 work. Customer-facing receipts remain on wa.me share-intent (Telegram requires opt-in, doesn't fit customer flow).

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
