# Roadmap

Forward-looking plan for Frollie POS. **This file holds what is NOT yet shipped** — specs and plans are documented here as we brainstorm them. Once a slice ships, its record moves to [`CHANGELOG.md`](./CHANGELOG.md) (dated + versioned) and is removed from here.

> **Two-doc system** (replaces the retired `docs/PROGRESS.md` task board, 2026-06-25):
> - **ROADMAP.md (this file)** — specs + plans, brainstormed but unbuilt. The forward queue.
> - **[CHANGELOG.md](./CHANGELOG.md)** — shipped implementation, with dates + versions. The source of truth for what exists.

## Versioning

Versions increment naturally from the work that ships:

- **Major feature → bump the minor:** `x.1 → x.2` (e.g. `1.2 → 1.3`). A new user-facing capability / phase.
- **Sub-feature or fix → bump the patch:** `x.x.1 → x.x.2` (e.g. `1.3.1 → 1.3.2`). A slice, hotfix, or hardening pass within a feature.

The CHANGELOG entry at ship time sets the version; the roadmap entry names the target version before it ships.

---

## v1.3.0 multi-outlet tenancy + owner cockpit — **SHIPPED** (see [CHANGELOG 2026-06-22 … 2026-06-26](./CHANGELOG.md))

All four Specs (data plane, owner auth, cockpit UI + queries, Telegram per-outlet routing) have shipped. The spec reference is [owner cockpit design](./superpowers/specs/2026-06-21-owner-cockpit-design.md).

---

## v1.4.9 — QRIS paid-callback forwarder (POS → Recipe Master) — **PLAN**

> Patch bump — integration/hardening slice within payments. Version set at ship.

The shared Xendit account delivers every QR-paid event to THIS POS's account-level webhook; Recipe Master (Frollie Pro) QR orders therefore never auto-reconcile (per-QR `callback_url` proven ignored by Xendit v2, order `0716-001`). This slice adds a durable transactional-outbox forwarder in `payments/webhook.ts` that relays genuine QR-payment callbacks to the RM endpoint — refund-gated, `kind`-annotated (POS paid path byte-identical), dedup + retry/backoff, 401-terminal, second-secret authed, kill-switch. Two staffreview gates passed; RM side already shipped (`product_master` Phase 1).

- **Spec:** [`superpowers/specs/2026-07-16-qris-pos-rm-forwarder.md`](./superpowers/specs/2026-07-16-qris-pos-rm-forwarder.md)
- **Plan:** [`superpowers/plans/2026-07-16-qris-pos-rm-forwarder.md`](./superpowers/plans/2026-07-16-qris-pos-rm-forwarder.md)
- **Handoff:** `.claude/handoff/execute_2026-07-16-qris-pos-rm-forwarder.md`

---

## v1.3.2 — full-route empty / loading / error sweep (post-launch hardening) — **SPEC**

> Version named ahead; set at ship. Hardening pass within v1.3.x, so a patch bump.

### Context

Launch hardening built the happy path. Several operational routes have no defined **empty**, **loading**, or **error** state — they render blank, flash, or throw into the route boundary when a query is `undefined`, a list is empty, or the network is offline. The booth runs on one Android device with intermittent mall Wi-Fi, so a blank `mgr/*` screen during a reconnect reads as "the app is broken" to a non-technical operator. This is the deferred "full-route empty/error pass" from the backlog, scoped as a repeatable sweep rather than a one-off so new routes inherit the bar.

### Current state (verified 2026-06-28)

- `src/components/layout/RouteErrorBoundary.tsx` exists (ADR-045) and catches **thrown** errors + chunk-reload failures. It does **not** cover the three non-throwing gaps: a query returning `undefined` (loading), a query returning `[]` (empty), or a Convex call rejecting inside a handler (caught, no UI).
- Grep for loading/skeleton/empty affordances across `src/routes` returns only `mgr/dashboard.tsx` and `mgr/telegram-chats.tsx`. Every other operational route is unaudited.
- Routes in scope (the operational surface a manager/staff hits, excluding the already-polished `sale/*` and `cockpit/*` planes): `mgr/audit`, `mgr/dashboard`, `mgr/device-setup`, `mgr/device`, `mgr/home`, `mgr/products`, `mgr/receipt`, `mgr/refunds-pending`, `mgr/spoilage`, `mgr/staff`, `mgr/stock`, `mgr/telegram-chats`, `mgr/vouchers`, `settlements`, `account`, `approve/index`, `history/index`, `history/$txnId`, `refund/index`, `refund/detail`, `stock/index`, `stock/$skuId`. **22 routes.**

### Proposed change

