# Phase 0 — Modal off-screen on tablet Chrome (BUG, BLOCKER)

**Date:** 2026-06-18
**Item:** #8 from the v1.2 backlog roadmap (`docs/superpowers/specs/2026-06-18-pos-backlog-roadmap-design.md`).
**Effort:** S · **Deps:** none · **ADR:** none.
**Status:** Spec — feeds a lean plan + single PR (Phase 0 of v1.2).

## Problem (grounded in code)

`DialogContent` in `src/components/ui/dialog.tsx:32-37` renders as:

```
fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg
translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 …
```

It is a `position: fixed` box centered via `translate(-50%,-50%)` with **no `max-height` and no `overflow`**. When the content is taller than the viewport, it overflows symmetrically: the top (header/title) clips above the screen and the bottom (footer/Cancel) clips below — both become unreachable.

**Tallest offenders, all routed through this one primitive:**
- `PinSheet` (`src/components/pos/PinSheet.tsx`) — title + label + 4-dot row + optional `extraField` + error/pending + full `NumericKeypad` + footer ≈ 480–560px. This is the **booth refund-approval PIN** the user saw off-screen (rendered at `src/routes/refund/detail.tsx`; the off-booth `/approve` route is a full page and is unaffected).
- `PrinterSheet` (`src/components/pos/PrinterSheet.tsx`).
- `AbandonCartDialog` + the mgr admin dialogs (`mgr/products`, `mgr/staff`, `mgr/vouchers`, `settlements`).

On a ~720px-tall tablet (less once Chrome's chrome / any on-screen keyboard eats height) a ~520px dialog already risks clipping; with the virtual keyboard it clips badly.

**Confirmed consumers (8) that inherit the fix:** `PinSheet`, `PrinterSheet`, `AbandonCartDialog`, `mgr/products`, `mgr/staff`, `mgr/vouchers`, `settlements`, and the primitive itself. Fixing the shared `DialogContent` resolves all of them at once.

## Secondary finding (out of scope for Phase 0)

`dialog.tsx` references `data-[state=open]:animate-in`, `zoom-in-95`, `slide-in-from-*`, `fade-in-0` etc., but **neither `tailwindcss-animate` nor `tw-animate-css` is installed** (verified: `package.json` has no animate package; Tailwind 4 does not ship these utilities). These classes are dead no-ops today. The same dead classes appear in `dropdown-menu/popover/select/tooltip`. **Reviving (install `tw-animate-css`) or stripping them is deliberately deferred to #2 (design system)** — the master roadmap couples animation polish with the design-system phase. Phase 0 leaves them untouched to keep the blocker fix minimal and low-risk.

## Fix

Single-file change to the shared primitive `src/components/ui/dialog.tsx`, `DialogContent` className. Add a viewport height cap and internal scroll:

```
max-h-[calc(100dvh-2rem)] overflow-y-auto
```

- `100dvh` (dynamic viewport height) tracks the small viewport as browser chrome collapses, so the cap stays correct; `-2rem` leaves a 1rem gutter top + bottom. (`dvh` is supported on Chrome ≥108 / 2022 — the booth tablet is modern, no `vh` fallback needed.)
- With the box height capped at/below the viewport, the centered (`translate-y-[-50%]`) layout can no longer clip off either edge; when content exceeds the cap, the body scrolls **inside** the dialog so the keypad/footer stay reachable.
- **Propagation is verified safe:** all 11 `DialogContent` call sites set only `max-w-*` (+ some `px/pb`); **none set `max-h` or `overflow`**. Since `max-w` and `max-h` are distinct `tailwind-merge` groups, the base fix survives every consumer's className override — the one-line edit is genuinely universal.
- **Keep the close (X) button reachable while scrolling:** make the absolutely-positioned `DialogPrimitive.Close` `sticky`-equivalent is not trivial on an absolute element; instead leave it as-is (it pins to the content top) — acceptable for Phase 0 since every tall dialog (`PinSheet`, `PrinterSheet`) also has an explicit in-flow Cancel/Close button in its footer. (Noted, not blocking.)

### Bottom-sheet on short heights — decision

The roadmap floated a bottom-sheet layout (`top-4 translate-y-0`) on short viewports for thumb reach. **Decision: NOT in Phase 0.** Tailwind 4 has no built-in height-based variant, so a true short-height bottom-sheet needs a custom media query / container logic — scope creep for a blocker. The max-height + internal-scroll fix already keeps the keypad on-screen and reachable (the dialog is centered and never exceeds the viewport). Thumb-reach ergonomics can be revisited in #2's surface redesign. Documented here so the reviewer knows it was considered, not missed.

## Files

- `src/components/ui/dialog.tsx` — the only production change (one className edit).
- **Tests:** add **one** class-presence assertion that `DialogContent` renders with `max-h-[calc(100dvh-2rem)]` + `overflow-y-auto`. **This is a deletion-guard, not a behavior test** — jsdom does no layout, so no automated test can prove the dialog stops clipping; the **emulated-viewport check below is the load-bearing verification.** Assert via a small consumer render test (e.g. `PinSheet`) or a minimal new `dialog.test.tsx`; don't over-invest (the exact class string is brittle against #2's planned dialog refactor — acceptable, #2 re-verifies).
- `package.json`, `src/index.css` — **untouched** in Phase 0 (those were listed in the roadmap only for the deferred animate-revive, which is #2's job).

## Verification (HARD gate — locked in roadmap)

Verify on an **emulated tablet viewport** before declaring fixed (chrome-devtools-mcp `resize_page` / `emulate`):
1. Open `PinSheet` (e.g. the booth refund-approval PIN) at a ~800×720 and a deliberately short (~800×600) viewport.
2. Confirm: the title is visible, all 4 keypad rows are visible or scroll into view inside the dialog, and the Cancel/footer is reachable — nothing clips off the top or bottom of the screen.
3. Repeat for `PrinterSheet`.

## Out of scope (explicit)

- Animation revive/strip (→ #2).
- Bottom-sheet short-height layout (→ revisit in #2).
- Any token/design changes (→ #2).
- `package.json` / `src/index.css` edits.

## Risk

Minimal — one additive className on a shared primitive. No behavior change for dialogs that already fit; taller dialogs gain a scroll container. No schema, no backend, no deploy-skew surface. Reversible by reverting one line.
