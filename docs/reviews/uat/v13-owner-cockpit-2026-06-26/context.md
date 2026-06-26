# UAT Context — v13 Owner Cockpit

- **Run-id:** `v13-owner-cockpit-2026-06-26`
- **Date:** 2026-06-26
- **Feature:** Owner cockpit (v1.3.0, Spec 3) — the amber `.theme-owner` owner plane at `/cockpit/*`
- **App URL:** http://localhost:5174 (worktree dev for branch `v13-owner-cockpit`)
- **Backend:** Convex dev `helpful-grasshopper-46` (`npx convex dev`), Vite `npm run dev`
- **Role / auth plane:** Owner cockpit session (`kind:"cockpit"`, Telegram-OTP plane, ADR-052). Owner staff = **Lucas** (S-0005, role `owner`).
- **Driver:** Playwright (chromium), standalone throwaway script. Mobile primary viewport = Pixel 7 (412×915); desktop spot-check = 1280×900.

## Fidelity caveat (IMPORTANT)
The cockpit is normally gated behind a real Telegram-OTP login. For this UAT a **fixture cockpit session was pre-minted (Path B — no real OTP)** and injected via `localStorage["frollie-session-id"] = "kd72mzwd…czej"` on the app origin, then `/cockpit` was loaded. The gate validated `kind:"cockpit"` + not-ended + idle-timeout and admitted the session. **The OTP request → DM-delivery → verify → bind flow was NOT exercised** — that auth path is out of this run's evidence and must be smoke-tested separately.

## Seed summary
- Single seeded default outlet: **Frollie — Pakuwon** (code `PKW`), zero sales today (GROSS Rp 0, 0 txns, Rp 0 refunds).
- Staff: Bayu (S-0001), Citra (S-0002), Dewi (S-0003), Eka (S-0004) = role `staff`; Lucas (S-0005) = role `owner`.
- During the pass the wizard CREATED two real outlets (idempotent `createOutlet` action): **Frollie — Grand Indonesia** (`GI`, blank mode) and **Frollie — Kelapa Gading (clone)** (`KG`, clone of PKW). A throwaway third (`RVW`) was created only to re-capture the blank Review screen accurately. These persist in the shared dev deployment.

## Scope checklist (all exercised in one pass)
1. [x] Cockpit dashboard landing — consolidated headline + per-outlet cards
2. [x] Header outlet switcher — default "All outlets", scope to one outlet, scope back
3. [x] Outlet list (`/cockpit/outlets`) — rows + New outlet CTA
4. [x] New-outlet wizard BLANK — all 8 steps, duplicate-code inline FieldMessage, fix, create
5. [x] New-outlet wizard CLONE — source select, clone note, create
6. [~] Loading / empty / error states — partial (see flow-log; data resolved fast, no error surface triggered, list never empty)
7. [x] Amber `.theme-owner` plane — confirmed bg `rgb(35,25,5)` = #231905, gold accents

## Not exercised (coverage gaps — declared, not hidden)
- Real Telegram-OTP login (fixture session used).
- Non-zero money rendering / large-number overflow (seed has zero sales everywhere).
- Sustained loading skeletons (Convex resolved snappily).
- Wizard create-failure error toast path (no failures occurred).
- Offline behaviour of the cockpit plane (ADR-025 / contract C10).
- Dashboard empty-outlets state + outlet-list empty state (always ≥1 outlet).

## Capture stats
- Console errors/warnings captured: **0** (see `console-errors.log`)
- Non-2xx / failed network requests: **0** (see `network-failures.log`)
- Screenshots: `screens/01-…` through `screens/22-…`
