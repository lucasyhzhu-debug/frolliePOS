# Changelog

All notable changes to Frollie POS. Format follows Frollie Pro's conventions.

## 2026-06-21 — v1.2.1: shift-loop fixes + outlet device identity

- **Manager skip start-of-day:** a manager on `/shift/start` can skip the SOP and go straight to the menu (normal staff still walk the checklist as the first staff of the day). The skip sets a per-session bypass flag (`src/lib/shiftSkip.ts`) *before* a best-effort `completeStartOfDay`, so the manager escapes even if the open-mutation itself throws.
- **Idempotent booth close:** `endOfDaySignOff` on an already-`closed` booth is now a safe no-op (`{ durationMs: 0 }`, still ends the session) instead of throwing `BOOTH_NOT_OPEN` — covers an accidental re-close and the manager-skip state. `locked`/`handover_pending` still route to their own flows.
- **Outlet device identity:** new `pos_settings.outlet_device_id`. A manager designates the booth "outlet" from a device list (`/mgr/device-setup` → Outlet device section; `staff.listRegisteredDevices` / `staff.setOutletDevice`). Only the outlet device runs the start-of-day / handover SOP; viewer devices (a manager's PC / personal phone) skip it and go straight to the app. Unauthenticated `settings.outletStatus({ deviceId })` drives the `RootLayout` gate. Absent designation ⇒ every device is the outlet (backward compatible). This also resolves a class of "stuck in start-of-day" loop caused by logging in on a non-outlet device.
- New audit verb `settings.outlet_device_set`.

## 2026-06-21 — Hotfix: shift count-step Save button dead during handover-in

- **Incoming staff during a handover got stuck on the stock-count step — the Save button was tappable but did nothing, freezing the whole handover (prod incident, "Sisca can't sign off").** Root cause was in `CountStep`: it re-derived the session from its own `useSession()` hook instead of the authoritative session the handover route already held. Right after the incoming staff logs in, `storeSession()` fires but `useSession()` is briefly *not* `active` — so inside `CountStep` the session id was `null`, the inventory list rendered **empty** (`listInventory` skipped), and the Save button's `disabled` guard (`busy || !key`) left it **enabled while `submit()` silently `return`ed on `!sessionId`** — an enabled-but-inert control with zero feedback. The count step gates the wizard (`ShiftWizard` hides the advance button until count succeeds), so the handover could not proceed.
- **Fix:** `CountStep` now accepts an authoritative `sessionId` prop (prop wins; `useSession()` is the fallback for the recount route). The handover-in flow passes `stage.sessionId`; `ShiftWizard`/`end.tsx` thread the active session through for the close + handover-out wizards. The Save button's `disabled` now also includes `!sessionId`, so it can never be enabled-but-inert again. FE-only; no backend or schema change. Added two regression tests (submit succeeds via prop while `useSession` is mid-lag; button disabled when no usable session).

## 2026-06-21 — Hotfix: repeat admin edits silently no-op'd (idempotency key not rotating)

- **A manager editing several items back-to-back on one screen — e.g. uploading photos to Dubai 1/3/8 in a single `/mgr/products` session — found only the first edit stuck; the rest silently vanished (prod symptom: uploaded product photos never appeared).** Root cause was in `useIdempotency`: the hook reads its key once per mount, and `clearIntent()` only deleted the **client** IDB row — it never rotated the in-memory key nor cleared the server's 24h `pos_idempotency` cache. So the 2nd+ mutation of the same intent reused the spent key, the server **replayed** the first call's cached `{ok:true}`, and the handler (the `updateProductMeta` patch, the upload-URL mint) never ran. It "worked in testing" because single edits (or a reload between them) get a fresh mount = fresh key. Affected every multi-edit admin surface (products, staff, vouchers, receipt), not just photos.
- **Fix:** `clearIntent(intent)` now notifies mounted `useIdempotency(intent)` hooks (via a module-level rotate subscription) so they mint a fresh UUID in place — no remount required. This makes every existing `clearIntent` call site behave the way its authors already assumed ("the next attempt gets a fresh key"). FE-only; no backend or schema change. Added a regression test for the mounted-`clearIntent` path (the prior test only covered unmount → remount).

## 2026-06-21 — Hotfix: shift-end Telegram summary never fired (Lock vs End-shift)

- **Staff ended their shifts with the app-bar Lock icon instead of End-shift, so the founders shift-end Telegram summary never sent (prod incident).** The home app bar carried two adjacent *unlabeled* ghost icons — 🚩 End-shift (`/shift/end`, the only path that fires the summary) and 🔒 Lock (`/lock`, which is silent + resumable *by design*). Staff tapped Lock; prod history showed **zero** `endOfDaySignOff` ever — only locks. The send path itself was healthy (handover-out summaries delivered fine), so this was purely a UX-trap, not a backend bug.
- **Fix:** removed the End-shift icon from the app bar (Lock is now the lone top control); promoted the two real shift-end actions to labelled **big buttons** on the home screen under an "END OF SHIFT" heading — **Close booth** and **Handover**. `/shift/end` now accepts `?mode=close|handover` so the buttons deep-link straight into the wizard (the choice screen stays as the bare-route fallback). FE-only (no backend signature change); removed dead `home.endShift`/`home.lockHandoff` i18n keys, added `home.lock`/`home.group.shift`; updated home + shift/end tests. PR #120.
- **Ops:** backfilled the missing founders summary for the staff whose lock-ended shift was skipped — recorded the corrective `signoff_close` (booth → `closed`, ready for the next day; this also consumes the stale lock so the morning start-of-day stale-autoclose can't double-send), then sent the single summary keyed to that event.

## 2026-06-20 — v1.2 #12 inline messaging (slice 2)

- Converted sync form-validation toasts to inline `FieldMessage` in settlements,
  mgr/staff (also closing an i18n literal gap), device activation, and mgr/receipt logo.
- Refactored stock/$skuId server errors behind a local `humanizeThresholdError`.
- Extended the ADR-048 ESLint fence: registered 6 files + banned `toast.error(t(...))`
  (the post-i18n shape of an escaped sync validation).
- Repaired ESLint flat-config block ordering: the `#12` fence block was previously
  placed before the `#1` i18n block — because flat-config last-wins, this made the fence
  dead for all registered files. Block moved after `#1`; i18n selectors duplicated into
  `#12` so files in both registries carry both fences.

## 2026-06-20 — v1.2 #3: Product photos + sale-grid title legibility

- Products can carry a manager-uploaded photo (manager-session); products without one render a deterministic colored initials chip (existing `initials`/`hue`).
- Sale grid: square thumbnail + 2-line wrapping title (drops truncation); 1-column collapse on the narrowest phones.
- New `catalog.generateProductPhotoUploadUrl`; `updateProductMeta` gains `photo_storage_id` (keep/set/remove); `catalog`/`listAllProducts` project `photo_url`. No schema change.

## 2026-06-20 — v1.2 #13: Receipt cleanup

- Paid receipts no longer print the "LUNAS" / "[ LUNAS ]" status badge — a handed receipt is paid by definition. Refund-state badges (`SEBAGIAN DIKEMBALIKAN` / `DIKEMBALIKAN`) are kept.
- Payment block collapsed to a single line: `QRIS · RRN` (HTML middot) / `QRIS - RRN` (thermal ASCII); method-only when there's no RRN. Dropped the "Dibayar via" and "RRN:" labels.
- Manual-BCA sales now render `Transfer bank (manual)` instead of the leaked cancelled-QRIS method (the receipt was reading the dead invoice, not the txn's `confirmed_via`).
- Receipt footer default → "Thank you!"; the business-name default was already "FROLLIE".
- **Ops (owner-owned):** update the live `pos_settings` row via `/mgr/receipt` — business name → `FROLLIE`, footer → `Thank you!`. The code default does not overwrite an already-set field.
- Renderer change is **not retroactive** to receipts already cached in `pos_receipt_html_cache` (24h TTL); they self-heal as the TTL expires. No forced purge.

## 2026-06-20 — Hotfix: cancel-sale double-cancel on the charge screen

- **"Cancel sale" threw `TXN_NOT_AWAITING` / `INVALID_STATE_FOR_CANCEL` into the console (most visible on the manual bank-transfer tab).** `handleCancel` runs the `cancelTransaction` *action* (commits the txn → `cancelled` server-side) then navigates to `/sale`. An action's commit doesn't synchronously refresh the client's reactive subscription, so at navigate time `txn.status` was still the stale `awaiting_payment` and `/sale` sits outside the navigation guard's `allowWithin` charge subtree — so `usePathChangeBlocker` popped the "Cancel payment?" dialog *after* the user had already cancelled, driving a redundant second cancel (`cancelAwaitingPayment` → `TXN_NOT_AWAITING`; a re-click → `INVALID_STATE_FOR_CANCEL`). The client caught them, but Convex logs every server-side throw to the browser console.
- **Fix:** added a live `bypass` escape to `usePathChangeBlocker` (read inside the predicate, mirroring how `allowWithin` already dodges the stale `when`). `charge.tsx` sets `leavingRef.current = true` right before the deliberate-exit navigates in `handleCancel` and `handlePickAnotherVoucher`, so an explicit cancel no longer trips the guard. 2 regression tests on the pure `shouldBlockNavigation` predicate.

## 2026-06-20 — Hotfix: handover-in no-session deadlock

- **Booth stuck in `handover_pending` after handover-out (prod incident).** `handoverOut` ends the outgoing session, so during `handover_pending` the device has no active session. `RootLayout`'s session gate redirected the session-less `/shift/handover` → `/login`, while `login.tsx` redirected `handover_pending` → `/shift/handover` — an infinite redirect bounce that re-fired `getActiveStaff` on every remount ("login screen refreshing crazily"). The incoming staff could never log in.
- **Fix:** `/shift/handover` is now exempt from the no-session redirect *when the booth is genuinely `handover_pending`* — the screen where the incoming staff authenticates (`loginWithPin`) must be reachable session-less. Mirrors how `/login` is already exempt. A stale or manual visit with no pending handover still correctly redirects to `/login`. The outgoing session still ends at handover-out (ADR-003/ADR-050 upheld — no departed-staff session lingers). One-file routing change + 2 RootLayout regression tests.
- **Ops:** the live stuck device was reset by recording a corrective `signoff_close` (booth → `closed`); its shift summary had already been captured by the `handover_out` row, so no double-count.

## 2026-06-20 — Hotfix: login navigation + refund e2e i18n

- **Login regression (from #7):** post-login navigation was deferred behind a 200ms "Welcome" timer that got cancelled when `storeSession()` briefly flipped the session to `loading` and RootLayout unmounted the login route — stranding staff on the PIN screen. Now navigates synchronously on success (the success tint still paints for the render before unmount). Fixed every e2e sign-in (7 specs were timing out on the home heading).
- **Refund e2e (from #1):** the refund-status badge is now locale-driven (default `en`), so the detail badge renders `REFUNDED`, not the old hardcoded `DIKEMBALIKAN`. Updated the assertion to match.

## 2026-06-20 — v1.2 #7 + #11: Login PIN feedback

- Keypad keys show a pressed state and lock with a "Verifying…" spinner while the PIN is checked.
- Wrong-PIN and locked-out errors now appear inline (red) under the dots instead of as a toast; success flashes green before home loads.
- Fixed the spurious "PIN reset declined" toast that re-fired on screen remount (now de-duped via localStorage).
- Staff-list rows gain a touch pressed-state (active background + motion-safe scale).
- All copy routes through the typed i18n dictionary (EN/ID); preserves the v1.2 #6 booth-state navigation fork on success.

## 2026-06-19 — v1.2 #1: EN/ID language picker (i18n)

- Per-staff EN/ID language toggle (flag-backed) on the home YOU group; English default.
- Zero-dependency typed i18n dictionary (`src/lib/i18n/`); `staff.locale` preference + `setOwnLocale`.
- ESLint fence prevents hardcoded copy regressions in converted files (ADR-049).
- Currency + dates unchanged (id-ID); receipts/Telegram out of scope.

## 2026-06-19 — v1.2 #6: Shift SOP flow

Booth shift lifecycle as a state machine, structured handovers, and an audience-split signoff summary.

**Backend (`convex/shifts/`):**
- New `pos_shift_events` table: event-sourced source of truth for booth state. Indexed by `(device_id, created_at)` and `(staff_id, shift_started_at)`.
- Pure `deriveBoothState(latestEvent, wibDayStartMs)` maps the latest row to one of four states: `closed` / `open` / `locked` / `handover_pending`. Stale-autoclose: prior-day non-closed event → `closed + staleAutoclose: true`.
- Seven event types: `start_of_day`, `lock`, `resume`, `signoff_close`, `handover_out`, `handover_in`, `manager_takeover`.
- Public mutations (all ADR-013 wrapped): `completeStartOfDay`, `lockShift`, `recordResume`, `endOfDaySignOff`, `handoverOut`, `completeHandoverIn`. Query: `boothState`.
- Write-side state guards: each lifecycle mutation re-derives the booth state via `deriveBoothState` and rejects illegal source states with a stable error (`BOOTH_NOT_CLOSED` / `BOOTH_NOT_OPEN` / `BOOTH_NOT_LOCKED` / `NO_HANDOVER_PENDING`).
- Stale auto-close: `completeStartOfDay` finding a prior-WIB-day open shift records a `stale_autoclose: true` `signoff_close` for the displaced staff (with summary) and fires that shift's Founders summary server-side before opening today (spec §2).
- Session end routes through `auth.internal._endShiftSession_internal` (ADR-034) — sign-off / handover-out / lock no longer patch the auth-owned `staff_sessions` directly. `pos_shift_events` added to the ESLint cross-module OWNERSHIP map.
- `managerTakeover` action (Node, argon2id): escape hatch when the locked booth's original staff is unavailable. Atomically force-ends the displaced session, creates a manager session, records the event with `outgoing_uncounted: true`.
- `_shiftStartAnchor_internal`: recovers the original shift-start (skipping `lock` events) bounded to today's WIB-day window (no `.take(50)` ceiling that could silently miss the anchor on a busy day); ensures accumulated hours survive lock/resume cycles.
- `_sendSignoffSummary` / `_sendTakeoverSummary` deferred actions: dispatch `staff_shift_signoff` Telegram template to Founders (`endedBy: "self"` or `"manager"`).
- ADR-003 confirmed: lock still ends the session (`end_reason: "manual_lock"`); `locked` is a booth-state layer, not a held session. No `staff_sessions` schema change.
- Audit verbs: `shift.start_of_day`, `shift.lock`, `shift.resume`, `shift.signoff`, `shift.handover_out`, `shift.handover_in`, `shift.manager_takeover`.

**Telegram:** new `staff_shift_signoff` template to the Founders role — hours + sales IDR + txn count + manual-BCA itemized list. Staff-facing close screen shows hours + stock only (no financials). ADR-050.

**Frontend (`src/routes/shift/`):**
- `ShiftWizard` multi-step rail: instruction + count steps, reduced-motion safe.
- `CountStep`: reusable stock count input, also wired to the existing recount flow.
- `useBoothState` hook: subscribes to `shifts.public.boothState`; drives the login-gate fork.
- Routes: `/shift/start`, `/shift/end`, `/shift/handover` (`src/routes/shift/{start,end,handover}.tsx`).
- Login-gate fork in `login.tsx` branches on `boothState` to prompt the start-of-day SOP on first login of the day.
- Lock screen: "Unlock" resumes for the same staff; "Manager unlock" enters `managerTakeover` flow.

**ADR:** [ADR-050](docs/ADR/050-shift-lifecycle-state-machine.md) — booth shift lifecycle state machine.

## 2026-06-19 — chore: bump app version 1.0.0 → 1.2.0
- `package.json` version had sat at `1.0.0` since launch while shipping through the v1.2 milestone. Bumped to `1.2.0` so the home-screen label (`__APP_VERSION__`) and ops error reports reflect the real release line. (Milestone phase IDs like "v1.2 #10" remain the planning handle; package semver tracks the shipped milestone.)

## 2026-06-19 — Public API v1: date filtering + dev token prefix
- feat(api/v1): `GET /api/v1/transactions` and `/api/v1/refunds` accept optional
  `from`/`to` query params (epoch ms, inclusive-lower / exclusive-upper) that
  clamp the feed to a time window, filtering on the cursor's order key
  (`paidAt`/`createdAt`). Composes with the cursor (effective lower bound =
  `max(cursor watermark, from)`), bounded at the existing range indexes
  (`by_status_paid_at` / `by_created_at`) so no scan. Backward-compatible:
  omitting both = prior drain-from-beginning behaviour. New `400 BAD_RANGE`
  (non-integer/negative bound, or `from > to`). Lets the ERP reconcile a single
  day / re-pull a range / backfill without resetting its cursor.
- fix(api/v1): `_issueApiToken_internal` now takes `isTest` to mint the
  `frpos_test_` prefix on dev (prod default stays `frpos_live_`), matching the
  consumer contract §7. Token stays opaque — prefix is ops hygiene only.
- Shared `convex/api/v1/_request.ts::parseRange`; `docs/PUBLIC_API.md` §2/§4a/§5/§8 updated.

## 2026-06-19 — v1.2 #10: Manual bank transfer + retire BCA VA
- Hidden the broken BCA VA tab (QRIS is the sole Xendit method; the error-toast storm is gone).
- Added a "Bank transfer (manual)" tender: staff self-confirm against the static company BCA account; sales are marked `manual_bca`, flagged in the manager ticker, and itemized in the EOD founders summary for reconciliation.
- Account config (bank / name / number + enable toggle) ships with baked-in defaults (`MANUAL_BCA_DEFAULTS`); there is intentionally **no booth UI** to edit the settlement account — changes are server-side only (Convex dashboard / CLI), a deliberate security boundary so a frontend session can never redirect the payout account.

## v1.2 #12 slice 1 — Inline messaging over toasts
- New `FieldMessage` design-system primitive (`src/components/ui/field-message.tsx`) for sync form-validation, AA-legible on the phthalo-dark canvas (error/success tokens dark-lifted).
- Converted `mgr/products.tsx` (26) and `mgr/vouchers.tsx` (12) sync-validation toasts to per-field inline messages with `aria-invalid`/`aria-describedby` + focus-first-error.
- ESLint `no-restricted-syntax` fence prevents migrated files regressing to literal-arg `toast.error`/`toast.warning`.
- Policy: ADR-048 (inline for sync validation; toasts for global/async; PIN flows owned by #11/#7).

## 2026-06-19 — fix: persist device identity (no more repeat re-activation)
- fix(device): request `navigator.storage.persist()` at startup so the device-id
  (IndexedDB + localStorage) is no longer kept in the browser's evictable
  best-effort bucket. On a desktop browser tab the storage could be evicted
  between sessions, minting a fresh device UUID that no longer matched the
  `registered_devices` row and forcing a re-activation each visit. The
  server-side registration never expired — only the client identity was being
  dropped. Installed PWAs (booth Android) were already getting persistence
  automatically, which is why only desktop tabs reactivated. New
  `src/lib/persistStorage.ts` (feature-detected, fire-and-forget); no schema /
  backend / deploy-skew surface.

## 2026-06-19 — v1.0.2 In-app sales-ticker toggle
- Managers can now enable/disable the live sales ticker from /mgr/telegram-chats
  (next to the founders-summary toggle) — no Convex-dashboard edit needed.
- Backend: `settings.setTxnTickerEnabled` (manager-session, idempotent, audited
  `settings.txn_ticker_toggled`); `settings.getSettings` now returns
  `txn_ticker_enabled`. No schema change (field shipped in v1.0.1).

## 2026-06-18 — Public API v1 (Frollie Pro sales sync, producer)
- GET /api/v1/transactions + /api/v1/refunds — bearer-authed, cursor-paginated, product-level. See docs/PUBLIC_API.md.
- api_tokens / api_rate_buckets / api_request_log tables; append-only access log; daily api-housekeeping cron.
- pos_products.code / staff.code now REQUIRED; sku_family snapshot fallback removed.

## 2026-06-18 — v1.2 Phase 1: Phthalo-dark design system (#2, folds in #4 + #5)
- feat(ui): the POS now ships the Frollie/Lucas **phthalo-dark** canvas as its default theme — paper `#102821`, lifted cards `#163630`, warm ink `#F1E9D8`, teal `#14B8A6` primary, **citrus `#F9A84A`** accent. Mounted via a permanent `class="dark"` on `<html>`; `:root` retained as an enriched-light glare-gate fallback (flip one attribute). `@custom-variant dark` re-keys `dark:` utilities to the class. ADR-047. **Tokens drive everything, so untouched routes inherit the dark canvas automatically.**
- feat(ui): primitives enriched — Card elevation (`shadow-md`), Button tactile press (`active:scale-[0.97]` + primary gradient), Badge dark-tuned to translucent fills (`bg-x/15 text-x border-x/30`). Motion via `tw-animate-css` (Radix primitives) + Framer Motion micro-interactions, every one a full no-op under `prefers-reduced-motion`.
- feat(ui): three surfaces redesigned — **Home** gets a top app-bar (Lock icon left, Printer + ConnDot right), a hero "New sale" CTA (~half screen), grouped tiles with a reserved photo/initials slot, and **folds in #4** (manager tiles + Settlements hidden from staff, empty groups dropped) and **#5** (Lock moved to the app-bar icon, bottom Lock button removed). **Sale** gets tap-to-cart pop + cart reflow motion + citrus qty badge. **Charge-success** gets a checkmark-draw celebration. **Login + keypad** restyled to the dark shell (visual only — submit/keypad-interaction logic stays #7/#11).
- refactor(ui): swept ~44 raw Tailwind palette literals → semantic tokens across 15 files (dark-safe); pruned ~35 dead tokens (16 station + 8 channel + 3 kitchen + 8 semantic/role `*-bg`) with their never-rendered `badge.tsx` variants. Shared grid-stagger motion variants extracted to `src/lib/motion.ts`.
- **Glare HARD GATE (open):** the emulated-tablet readability pass cleared in dev; the real booth-tablet readability check under mall lighting remains owner-owned before the rollout is declared done. Fallback if it washes out: remove `class="dark"` (one-attribute revert to enriched-light). No schema/backend/deploy-skew surface — fully reversible.

## 2026-06-18 — v1.2 Phase 0: Modal off-screen fix
- fix(ui): `DialogContent` now caps at the viewport (`max-h-[calc(100dvh-2rem)]`) and scrolls internally (`overflow-y-auto`), so tall dialogs (PinSheet, PrinterSheet, mgr admin dialogs) no longer clip their header/footer off-screen on the booth tablet (#8). One change to the shared primitive fixes all 11 dialog instances; verified on emulated 800×600 + 800×420 viewports. No schema/backend/deploy-skew surface.

## 2026-06-18 — v1.0.1 Launch-day ops observability
- Error pipe: client + backend failures `POST /ops/error` → deduped/storm-capped `pos_error_reports` (append-only telemetry, NOT `audit_log`) → `system_error` alert to the new Telegram `ops` role. New env vars `OPS_INGEST_TOKEN` (Convex) + `VITE_OPS_INGEST_TOKEN` (Vercel/`.env.local`) — set on both dev and prod before the FE deploy or `/ops/error` silently 204s (RUNBOOK §5).
- Live sales ticker: every paid sale posts a silent `txn_ticker` message to the Managers group, hooked into `_confirmPaid_internal`; toggle `pos_settings.txn_ticker_enabled` (default on).
- Runbook §9: pre-run smoke checklist + sanctioned hot-fix protocol + rollback + ticker-off.

## 2026-06-17 — v1.1 Security Hardening
- SEC-01: PIN-lockout counter no longer dedupes on client idempotencyKey (brute-force fix).
- SEC-02: `commitCart` rejects non-positive/fractional quantities at the trust boundary.
- SEC-03: `bootstrap` requires `BOOTSTRAP_MANAGER_PIN` env (no hardcoded `1111`); seeded manager carries `must_change_pin` (FE forces a one-time rotation prompt). Hardens future deploys/tests only — the live prod account is hardened by the operational PIN rotation, not by merging this.
- SEC-04: device activation throttled (per-device 5/60s + global 50/15-min window); setup-code TTL 1h→15min. `activateDevice` is now an action so the throttle counter persists across the rejection.
- SEC-05/06: `getById` + `getCurrentInvoice` session-gated + day-scoped + projected; `receipt_token` (and other internal fields) no longer leaked. System callers use new `_get*_internal` full-row variants.
- SEC-07: off-booth Telegram-approve PIN misses are audited but no longer pollute the booth lockout counter (leaked-token DoS-lock fix); bounded by the per-token cap.

## 2026-06-12 — v1.0.0 launch

- Polish slice across the staff-critical loop: offline banner + action guard on the charge screen (ADR-025; covers retry, manual override, method switch, cancel, and the off-booth approval-request buttons), `/stock` empty state, `useIsOnline` hook extracted from ConnDot, stock-in stub tile/route removed (restock = recount until v0.5.2b), dev version tags stripped from home tiles
- One-shot prod launch-catalog seed (`seed/internal:_seedLaunchCatalog_internal`): `dubai` + `water` SKUs and 4 products — Dubai Chewy Cookie Single/Triple/Eight (Rp 45.000 / 125.000 / 320.000) + Mineral Water (Rp 5.000); guarded against any pre-existing catalog rows
- Booth operations runbook (prod) in `docs/RUNBOOK.md` §8
- Production go-live: backend + frontend deployed, Telegram roles verified, live Rp 1.000 smoke test (sale → webhook → receipt → refund → settle), paper system retired

## 2026-06-08 — v0.7 Xendit settlement reconciliation
- `/settlements` now shows per-day payout figures (net to BCA, gross, MDR, txn count) to staff + managers (ADR-012).
- Managers can record a settlement day manually (PIN-gated) — the verified launch path while Xendit KYB is pending.
- Nightly auto-poll of Xendit `GET /transactions` aggregates settled transactions by WIB date (built + shape-tested; live-verification gated behind KYB). Confirmed real API shape: `fee` is an object (use `net_amount`), no `settlement_date` field (derive from `estimated_settlement_time`), `cashflow` gates MONEY_IN.
- New `pos_settlements` table (per-day aggregate, dual-source); ADR-012 amended to the verified per-transaction model (no settlement webhook).

## 2026-06-07 — v0.6.1 admin-action auth hardening + e2e un-skip

### Security
- `withActionCache` now runs a required pre-cache `authCheck` (ADR-046): the 8
  PIN-gated admin actions assert a live manager session before the idempotency
  lookup, closing a cached-result replay gap. PIN verify still skipped on legit retry.

## 2026-06-07 — Presentation hosting

### Added
- **Conference-talk deck hosted in-app** at `/presentation/frolliepos-talk.html` — the self-contained 10-slide Frollie POS talk, served as static files from `public/presentation/` (rides the existing Vercel deploy, no separate project). Fonts load from Google Fonts CDN; 4 screenshots ship alongside the HTML.
- **Manager-home "Presentation" card** (`▶`) opens the deck in a new tab. Rendered as a real `<a target="_blank" rel="noopener noreferrer">` (not a React Router `<Link>`) so the browser loads the static file directly. Manager-gated like the rest of `/mgr/home`.

### Changed
- `vite.config.ts` PWA workbox: added `/^\/presentation\//` to `navigateFallbackDenylist` (so the SW serves the real deck, not the SPA shell) and `globIgnores: ["**/presentation/**"]` (keeps the deck out of the precache manifest).

### Backend
- None. Frontend + static assets only.

## 2026-06-06 — v0.5.9 e2e stabilization + evidence-before-mitigation discipline

**Closes:** #44 (e2e session-on-hard-nav), #49 (a11y aria-label sweep), #50 (selector-drift discipline)
**Supersedes:** PR #48 (closed unmerged; same scope + selector residuals ship together)

### Fixed
- Catalog "Add" buttons now distinguish pack sizes (`Add Dubai 1 pc` / `Add Dubai 3 pcs` / `Add Dubai 8 pcs`) rather than three buttons all named "Add Dubai". Root cause of issue #44 — selector drift, not a Convex client race. See `docs/postmortems/2026-06-issue-44-misdiagnosis.md` for the misdiagnosis trail.
- Spoilage form Qty Label / Voucher form Type Label now have `htmlFor` + `id` pairs (per-row for spoilage; static for vouchers) so screen readers and Playwright `getByLabel` resolve them (#49).
- Charge screen tab selectors corrected to `role="tab"` in e2e specs. Radix `TabsTrigger` renders as `role="tab"`, not `button`; spec adapts to source.
- `e2e/fixtures.ts` 1500ms warm-up dropped — refuted mitigation per PR #48 instrumentation (Playwright run `27021101339`).

### Added
- `src/lib/label.ts::buildAddCardLabel(name, packLabel)` — pure helper with vitest pinning all 7 seed products + edge cases (empty pack_label, Mixed Box whitespace).
- `docs/PATTERNS/skip-comment-template.md` — required three-field format (observed failure mode + evidence path + follow-up issue) for every `test.skip` block. Cross-linked from `CLAUDE.md` "How to add a feature" §10.
- `docs/postmortems/` directory + README (genre distinct from `docs/reviews/`) + first entry `2026-06-issue-44-misdiagnosis.md`.

### Tests
- e2e `auth.spec.ts` happy path: still green.
- e2e `voucher-online.spec.ts`: **honest re-skip**. Slice 1 a11y fixes + Slice 2 form-flow fixes (open Add-voucher Dialog first, button role for /sale voucher entry, Continue submit text) all work — spec reaches the simulate step where the Xendit 404 reappears (same root cause as sale-qris). Body kept intact for auto-un-skip when the upstream lands.
- e2e `voucher-offline.spec.ts`: **honest re-skip** (seed/actions:reset doesn't expose stable test IDs for the concurrent-archive race; body deleted to make SKIP unambiguous).
- e2e `sale-qris`, `sale-bca-va`, `refund`, `spoilage`: **honest re-skip** with three-field SKIP comments. Slice 1 a11y fixes work — Gate 1-3 surfaced different failure modes (Xendit test-mode simulate 404 for QRIS+FVA + spoilage button-state mystery) that need investigation outside this PR's scope. Follow-up issue filed.
- e2e `auth.spec.ts` lockout body: stays `test.skip` (out of scope per v0.5.7.1).
- **Verification of all 6 re-skipped specs deferred until v1 feature dev completes** — see [`docs/e2e-gaps-deferred.md`](./e2e-gaps-deferred.md) for the live tracker. Verifying piecemeal in v0.5.9 turned into selector-drift whack-a-mole on UI that may still move before v1.

### Discipline
- Global `~/.claude/skills/staffreview/SKILL.md` §4.9 "Evidence-Before-Mitigation Gate" — additive subsection (no existing section reordered). Lands as a file edit on disk; the skill is not a git repo on this machine. Cross-project applicability.
- REFUTED banners on `docs/superpowers/plans/2026-06-05-issue-44-usesession-transient-null-fix.md` and `docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md` pointing to this PR and the postmortem.

### Backend
- None. Convex surface untouched; ADR-034 deep-module discipline preserved.

## 2026-06-05 — v0.5.8 Orphaned-function wiring

- **Audit-log viewer** (`/mgr/audit`): manager-only append-only activity trail. `audit.public.list` now pre-derives `actor_name` server-side (ADR-034 / v0.5.3a label pattern).
- **Awaiting-payment recovery banner** on home: surfaces in-flight `awaiting_payment` txns (last 5 min) via the new `useAwaitingPaymentRecovery` hook; tap to resume the charge screen.
- **Cancel a pending approval**: optional manager-gated "Batalkan permintaan" button on `ApprovalPending`, wired into the refund flow (`cancelPendingRequest` is manager-session gated).

## 2026-06-05 — /activatepos Telegram device activation

- Managers can mint a 6-digit device setup code by sending `/activatepos` in the
  managers Telegram chat (chat-role gated). Activates a new phone/browser on the fly.
- Schema: `pending_device_setups.issued_via` discriminant + optional `issued_by` /
  `issued_by_telegram`; `registered_devices.activated_by` now optional. Telegram-issued
  codes audit with the `"system"` actor + `"system"` source (not `telegram_approval` —
  there is no PIN/approval gate; the channel is recorded in `metadata.issued_via`).
- Single-writer `issueDeviceSetupCode` helper shared by booth + Telegram paths.

## 2026-06-03 — v0.5.6 Admin wiring + receipt/refund UX

All four parts are additive UI wiring of existing backend (no schema, no migration).

- **Self "Change PIN"** — new `/account` spoke + home tile (YOU). Wires the existing `auth.changePin` action (one-shot idempotency key; maps `INVALID_PIN`/`SAME_PIN`/`NEW_PIN_INVALID`/`LOCKED_OUT`/`SESSION_INVALID`). Closes the sole-manager dead-end.
- **Generate device setup code** — new `/mgr/device-setup` spoke + NAV_CARD. Wires `staff.generateDeviceSetupCode`; shows the 6-digit code + expiry countdown + regenerate. Replaces the CLI bootstrap path.
- **Print receipt on history detail** — `history/$txnId` reprint button reusing `getReceiptForPrint` + `PrinterProvider` (ADR-043). Same bytes as charge-success.
- **Refund flow entry points** — per-txn "Refund" button on `history/$txnId` (gated paid && refundStatus !== "full") + a "Refund" home tile to the existing `/refund` list. (The `/refund` list/detail flow itself shipped in v0.5.1b; this only adds the doors.)

## Dev tooling (unreleased)

- `seed:reset` now pre-registers a fixed dev device (`dev-booth-device`), and `useDeviceId` returns that id under the Vite dev server, so local / Chrome-MCP loads skip the `/activate` device-registration gate. No production impact — gated on `import.meta.env.MODE === "development"`, so the prod build and the test runner keep the random per-install UUID path. Dev credentials after seed: Lucas (manager, PIN 9999), Bayu/Citra/Dewi/Eka (staff, PIN 0000).

## 2026-06-03 — v0.6 Vouchers + spoilage + nightly stock-recon (PR #25, `2c0133c`)

Manager voucher CRUD, a new `spoilage` approval kind (booth + Telegram paths sharing one writer), and a nightly report-only stock-drift cron ([ADR-044](./ADR/044-nightly-stock-recon-report-only.md)). Plan + task manifest at `docs/superpowers/plans/2026-06-02-v0.6.md`.

**Playwright E2E (Wave 4) — scaffold landed, suite mostly quarantined.** The harness (`playwright.config.ts`, fixtures, `globalSetup`, Xendit-simulate helper, `.github/workflows/e2e.yml`) and all 7 spec files shipped in this PR. However **only `auth` sign-in is an active test** — the other 6 specs (`sale-qris`, `sale-bca-va`, `voucher-online`, `voucher-offline`, `refund`, `spoilage`) plus the lockout test are `test.skip`'d, blocked on hard-nav session loss (issue tracked in #43; stabilization arc ran through v0.5.7–v0.5.9). The earlier "deferred to v0.6.1" note is superseded: the files exist on main but do **not** yet prove the golden path. Un-skipping is the real v0.6.1 work.

### Vouchers

- New `/mgr/vouchers` — manager portal: create (PIN-gated), update meta (manager-session), archive (manager-session), redemption history with receipt-number annotation.
- Offline cart-build fallback: when live `validateVoucher` is unavailable, the FE validates against the IDB-cached catalog snapshot via the shared pure helper `convex/lib/voucherValidate.ts` so BE (`validateVoucher`) and FE (offline path) cannot drift on `NOT_FOUND` / `INACTIVE` / `EXPIRED` / `MIN_CART_VALUE` semantics. Server re-validates on charge per [ADR-009](./ADR/009-voucher-cache-offline.md).
- ADR-009 reject banner on `/sale/charge`: when `commitCart` silently drops a stale voucher, the charge screen surfaces a humanized banner with a "Pick a different voucher" affordance — replaces the previous silent-drop behaviour.

### Spoilage

- New approval kind `APPROVAL_KINDS["spoilage"]` ([rule #19](../CLAUDE.md), 5 touchpoints wired).
- Booth path: new `/mgr/spoilage` route + manager-PIN `recordSpoilage` action.
- Off-booth path: `requestSpoilageApproval` mints a Telegram approval card → manager taps `/approve/:token` → `approveSpoilage` commits via the same `_recordSpoilage_internal` writer used by the booth path. Single writer, two callers.
- `pos_stock_movements` gains optional `spoilage_reason` + `spoilage_event_id` (groups multi-line spoilage events).
- `/approve/:token` page extended with the `kind:"spoilage"` discriminator + dispatch.
- New Telegram template `spoilage_approval`.
- New audit verbs: `stock.spoilage`, `spoilage.requested`, `spoilage.approval_resolved`, `spoilage.denied`.

### Nightly stock-reconciliation

- New `pos_stock_drift_log` table + indexes `by_sku_detected` and `by_unresolved`.
- New daily cron at 02:00 WIB (19:00 UTC) — `sendStockReconResilient` (linear retry, `RESILIENT_MAX_ATTEMPTS=3`) reconstructs `on_hand` per active SKU by replaying `pos_stock_movements`, compares to cached `pos_stock_levels.on_hand`, and on mismatch writes a `pos_stock_drift_log` row + audit + alerts the `inventory` role via Telegram template `stock_drift_alert`.
- **Report-only by design** ([ADR-044](./ADR/044-nightly-stock-recon-report-only.md)) — never silently auto-corrects the cache. Manager triages via the `/mgr/stock` drift tab and resolves with a note (audited as `stock.recon_drift_resolved`).
- New audit verbs: `stock.recon_drift`, `stock.recon_skip`, `stock.recon_drift_resolved`.

### ADRs

- [ADR-044](./ADR/044-nightly-stock-recon-report-only.md) — nightly stock-recon is report-only (drift_log + Telegram alert + manager triage), never auto-corrects the `pos_stock_levels` cache. Rationale: silent auto-correction would mask spoilage / theft / movement-write bugs that the cache divergence is the only surfaceable signal for.

### Docs

- SCHEMA.md — v0.6 fields (`pos_stock_movements.spoilage_reason`, `spoilage_event_id`), new table `pos_stock_drift_log`, new audit verbs.
- CLAUDE.md — rule #22 v0.6 additions (spoilage + recon-resolve gates) + new Telegram template literals.

### Deploy notes

- Backend additive (one new table, two optional movement fields, one new cron, one new approval kind). Deploy backend before frontend so the FE's new mutations / routes find their handlers.
- New cron starts firing on first deploy at 02:00 WIB. Pre-existing drift between movements and the `pos_stock_levels` cache will appear in the first run's drift_log — expected, triage via `/mgr/stock`.
- New Telegram templates (`spoilage_approval`, `stock_drift_alert`) route through the existing `managers` + `inventory` role bindings — no new role to bind.

### Not in v0.6 (deferred)

- **Wave 4 — Playwright E2E suite** deferred to v0.6.1 pending v0.6 backend on dev Convex. Plan at `docs/superpowers/plans/2026-06-02-v0.6.md` (P1–P10).

## 2026-06-03 — v0.5.5

### Catalog
- **Inventory SKU admin (standalone):** managers can now create new inventory SKUs
  from `/mgr/products` via an "Add SKU" header button (PIN-gated, audited as
  `inventory_sku.created`). Closes the v0.5.3b gap where products could be created
  but the underlying SKU line was seed-only.
- **Bundled SKU+link in Add Product:** "Add Product" gains a checkbox to atomically
  create-or-link a matching inventory SKU in a single PIN entry. Slug derives from
  `sku_family.toLowerCase()`. Editable Component qty (defaults to 1) supports both
  the "new flavor 1pc" case (qty 1, new SKU) and the "Dubai 3pcs" multi-pack case
  (qty 3, existing SKU reused). If the SKU exists it's reused; if absent it's
  created + linked + audited as `inventory_sku.created`. Multi-SKU products like
  Mixed Box still use the standalone components editor.
- New error codes mapped: `SKU_EXISTS`, `CODE_EXISTS`, `SKU_INVALID`,
  `SKU_FAMILY_NOT_SLUGGABLE`, `LOW_THRESHOLD_INVALID`.

### Resilience
- **Route-level chunk-load recovery (ADR-045):** stale-deploy "Failed to fetch
  dynamically imported module" errors now auto-recover via a guarded one-shot
  reload (`sessionStorage` timestamp, 30s window). A hard-missing chunk renders
  a friendly "Reload" fallback instead of React Router's default error screen.
  Coverage spans the app shell AND the three public sibling routes
  (`/r/:receiptNumber` is customer-facing via Telegram; `/approve/:token` is
  the manager off-booth landing; `/activate` is device setup).

### Smoke test for the post-deploy boundary
After the next prod deploy, in an existing open tab:
1. Open DevTools → Network → block `*.js` from the new build.
2. Click any nav link that triggers a lazy import.
3. Expected: page reloads once. After reload (chunks now load fresh), normal
   behaviour. If you unblock and click again, it stays normal.
4. To confirm the fallback: keep `*.js` blocked, click a link → reload → fails
   again → friendly "Something went wrong / Reload" screen, no stack trace.

## v0.5.4 — Bluetooth thermal receipt printing (unreleased)

- Print 58mm receipts to the EPPOS EP5811AI over Web Bluetooth (ESC/POS), one tap on sale-complete. **Verified working end-to-end on-device** (connect → print full paid receipt).
- One shared printer connection for the whole session (`PrinterProvider`) — connect once at shift start from the home/header chip and it survives navigation. A status dot (green = linked · amber = working · grey = not linked · red = error) makes the link state glanceable so staff reconnect while free, not mid-transaction.
- The printed **QR links to the booth's Instagram** (derived from the `instagram_handle` receipt setting), not the digital receipt — booth decision during QA (ADR-043 amended). Receipt text (business name / address / footer) is editable at `/mgr/receipt` and flows straight to the print; blank fields are skipped.
- New query `receipts.getReceiptForPrint` (view-model + status label only; never a token — ADR-021). ADR-043.

### Frontend
- `src/lib/escpos.ts` — pure `encodeReceipt(viewModel, status, statusLabel) → Uint8Array` + exported `SAMPLE_RECEIPT` fixture and `instagramUrl(handle)` helper. Text mode (no raster logo in v1); the QR encodes the Instagram URL via the encoder's native ESC/POS `GS ( k`. Skips empty header lines; prints the configurable `footer_text`. Reuses `src/lib/format`; ASCII-folds emoji; `import type` only (no Convex runtime in the bundle).
- `src/hooks/useThermalPrinter.ts` — Web Bluetooth connect (filtered chooser), silent auto-reconnect via `navigator.bluetooth.getDevices()` (probes only from the idle state → also reconnects on drop), chunked paced `writeValueWithoutResponse` (180-byte / 20 ms), `unsupported` feature-detect. Pure `chunkBytes(bytes, size)` is unit-tested.
- `src/components/pos/PrinterProvider.tsx` — app-global shared connection (`usePrinter()`), mounted once in `RootLayout` above the Outlet so the GATT link persists across route changes. Safe no-op default for provider-less renders.
- `src/components/pos/PrinterSheet.tsx` — connect / status / test-print sheet (wraps the existing `Dialog`, mirrors `PinSheet`) with a status-dot chip. Mounted globally in `AppHeader` (logged-in) and on the home launcher.
- `src/routes/sale/charge-success.tsx` — print button consuming the shared connection; encodes + prints directly (no per-print token mint — the QR is the static Instagram link).

### Backend
- `convex/receipts/public.ts::getReceiptForPrint` — session-gated, role/today-scoped print view-model query (staff: server-today; manager: any day); returns `ReceiptViewModel` + pre-derived status label, **no token/URL** (ADR-021). Read-only, not audited. Cross-module txn read via `transactions/internal` (ADR-034).
- `convex/receipts/template.ts::STATUS_LABELS` — promoted from module-private to exported so the query derives the status label server-side (client never imports `template.ts`).

### Fixes (pre-existing, surfaced during v0.5.4 QA)
- `src/hooks/usePathChangeBlocker.ts` + `src/routes/sale/index.tsx` — pressing **Charge** (or Save draft) tripped the abandon-cart guard: the cart is cleared then navigated in the same tick, but the guard's `when` was the stale pre-clear value, so it blocked a legitimate in-flow hop. Added an opt-in `allowWithin` prefix so `/sale/*` navigations never block (only leaving the flow does); predicate extracted as pure `shouldBlockNavigation` with unit tests.

### Tests
- Unit tests for `chunkBytes`, `instagramUrl`, the address-skip path, `shouldBlockNavigation`, and `usePrinter` default/provider wiring. The Web Bluetooth BLE layer is not unit-testable (cannot be mocked) and was verified on-device against the EP5811AI.

### ADRs
- [ADR-043](./ADR/043-web-bluetooth-escpos-printing.md) — client-side Web Bluetooth ESC/POS printing; `esc-pos-encoder` text mode; `getReceiptForPrint` returns view-model + label, never the token; native-QR → raster-QR and `0x18f0` → ISSC fallbacks isolated in `escpos.ts`. **Amended during QA:** the printed QR now links to Instagram (from the handle), not the `/r/<token>` digital receipt (which is still reachable via history share).

### Deploy notes
- **Android Chrome only** — Web Bluetooth has no iOS / non-Chromium implementation; the booth device is Android Chrome. No schema change; `getReceiptForPrint` is a read-only addition. Backend before frontend so the FE query finds its handler.
- **Silent reload-reconnect** depends on `navigator.bluetooth.getDevices()`, which needs `chrome://flags/#enable-web-bluetooth-new-permissions-backend` enabled on the booth device **and a stable origin** — reliable on the production Vercel domain; the in-app shared connection covers all in-session navigation regardless.
- **Deferred QA** (no blockers found; revisit if issues): refund / partial-refund receipt formatting on 58mm, voucher-line rendering, staff-scope print-button degradation, long-product-name column wrap.

## v0.5.3b — In-app admin (staff + product CRUD + receipt config) (unreleased)

- Managers can create/edit/deactivate staff in-app under a tiered manager gate (manager-PIN for identity writes, manager-session for low-stakes config).
- Managers can create/edit/archive products and edit inventory-SKU linkage; price/tax changes are PIN-gated.
- Receipt branding (text + uploaded logo) configurable from the manager portal; config change purges the receipt cache so customers see new branding on next view.
- `listStaff` no longer returns `pin_hash` (v0.2 follow-up — security cleanup).
- New `verifyManagerPinOrThrow` helper; `resetStaffPin` refactored onto it.

### Frontend
- New `/mgr/staff` — create, rename, role-change, deactivate, reset-PIN under the appropriate gate.
- New `/mgr/products` — create, edit metadata, edit inventory-SKU components, edit pricing (PIN), archive.
- New `/mgr/receipt` — receipt branding form (business name / address / contact / IG / footer) + logo upload + live preview.

### Backend
- `convex/staff/actions.ts` — `setStaffRole`, `deactivateStaff` (both manager-PIN).
- `convex/staff/public.ts::listStaff` — strips `pin_hash` from the returned shape; new internal `_helpers.ts` for the projection.
- `convex/staff/public.ts::createStaff` — now manager-PIN gated.
- `convex/staff/public.ts::updateStaffName` — manager-session (low-stakes rename).
- `convex/catalog/actions.ts` — `createProduct`, `updateProductPricing` (both manager-PIN).
- `convex/catalog/public.ts` — `updateProductMeta`, `setProductComponents`, `archiveProduct` (manager-session); `listAllProducts` admin query.
- `convex/settings/public.ts` — `getReceiptConfig`, `updateReceiptConfig`, `generateLogoUploadUrl`.
- `convex/receipts/internal.ts::_purgeAllReceiptCache_internal` — wiped on every receipt-config update.
- `convex/receipts/template.ts` — reads branding from `pos_settings`; renders uploaded logo + configurable footer.
- `convex/auth/verifyPin.ts::verifyManagerPinOrThrow` — extracted helper; `resetStaffPin` refactored onto it (consolidates manager-PIN verification).
- `pos_settings` gains 6 optional fields: `receipt_business_name`, `receipt_address`, `receipt_contact`, `receipt_instagram_handle`, `receipt_footer_text`, `receipt_logo_storage_id`.
- New audit verbs (all `source=booth_inline`): `staff.updated`, `staff.deactivated`, `product.created`, `product.updated`, `product.archived`, `settings.receipt_updated`.

### Tests
- New vitest suites cover staff admin (create/role/deactivate), product admin (CRUD + components + pricing), receipt config (CRUD + cache-purge), and the `verifyManagerPinOrThrow` funnel.

### ADRs
- None new — slice extends existing tables (`pos_settings`, `staff`, `pos_products`, `pos_product_components`) and follows the established manager-PIN / manager-session gate pattern.

### Deploy notes
- Backend additive (six new optional `pos_settings` fields; no migration needed). Receipt cache is purged on first config write, so existing minted receipts re-render lazily with new branding on next view.

## v0.5.3a — Reporting (transaction history + manager dashboard) (unreleased)

Read-mostly reporting slice: staff get a same-day transaction history, managers get any-day plus a laptop-first dashboard. Customer receipts can be re-shared from history via `shareReceipt` — the first real caller of the v0.5.1 dormant lazy-mint seam. Zero schema change; reports are a pure function of `(WIB calendar date, role)` (ADR-031).

### Frontend
- New `/history` — list of today's paid sales (staff) or any picked WIB day (manager-only date picker). Each row shows time, total, payment instrument, refund-status badge.
- New `/history/:txnId` — transaction detail with snapshot lines, totals, payment method, refund badge, "Bagikan struk" button (mints + opens `/r/<token>` in a new tab).
- New `/mgr/dashboard` — seven cards: Totals, PaymentMix, NeedsAttention, TopSkus, HourlyCurve (pure-CSS bar row — no chart lib), VoucherUsage, PerStaff. Manager-only; staff session sees a "Hanya manajer" gate card. Laptop-first `lg:grid-cols-3`; single-column on phone.

### Backend
- New `transactions/lib.ts` pure aggregators: `computeDaySummary(DayTxn[]) → DaySummary` + supporting types (`DayLine`, `Instrument`, `DayTxn`).
- New deep `transactions` query surface: `listDayTransactions`, `dashboardSummary`, `getTransactionDetail`, `shareReceipt`. One internal day-window fetch (`_fetchDayWindow_internal`) feeds all three queries.
- New cross-module helpers per ADR-034: `auth._listStaffNames_internal`, `auth._resolveSessionRole_internal`, `payments._instrumentForTxn_internal`.
- New shared helper `refunds.refundStatus(lines, hasRefunds) → "none"|"partial"|"full"` (extracted from the receipt template; now consumed by both the receipt template and the FE history badge — single derivation).
- Staff `getTransactionDetail` for prior-day txns returns `null` (FE renders "tidak ditemukan") rather than throwing — graceful UI degrade matches the existing not-found path.
- `WIB_OFFSET_MS` now exported from `convex/lib/time.ts` so reporting aggregators can compute WIB hours without re-deriving the offset.

### Tests
- 7 new vitest suites (refund-status, day-summary, resolve-session-role, list-staff-names, instrument-for-txn, history-queries, share-receipt) + 3 new FE component tests. Backend suite: 514 tests across 86 files green.

### ADRs
- None new — slice is a pure function over already-shipped tables/indexes (`by_status_created`, `by_transaction`, `by_receipt_token`). No schema or audit-enum additions.

### Deploy notes
- Read-mostly + zero schema change. Backend before frontend (`npx convex deploy` first, then Vercel) so the FE's new queries find their backend handler. `shareReceipt` only mints a token on a paid txn lacking one — forward-compatible and idempotent at two layers (cache + mint check).

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
