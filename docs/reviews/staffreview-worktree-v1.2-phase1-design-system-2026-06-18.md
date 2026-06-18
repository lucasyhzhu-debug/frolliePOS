# Staff Review — v1.2 Phase 1 Design System
**Branch:** `worktree-v1.2-phase1-design-system`
**Base → Head:** `d67bd4b` → `2618a5a` (13 commits)
**Reviewer:** staff-reviewer
**Date:** 2026-06-18

---

## Summary

**The design-system foundation is architecturally sound and low-churn for phases #7/#11/#12/#3.** Token architecture is internally consistent — `.dark` carries phthalo palette, `:root` is a coherent enriched-light fallback, `@custom-variant dark` correctly re-keys all `dark:` utilities to the class, and the single `class="dark"` on `<html>` is the only rollback surface (one-line revert). All 11 plan tasks are delivered. The #4/#5 absorptions are clean. The three deferred boundaries — login logic (#7/#11), keypad interaction (#7), photo upload (#3) — are respected with no premature pre-emption. Motion is `useReducedMotion`-guarded on all four animated surfaces (home, sale, charge-success, login shell). No backend changes, no schema impact, no deploy-skew risk.

Two issues worth flagging before merge: (1) eight `*-bg` tokens in `@theme` are now dead writes after the badge sweep (pruned but not all the way); (2) in `sale/index.tsx` the motion variant objects are declared inside the render body after early returns instead of at module level — inconsistent with the `home.tsx` pattern and creates new object references on every render.

---

## Critical Issues

None. No correctness bugs, no token architecture breaks, no logic regressions detected.

---

## Improvements

### I-1: Eight `*-bg` tokens in `@theme` are now dead writes

**Location:** `src/index.css` lines 30–45 (`@theme` block)

After the badge sweep, `--color-success-bg`, `--color-warning-bg`, `--color-error-bg`, `--color-info-bg`, and the four `--color-role-*-bg` tokens are defined in `@theme` but consumed nowhere in `src/`. The plan correctly pruned the station/channel/kitchen tokens (27 removed); it missed the second tier. The new badge variants use `/15` opacity on the foreground token directly (`bg-success/15`, `bg-role-admin/15`, etc.), making the `-bg` hex values redundant.

These are harmless in production (Tailwind drops them from the compiled CSS if unused) but they leave 8 dead writes in the token file — the same pattern the plan cited as the problem with the old station tokens.

**Fix:** remove the eight `--color-*-bg` lines from `@theme`. ADR-047 already records what was pruned; update the count comment from "~27" to "~35".

**Why not Critical:** zero runtime impact (Tailwind tree-shakes them). Worth doing before merge to avoid the next agent having to reason about whether they're live.

---

### I-2: Motion variant objects in `sale/index.tsx` are declared inside the render body

**Location:** `src/routes/sale/index.tsx` lines 169–176

`gridVariants` and `itemVariants` are defined after the two early returns (`"loading"` / `"not active"`), inside the component body just before the `return` statement. They are plain object literals that depend on `reduce`, so they re-create on every render. Framer Motion is tolerant of this (it reads `.initial`/`.animate` on each frame anyway), but:

1. It is inconsistent with `home.tsx` where the equivalent patterns are module-level factory functions (`containerVariants(reduce)`, `itemVariants(reduce)`) — a future agent reading `sale/index.tsx` will not see the same idiom.
2. If `reduce` ever changes mid-session (prefers-reduced-motion is live-observable), the inline objects will correctly pick up the new value — but the module-level factory in `home.tsx` would too, since `reduce` is passed as an argument. Both patterns work; only one is consistent.

**Fix:** move to module-level factories matching the `home.tsx` pattern, or wrap in `useMemo(() => ({ ... }), [reduce])`. The former is cleaner since they don't depend on any component state.

---

### I-3: `bg-background` / `text-foreground` added explicitly to login `<main>` — redundant given `html,body,#root` rule

**Location:** `src/routes/login.tsx` lines 109, 116

The plan's Task 9 restyle adds `bg-background p-6 text-foreground` to the login `<main>` wrapper. The `bg-background` and `text-foreground` are redundant — `src/index.css` already sets `background: var(--color-background); color: var(--color-foreground)` on `html, body, #root`, which cascades through. The classes are harmless but add noise and may mislead a future reviewer into thinking login needs explicit token application that other routes don't.

The `p-6` is genuine (layout). Only the two color classes are redundant.

**Fix (optional but clean):** `<main className="flex flex-1 flex-col p-6">` — remove `bg-background text-foreground`. Low priority since it causes no visual difference.

---

## Refinements

### R-1: `active:scale-[0.97]` on `Button` fires on disabled buttons

**Location:** `src/components/ui/button.tsx` base cva string

The base string now includes `active:scale-[0.97]`. The existing `disabled:pointer-events-none` prevents `onClick` from firing, but `active:` pseudo-class can still apply on some touch environments when `pointer-events: none` doesn't fully suppress the `:active` state (especially on older WebKit/Android). The spec never mentioned this guard; it's a known Tailwind-disabled-button edge case.

**Fix:** add `disabled:active:scale-100` to the base string alongside the existing `disabled:pointer-events-none disabled:opacity-50`. One token addition.

---

### R-2: `@theme inline` exposes `--color-citrus` / `--color-citrus-foreground` but does not expose the new color-scheme `sidebar-*` or other vendor tokens that may appear via tw-animate-css

No action needed — just note for the next phase: the `@theme inline` block is the single point of Tailwind ↔ CSS variable bridging. Any future token (e.g. `--color-chart-*` if shadcn charts are added) must land there; the current setup makes this pattern obvious and consistent.

---

### R-3: `useReducedMotion` is per-component, not shared — no helper today

