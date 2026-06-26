# flow-log — BLOCKER re-check (override → manager re-login keypad)

Run-id: `two-level-booth-state-2026-06-26-blocker-recheck`
Viewport: mobile (Pixel 7). Single navigation pass, driven via Playwright (`_blocker-recheck.mjs`, since removed).
Backend re-seeded at start for deterministic state (booth closed, no holder).

Verdict: **PASS** — keypad responsive after override; Lucas reaches /shift/begin.
Console errors: 0. Network ≥400: 0.

---

## Step 01 — Crew Bayu login → start-of-day SOP
- **Action:** goto `/`; tap Bayu; PIN 0000; walk the open-booth SOP wizard (count Dubai=100, advance instruction steps, "Start of day").
- **Expected:** Booth closed → `/shift/start`; openBooth on terminal step → home; Bayu becomes shift holder, booth open.
- **Observed:** Reached `/shift/start` count wizard; completed SOP; landed on home `Frollie · Bayu`. Booth open, holder=Bayu.
- **Screenshot:** `screens/01-shift-start-count.png`, `screens/02-bayu-home-booth-open.png`
- **Console:** clean. **Network:** clean. **Load:** normal. **State:** outlet open; holder=Bayu.

## Step 02 — Lock / logout
- **Action:** Tap Lock (app-bar) → `/lock`; tap "Lock".
- **Expected:** Session ends, return to `/login`; booth stays OPEN, holder unchanged (Bayu).
- **Observed:** Returned to `/login`. (Last-staff key cleared + reload to model a different person walking up → roster list shown.)
- **Screenshot:** `screens/03-login-roster.png`
- **Console:** clean. **Network:** clean. **State:** outlet open; holder=Bayu (unchanged by lock — ADR-053 plain logout).

## Step 03 — Tap Lucas (different person) → BLOCK
- **Action:** On roster, tap Lucas (manager ≠ holder Bayu).
- **Expected:** Block screen "Bayu is still on shift…" + "Manager override" button.
- **Observed:** Block screen rendered with shift-held message + Manager override + back.
- **Screenshot:** `screens/04-blocked-screen.png`
- **Console:** clean. **Network:** clean. **State:** entry blocked (holder mismatch).

## Step 04 — Manager override → Lucas → PIN 9999
- **Action:** Tap "Manager override" → PinSheet opens → pick Lucas → enter PIN 9999 (auto-submits on 4th digit).
- **Expected:** `managerOverride` force-ends Bayu's stranded shift; override PinSheet closes; roster ("Who's working?") returns; holderStaffId → null.
- **Observed:** Override succeeded; sheet closed; roster returned.
- **Smoking gun:** after the override Radix Dialog closed, `document.body` pointer-events = inline `""` / computed `"auto"` — **NOT** the stuck `none` that caused the original BLOCKER.
- **Screenshot:** `screens/05-override-pin-sheet.png`, `screens/06-roster-after-override.png`
- **Console:** clean. **Network:** clean. **State:** outlet open; holder=null.

## Step 05 — CRITICAL: tap Lucas → keypad responsive → /shift/begin
- **Action:** Tap Lucas → PIN keypad. Tap 9, 9, 9 (read dots), then 9 (submit).
- **Expected:** Each tap FILLS a PIN dot (keypad live, not dead); login proceeds; Lucas lands on `/shift/begin` (incoming count).
- **Observed:** After 3 taps, **3 of 4 PIN dots filled** (DOM `bg-foreground` count = 3) — keypad responsive. 4th digit submitted; navigated to `/shift/begin` "Begin shift / Count stock" with the SKU list (Dubai System: 100 carried from Bayu's open count).
- **Screenshot:** `screens/07-keypad-mid-entry-dots.png` (heading "Lucas", 3 dots filled), `screens/08-lucas-shift-begin.png`
- **Console:** clean. **Network:** clean. **State:** Lucas authenticated; booth open, no prior holder → incoming-count wizard.

---

## Result
The previously-BLOCKER repro is **FIXED**. The override PinSheet no longer leaves
`body{pointer-events:none}` stuck — the manager re-login keypad is fully responsive, dots fill,
and Lucas reaches `/shift/begin`. Zero console errors, zero non-2xx responses across the pass.