1. **Audit matrix.** Produce a route × state matrix (`{loading, empty, error, offline}`) — one row per route, current handling vs gap. This is the deliverable that makes "done" measurable and is the reusable artifact (re-run the same matrix when routes are added).
2. **Fill the gaps.** For each gap: loading → skeleton/spinner consistent with `mgr/dashboard`; empty → a `FieldMessage`/empty-state card (ADR-048 semantic tokens, EN/ID per ADR-049); error → inline retry affordance, not a silent catch; offline → reuse the `navigator.onLine` gate pattern already in `RouteErrorBoundary` for payment/auth-blocking routes (ADR-016/ADR-025 — offline blocks payments/auth/refunds with clear UI).
3. **Lock the bar.** Add a lightweight reusable empty/loading primitive (or reuse an existing one) so future routes don't re-solve this. Document the convention in `docs/PATTERNS/`.

### Acceptance criteria

1. The audit matrix exists in the PR (all 22 routes, 4 states each = 88 cells, every cell either ✅ pre-existing or 🔧 fixed-here, none blank).
2. Every in-scope route renders a non-blank, locale-correct (EN/ID) state for: query `undefined` (loading), query `[]`/no-rows (empty), and a rejected mutation/query (error with retry or clear message).
3. Offline-sensitive routes (payments/auth/refunds-adjacent) show the documented offline block, not a blank or a throw.
4. A reusable empty/loading primitive is used by ≥3 of the converted routes and documented in `docs/PATTERNS/`.
5. No regression: `npm run typecheck` + `npm run lint` + vitest green; no change to happy-path render of any route (snapshot/interaction tests still pass).

### Testing plan

| Layer | What | Count |
|---|---|---|
| Unit/component | Per-route render under `undefined` / `[]` / rejected-query props | +~20 |
| Integration | Offline-gate render for payment/auth/refund-adjacent routes | +3 |

### Files reference (representative — full set from the matrix)

| File | Change |
|---|---|
| `src/routes/mgr/*.tsx` (13 files) | Add loading/empty/error states per matrix |
| `src/routes/settlements.tsx`, `account.tsx`, `approve/index.tsx` | Same |
| `src/routes/history/*`, `refund/*`, `stock/*` | Same |
| `src/components/ui/` (new) | Reusable empty/loading primitive |
| `docs/PATTERNS/route-states.md` (new) | Convention doc |

### Out of scope

