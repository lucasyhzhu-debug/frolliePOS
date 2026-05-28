# Changelog

All notable changes to Frollie POS. Format follows Frollie Pro's conventions.

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
