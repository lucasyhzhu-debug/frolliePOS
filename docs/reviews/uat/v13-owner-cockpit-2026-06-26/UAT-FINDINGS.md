# Persona-UAT — v1.3.0 Owner Cockpit (Spec 3)

**Run date:** 2026-06-26
**Branch:** v13-owner-cockpit
**Status:** ⏸️ **PENDING — needs live env (owner-run before merge). NOT a pass.**

## Why pending (not run headless)

The in-scope surfaces — cockpit dashboard landing (consolidated + per-outlet), outlet
switcher, outlet list, and the new-outlet wizard (blank/clone) — are ALL gated behind a
`kind:"cockpit"` owner session. A cockpit session is minted only by the Telegram-OTP verify
path (`convex/auth/ownerInternal.ts:359`); the `vite dev` seed mints a **booth** session, not
a cockpit one. The realistic owner login requires a 6-digit OTP delivered to the owner's
**private Telegram DM** (ADR-052), which cannot be intercepted in a headless agent context.

Driving the cockpit with a hand-injected synthetic session would (a) bypass the real OTP login
path and (b) require standing up the worktree's own dev stack (the running :5173 server is the
primary checkout, not this worktree's new cockpit FE). That is partial fidelity, so per the
execution handoff this step is flagged **pending: needs live env** rather than claimed passed.

## What the owner must run before merge (live env)

1. `npx convex dev` (deployment `helpful-grasshopper-46`) + `npm run dev` **from this worktree**,
   `npx convex run seed/actions:reset`.
2. Promote an owner (`setStaffRole` → "owner", manager-PIN), set `staff.telegram_user_id`, bind
   the owner's Telegram DM (`/start <token>`), set `TELEGRAM_BOT_USERNAME` on the deployment.
3. OTP-login at `/cockpit/login` (real Telegram DM).
4. Persona-UAT the amber cockpit plane: dashboard headline + per-outlet cards; outlet switcher
   scoping the per-outlet section; outlet list; new-outlet **clone** (verify the 2nd outlet
   appears with copied catalog + empty stock) and **blank** wizard; code-uniqueness inline error.
5. Triage: fix BLOCKER/BUG before merge; route UX-HIGH/UX-NIT to `docs/ROADMAP.md`.

## Automated coverage already green (compensating evidence)

- Backend: 38 cockpit convex-tests (createOutlet idempotency replay, `:commit` crash-window
  idempotency, atomic clone rollback, stock-NOT-cloned, FK remap, booth-session rejection,
  dashboard cross-outlet aggregation).
- Frontend: RTL component tests for OutletContext (default/persist/stale-id fallback), dashboard
  landing (headline + per-outlet + switcher filter + loading/empty), outlet list, and the wizard
  (blank/clone fork, dup-code gate, create→navigate, idempotency-key rotation).
- `npm run typecheck` CLEAN · full suite 1574/1574 green · lint 0 errors.

## Also still pending (per handoff, owner-run)

- **Live owner smoke** — promote owner, bind Telegram DM, OTP-login, clone the default outlet,
  verify the new outlet has copied catalog + empty stock.
- **Visual / UX sign-off** of the switcher / dashboard / wizard (human gate).