**Location:** `home.tsx:67`, `sale/index.tsx:50`, `sale/charge-success.tsx:33`

Three components each call `useReducedMotion() ?? false`. The plan noted this: *"a small shared helper or per-component `useReducedMotion`"* — per-component was chosen. The result is consistent and correct, and the `?? false` null-coalescing is correct (the hook returns `null` server-side or on first render before the media query is evaluated).

The only pattern inconsistency: `home.tsx` passes `reduce` into module-level factory functions, while `sale/index.tsx` captures it in inline variants (I-2 above). The login shell applies no Framer Motion at all (correct per plan — keypad interaction is #7). Charge-success uses it inline directly. Four surfaces, three different idioms — acceptable for a v1 phase but a shared `useMotionVariants(reduce)` helper would consolidate this for phases #7/#11 when more animated surfaces are added.

This is a **note for #7/#11, not a merge blocker.**

---

## Plan-Fidelity Checklist

| Task | Status | Notes |
|---|---|---|
| T1: Design mock + sign-off gate | Delivered | commit `137c118`; deleted in T11 (`2618a5a`) |
| T2: ADR-047 | Delivered | `docs/ADR/047-phthalo-dark-design-system.md` |
| T3: CSS plumbing (mount + dark-variant + tw-animate-css) | Delivered | `index.html`, `src/index.css`, `package.json` |
| T4: Token rewrite + prune | Delivered | 27 station/channel/kitchen tokens removed; `:root` enriched; `.dark` phthalo; citrus added |
| T5: Primitives (card/button/badge) + badge test | Delivered | `shadow-md`, `active:scale-[0.97]`, variant prune + `@ts-expect-error` guard |
| T6: Home redesign (#4 + #5) | Delivered | app-bar, Lock icon, hero CTA, mgr-tile hide, motion stagger, photo slot reserved |
| T7: Sale surface redesign | Delivered | grid stagger + `whileTap`, cart `AnimatePresence`, subtotal hierarchy |
| T8: Charge-success celebration | Delivered | `pathLength` checkmark draw, circle scale-in |
| T9: Login + keypad visual restyle (colors only) | Delivered | brand mark, tokens; NO submit/spinner/interaction touched |
| T10: Raw-palette sweep | Delivered | 14 files; zero raw-palette classes remaining in `src/` |
| T11: Docs + PROGRESS + cleanup mock | Delivered | mock deleted; CHANGELOG entry expected in squash |

**#4 / #5 absorbed:** confirmed — `sett` moved to `mgr` group with `mgrOnly: true`; bottom Lock button removed; Lock icon in app-bar. No standalone tasks created.

**Deferred boundaries respected:**
- No `PinEntry` submit/spinner/inline-error logic in `login.tsx` or `NumericKeypad.tsx` (only token + brand mark restyle).
- No keypad `active:scale` or pending state in `NumericKeypad.tsx` (press lives on the shared `Button` primitive, which #7 already owns as its starting surface).
- Photo slot in `TileBody` and hero is a `photoUrl?: string` field + `<div className="size-9 rounded-full bg-muted ...">` placeholder — no layout change required for #3 to drop in an `<img>`.

---

## Design-System Coherence Assessment

**`.dark` + `:root` + `@custom-variant` three-way consistency:** solid.

- `.dark` carries all phthalo values. `:root` carries coherent enriched-light values (not stock-white). `@custom-variant dark (&:where(.dark, .dark *))` correctly re-keys `dark:` utilities. Removing `class="dark"` from `index.html` yields the `:root` theme coherently — tested via the commit `39fceaa` which caught and dropped a redundant `bg-background` on the login `<main>`.
- `@theme inline` bridges all CSS vars to Tailwind utilities. The citrus token pair (`--color-citrus` / `--color-citrus-foreground`) is correctly exposed — used in `sale/index.tsx` for the qty badge (`bg-citrus text-citrus-foreground`). No token consumed but undefined.
- `--radius` only in `:root` (not in `.dark`) — correct; it's theme-agnostic and `.dark` inherits it. ADR-047 notes this explicitly.

**ADR-047 risk item: `--accent` usages pick up the elevated surface `#1E4740` (dark) / warm paper `#E3D6BC` (light):** the `Button variant="ghost"` hover and `Card hover:bg-accent` are the main consumers. On dark `#1E4740` is the correct elevated-surface hover, so this is intentional. The ADR documents this correctly: "citrus is its own token, not a remap of `--accent`."

**Dead tokens remaining:** 8 `-bg` tokens (I-1 above). Everything else is consumed or correctly pruned.

---

## Future-Churn Risk for Next Phases

**#7/#11 (login/keypad interaction):** low churn. The login shell and `NumericKeypad` were restricted to token/brand restyle only. `NumericKeypad.tsx` uses `Button variant="outline"` and `variant="secondary"` with token overrides — #7 can add `active:scale` interaction directly to the keypad keys or the shared Button primitive without touching anything this phase introduced. The `PinEntry` component was not touched at all.

**#12 (inline messaging `FieldMessage`):** zero churn. This phase explicitly notes "#12 reuses these tokens" and introduces no new opinionated typography or layout patterns that would conflict with inline messaging placement. `text-warning`, `text-error`, `text-muted-foreground` are all stable semantic tokens.

**#3 (product photos):** near-zero churn. The `photoUrl?: string` field is already in the `Tile` interface. The placeholder `<div className="size-9 rounded-full bg-muted ...">` in `TileBody` needs only a conditional `<img>` swap — same dimensions, same class names. The hero card's placeholder (`<div className="size-9 rounded-full bg-primary-foreground/20 ...">`) is a `<div>` that can be replaced inline. No grid re-layout required.

**Overall churn risk: Low.** The token-first approach means the lift propagated globally; the deferred seams are clearly marked and narrow.
