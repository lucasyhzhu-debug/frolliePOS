# UAT context — two-level booth state (ADR-053)

- **Run-id:** two-level-booth-state-2026-06-26
- **Date:** 2026-06-26
- **App URL:** http://localhost:5173 (Vite dev) · Convex dev deployment `helpful-grasshopper-46`
- **Viewport:** Pixel 7 mobile (412×915), `isMobile`+`hasTouch` — single-Android-device booth PWA (primary target)
- **Driver:** Playwright (`@playwright/test` chromium), headless, scripted single pass + two supplemental continuations (see caveat)
- **Seed:** `npx convex run seed/actions:reset` — pre-registers `dev-booth-device` (loads skip `/activate`), seeds staff + catalog, booth starts CLOSED (`outlets.is_open` unset).

## Roles / credentials used
- **Lucas** (S-0001), manager, PIN **9999**. NOTE: the `reset` seed path does **not** set `must_change_pin` (only `bootstrap` does), so **no forced PIN rotation appeared** — Lucas logged straight in with 9999 (expected, documented as a flow observation, not a defect).
- **Bayu**, crew (staff), PIN **0000** — used as the second holder for handover + block.

## Feature under test — two stored levels (ADR-053, supersedes ADR-050)
- **Level 1** `outlets.is_open` — SOP gate. Set by `openBooth`/`managerSkipOpen`; cleared by `endOfDay`.
- **Level 2** single `pos_shifts` holder row (`ended_at==null` = active holder). `startShift` creates; `handover`/`endOfDay` ends; `managerOverride` force-ends a stranded holder.
- Login reads `loginContext`: closed→`/shift/start`; open+no-holder→`/shift/begin`; open+holder==me→resume `/`; open+holder!=me→BLOCK + Manager override.
- Goal: eliminate the recurring "BOOTH_NOT_OPEN on a locked booth" incident — so **lock→relogin→resume** and **handover** are the heart of the test.

## Scope checklist (dispatcher)
1. [x] Login Lucas → SOP `/shift/start` → walk openBooth checklist + count → sale grid; booth now open — **Steps 1–5**
2. [x] Sale: products → cart → charge → QRIS sim-pay → paid receipt ("Payment confirmed") — **Steps 6–9**
3. [x] Lock → returns to `/login` WITHOUT closing booth — **Steps 10–11**
4. [x] Re-login same staff (Lucas) → RESUME straight to sale grid, NO SOP, NO BOOTH_NOT_OPEN — **Step 12** (core incident fix; reproduced 3×)
5. [x] Handover → ends Lucas, `/login` booth still open → login Bayu → `/shift/begin` count → startShift → sale grid — **Steps 13–16**
6. [x] Block (tap different staffer than holder) names holder + Manager override; exercise override → block clears — **Steps 17–18**; override→re-login friction — **Step 19** (see caveat)
7. [x] End-of-day close → booth CLOSES; next login routes back to SOP — **Steps 36–39** (Step 39 confirms Level-1 close)
8. [x] Bilingual EN↔ID toggle; shift/login copy translated both ways — **Steps 29–32**
9. [x] Watch for BOOTH_NOT_OPEN / stuck-locked dead-ends, login-block race, unclear money, jargon, missing feedback, console/network errors, untranslated strings — captured throughout; offline C10 — **Steps 34–35**

## Navigation caveat (honesty note)
The pass was driven ONCE through the core feature (Steps 1–19), reproduced consistently across 3 full runs. After the manager override (Step 18 cleared the block successfully every time), the **overriding manager's immediate re-login stalled on an empty PIN keypad (Step 19, reproduced 3×)** — characterised as a real anomaly below. Because that stall truncated the tail, the remaining in-scope flows (bilingual Steps 29–32, offline + end-of-day Steps 34–39) were captured in two short **supplemental continuations from a fresh seed** to avoid the override entanglement. No flow was judged twice; the continuations only complete coverage the override-stall cut off. All screenshots are real, captured live.

## Evidence pack
- `flow-log.md` — ordered per-step evidence (Steps 1–19 core; 29–39 supplemental tail).
- `screens/` — 31 screenshots, `NN-<slug>.png`.
- `console-errors.log` — browser console errors/warnings (Radix Dialog `aria-describedby` warnings; offline WebSocket-disconnect errors during the offline test).
- `network-failures.log` — none (no non-2xx app requests captured).

## Headline observations for the evaluators
- **RESUME after lock works** (Step 12): re-login same staff → sale grid, zero BOOTH_NOT_OPEN. The incident this rework targets did not reproduce.
- **Lock auto-pre-stages** the last staffer straight to the PIN keypad (Step 11) — fast resume.
- **Block names the holder** correctly: "Bayu is still on shift. Ask a manager to override, or wait for handover." (Step 17).
- **Stock math correct across shifts**: SOP count 100 − 2 sold = 98 shown at handover count (Step 13/14 screenshot).
- **Bilingual works** (Step 30): EN→ID flips home to "Penjualan baru", "Tutup booth", "Serah terima"; lock heading "Akhiri shift Lucas?" (Step 31). No raw i18n keys observed.
- **End-of-day closes the booth** (Step 39): after close, next login routes back to `/shift/start` SOP — Level-1 close confirmed.
- **Offline**: catalog + cart usable offline (Step 34, cart subtotal Rp 45.000 rendered) but the connection chip still showed green **"live"** while offline and the **Charge** button stayed enabled then silently no-op'd (Step 35/38) — flagged for the evaluators against C10 "never a silent failure".
- **Anomaly — override→re-login stall** (Step 19): after a successful manager override on the login screen cleared the block (Step 18, roster returned), the overriding manager's immediate PIN entry left the keypad with empty dots and no visible error; the staffer did not advance. Reproduced 3×. Suspected reactive `loginContext` stale-holder re-check race vs. the just-force-ended holder, but inconclusive without instrumentation. Evaluators should weigh this against C9 "a returning staffer can resume without getting stranded".
