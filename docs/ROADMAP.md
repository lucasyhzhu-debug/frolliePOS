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

## Backlog (unscheduled)

- **Owner cockpit polish** — timezone IANA validation in the new-outlet wizard; outlet-list/skeleton motion-safe pulse (deferred cockpit Minors).
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
