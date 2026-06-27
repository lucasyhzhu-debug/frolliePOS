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

## Next — v1.3.1 off-booth manager override (planned, ready to execute)

Spec + plan landed (2026-06-27), both staffreviewed. A blocked/stranded booth can request a **manager
override via Telegram**; the manager approves remotely with their staff code + PIN and chooses to
**close** the booth or **release** it open. New `shift_override` approval kind reusing the off-booth
approval envelope; booth-inline override retained (now also offers close/release). Motivated by the
2026-06-27 prod incident (booth left open + held, blocking the next staffer; resolved by a manual prod
write). Spec: [off-booth manager override](./superpowers/specs/2026-06-27-off-booth-manager-override-design.md) ·
Plan: [2026-06-27-off-booth-manager-override](./superpowers/plans/2026-06-27-off-booth-manager-override.md).

---

## Backlog (unscheduled)

- **Owner cockpit polish** — outlet-list/skeleton motion-safe pulse; `listOutlets` returns active-only (add `_listAllOutlets_internal` so the outlet-list inactive badge + wizard dup-code pre-warn cover deactivated outlets once a deactivation flow exists); wire or drop the `provision_managers_chat` toggle (deferred cockpit Minors). **From persona-UAT (dev + prod read-only, 2026-06-26 — 0 blocker / 0 bug; the actionable correctness/UX cluster already shipped in PR #146):** translate or drop the "Cockpit" eyebrow word under both locales (ID currently shows "PEMILIK · COCKPIT"); replace the free-text timezone field with an IANA-zone dropdown (inline validation already prevents bad data); staff-access selector affordance clarity (it's a square multi-select checkbox — add "(choose one or more)" + a selected-count on Review); desktop dashboard max-width container + responsive outlet-card grid; PKW code-badge contrast on the amber card; EN/ID toggle shape consistency; switcher dropdown overlapping "Sign out"; step-1 selected-mode checkmark; "Net = Gross when no refunds" hint. **Needs a dev run:** cockpit offline + loading/skeleton states (C10) and live cross-plane `NOT_BOOTH_SESSION` rejection (cockpit↔booth — covered by convex-tests, not exercised live).
- **Outlet deactivation/archive flow** — there is currently NO delete- or deactivate-outlet path, so a mistaken/test outlet created via the cockpit wizard is permanent (blocks safe clone-create UAT on prod). Add an owner-gated `deactivateOutlet` (sets `active: false`, excluded from active feeds/switcher/owners-cron) + the `_listAllOutlets_internal` above for the inactive badge.
- **ADR index housekeeping** — land ADR-051 / ADR-052 + the 4 multi-outlet specs into the ADR README index (not yet listed there).
- **FPro-driven stock-in/out** — stock-in/out driven by Frollie Pro recipes/inventory once the cross-deployment integration pattern lands (ADR to be drafted). FPro caller currently stubbed. Negative-stock (ADR-018) reconciliation manager view rides along.
- **Post-launch hardening** — full-route empty/error pass (`mgr/*`, settlements, account, approve); real-device e2e on the booth Android; settlement auto-poll live-verification once Xendit KYB clears ([#66](https://github.com/lucasyhzhu-debug/frolliePOS/issues/66)); spare-device protocol (single-device SPOF); PWA A2HS install-prompt polish.

---

## Decisions awaiting CTO

- **Cross-deployment integration with Frollie Pro `product_master`** — sync, API call, or shared package? Gates FPro-driven stock-in/out and any v1.1+ read of Pro's `products` table.

---

## Risks under watch

- **Single device, single point of failure** — booth Android dies mid-shift = no sales. Offline draft queue helps but does not replace; spare-device protocol needed.
- **Telegram bot single point of failure** — all internal comms route through one bot. Failure modes: token revoked, bot removed from a group, Telegram outage, basic→supergroup `chat_id` migration. Mitigations shipped (secret-token + idempotency); still want delivery-failure alerts (nightly `telegram_log` non-`ok` OUT scan); token-rotation runbook in [RUNBOOK-telegram.md](./RUNBOOK-telegram.md).
- **PWA install conversion** — staff must add to home screen for reliable offline launch.
- **Negative-stock discipline** — sales allowed at zero stock with a flag (ADR-018); requires managers actually reconciling or counts drift.

---

## Deferred — future multi-business roadmap (not scheduled)

Selling the POS to other businesses: SaaS control plane (`frollie-platform`), businesses / billing / deployments registry, per-tenant provisioning (needs a programmatic-Convex-project + deploy-key spike first). Design retained in [ADR-053](./ADR/053-saas-control-plane-provisioning.md) + the [SaaS control-plane spec](./superpowers/specs/2026-06-21-saas-control-plane-design.md). Pick up only when multi-business is explicitly greenlit.