- `sale/*` and `cockpit/*` (already hardened / persona-UAT'd).
- Real-device Android e2e (separate backlog item).
- Redesigning any happy-path layout — states only.

### Effort

~1 audit pass (matrix) + ~13 route edits + 1 primitive + tests. Sweep-shaped: mechanical per route once the matrix and primitive exist.

---

## v1.5.0 — peer takeover of a locked booth — **PLANNED**

> New user-facing capability (staff can self-serve a takeover) → minor bump. Version named ahead; set at ship.

**Spec:** [`superpowers/specs/2026-07-08-peer-takeover-locked-booth-design.md`](./superpowers/specs/2026-07-08-peer-takeover-locked-booth-design.md) · **Plan:** [`superpowers/plans/2026-07-08-peer-takeover-locked-booth.md`](./superpowers/plans/2026-07-08-peer-takeover-locked-booth.md) · reviews in [`reviews/`](./reviews/) (spec + plan staffreviews). Amends rule #23 / ADR-053. Related: issue #158, v1.4.7 (self-handover).

**What it delivers.** A booth left **LOCKED** by one holder (holder row with no live *booth* session) can be taken over by any other staffer using their **own PIN** — no manager override. An **actively-working** holder (live booth session) is unchanged: peer is blocked → manager override, so a live shift can't be hijacked. The displaced holder's shift ends `ended_via="peer_takeover"` (uncounted) and they still receive their Telegram signoff summary. Removes the every-morning manager-approval friction (3 mornings running in Block M).

**Shape.** New auth-owned `_hasActiveBoothSession_internal` (booth-only liveness, excludes cockpit sessions per ADR-052) → `loginContext.holderLocked` → login routes locked-holder to PIN/takeover instead of block; `RootLayout` forces the count wizard for the takeover case; new single-writer atomic `takeOverLockedBooth` mutation (ends locked holder + mints incoming in one transaction, server-side hijack guard). Additive schema (`peer_takeover` literal), deploy-skew-safe both ways. 8 tasks, 3 waves (backend → frontend → docs). Both pipeline gates passed.

---

## Backlog (unscheduled)

- **Owner cockpit polish** — outlet-list/skeleton motion-safe pulse; `listOutlets` returns active-only (add `_listAllOutlets_internal` so the outlet-list inactive badge + wizard dup-code pre-warn cover deactivated outlets once a deactivation flow exists); wire or drop the `provision_managers_chat` toggle (deferred cockpit Minors). **From persona-UAT (dev + prod read-only, 2026-06-26 — 0 blocker / 0 bug; the actionable correctness/UX cluster already shipped in PR #146):** translate or drop the "Cockpit" eyebrow word under both locales (ID currently shows "PEMILIK · COCKPIT"); replace the free-text timezone field with an IANA-zone dropdown (inline validation already prevents bad data); staff-access selector affordance clarity (it's a square multi-select checkbox — add "(choose one or more)" + a selected-count on Review); desktop dashboard max-width container + responsive outlet-card grid; PKW code-badge contrast on the amber card; EN/ID toggle shape consistency; switcher dropdown overlapping "Sign out"; step-1 selected-mode checkmark; "Net = Gross when no refunds" hint. **Needs a dev run:** cockpit offline + loading/skeleton states (C10) and live cross-plane `NOT_BOOTH_SESSION` rejection (cockpit↔booth — covered by convex-tests, not exercised live).
- **Outlet deactivation/archive flow** — there is currently NO delete- or deactivate-outlet path, so a mistaken/test outlet created via the cockpit wizard is permanent (blocks safe clone-create UAT on prod). Add an owner-gated `deactivateOutlet` (sets `active: false`, excluded from active feeds/switcher/owners-cron) + the `_listAllOutlets_internal` above for the inactive badge.
- **Post-launch hardening (residual)** — real-device e2e on the booth Android; settlement auto-poll live-verification (now unblocked — QRIS charging has been live since the 2026-06-03 cutover; KYB clearing only gates the settlement-reconciliation poll, [#66](https://github.com/lucasyhzhu-debug/frolliePOS/issues/66)); spare-device protocol (single-device SPOF). *(Full-route empty/error sweep → specced as v1.3.2 above; PWA A2HS install prompt → specced as v1.4.0 above.)*

> **ADR index housekeeping — DONE 2026-06-28.** The ADR README index now lists 041–054. A numbering collision (two files claimed `053`) was resolved by renumbering the deferred SaaS ADR to **054** and sweeping all cross-references; "ADR-053" now unambiguously means the two-level booth state ADR.

---

## Decisions awaiting CTO

- **Cross-deployment integration with Frollie Pro `product_master`** — sync, API call, or shared package? Gates FPro-driven stock-in/out (now deprioritized — see Deferred). Decision deferred along with the feature; no longer blocking active work.

---

## Risks under watch

- **Single device, single point of failure** — booth Android dies mid-shift = no sales. Offline draft queue helps but does not replace; spare-device protocol needed.
- **Telegram bot single point of failure** — all internal comms route through one bot. Failure modes: token revoked, bot removed from a group, Telegram outage, basic→supergroup `chat_id` migration. Mitigations shipped (secret-token + idempotency); still want delivery-failure alerts (nightly `telegram_log` non-`ok` OUT scan); token-rotation runbook in [RUNBOOK-telegram.md](./RUNBOOK-telegram.md).
- **PWA install conversion** — staff must add to home screen for reliable offline launch.
- **Negative-stock discipline** — sales allowed at zero stock with a flag (ADR-018); requires managers actually reconciling or counts drift.

---

## Deferred (not scheduled)

- **FPro-driven stock-in/out (deprioritized 2026-06-28)** — stock-in/out driven by Frollie Pro recipes/inventory once the cross-deployment integration pattern lands (ADR to be drafted). FPro caller currently stubbed; negative-stock (ADR-018) reconciliation manager view rides along. **Why deprioritized:** the POS runs its own data plane ([ADR-034](./ADR/034-deep-modules-surface-apis.md)) and is self-sufficient for inventory today — staff stock-in works standalone. FPro integration is a "nice-to-have convergence," not a booth-blocking gap, and it is gated on the unresolved cross-deployment-integration decision (above). Booth hardening (route sweep, A2HS, real-device e2e, spare-device) and any in-flight booth features take priority. **Pick up when:** the cross-deployment pattern is decided AND a concrete FPro-side consumer/producer need exists.

### Future multi-business roadmap

Selling the POS to other businesses: SaaS control plane (`frollie-platform`), businesses / billing / deployments registry, per-tenant provisioning (needs a programmatic-Convex-project + deploy-key spike first). Design retained in [ADR-054](./ADR/054-saas-control-plane-provisioning.md) + the [SaaS control-plane spec](./superpowers/specs/2026-06-21-saas-control-plane-design.md). Pick up only when multi-business is explicitly greenlit.
