# UAT context — focused BLOCKER re-check

- **Run-id:** two-level-booth-state-2026-06-26-blocker-recheck
- **Type:** Focused fix-verification (single repro, no persona dispatch)
- **App URL:** http://localhost:5173 (mobile viewport — Pixel 7)
- **Backend:** dev `helpful-grasshopper-46` (freshly re-seeded; script re-seeds at start for determinism)
- **Login creds:** Manager "Lucas" (S-0001) PIN 9999; Crew Bayu/Citra/Dewi/Eka PIN 0000
- **Dev device:** `dev-booth-device` pre-registered (skips /activate)
- **Timestamp (dispatcher):** 2026-06-26

## The bug being re-tested (was BLOCKER)
After a manager override clears the login block, the manager's re-login PIN keypad was DEAD —
tapping digits did not fill the 4 PIN dots / no advance. Root cause: Radix Dialog left
`body{pointer-events:none}` stuck after the override PinSheet closed. The fix restores body
pointer-events when the PinSheet closes.

## Scope checklist (single pass)
- [ ] Crew Bayu login → start-of-day SOP (openBooth) → sale grid (Bayu = holder, booth open)
- [ ] Lock/logout → /login (booth stays open, holder=Bayu)
- [ ] Tap Lucas (different person) → BLOCK screen + "Manager override"
- [ ] Manager override → pick Lucas → PIN 9999 → block clears, roster returns
- [ ] CRITICAL: tap Lucas → keypad responsive, dots fill 9-9-9-9, lands on /shift/begin
