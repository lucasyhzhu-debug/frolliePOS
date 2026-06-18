# ADR-047: Phthalo-dark design system + glare-gate fallback

**Status:** Accepted (2026-06-18)

## Context

The POS shipped using shadcn's stock **light** theme and has never adopted the
phthalo-dark canvas the Frollie design system was built around. Three concrete
facts from the codebase at the time of this decision:

1. **No theme is ever mounted.** `src/index.css` defines a `:root`
   (near-white: `--background: oklch(0.99 0 0)`) and a `.dark` block, but
   nothing in `src/` ever adds the `.dark` class — the entire `.dark` block is
   dead code. The app always renders the light `:root`.

2. **`dark:` utilities key off media, not class.** `index.css` contains no
   `@custom-variant dark` declaration, so Tailwind 4's `dark:` utilities
   default to `@media (prefers-color-scheme: dark)`. This means the `.dark`
   selector and `dark:` utilities are decoupled — applying the class would not
   activate any `dark:` utility.

3. **~27 design tokens are dead writes.** `src/index.css @theme` defines
   station (`--color-station-*`, 16 tokens), channel
   (`--color-gofood*/--color-grabfood*/--color-k3mart*`, 8 tokens), and
   kitchen (`--color-kitchen-*`, 3 tokens) tokens. These are referenced only
   inside `src/components/ui/badge.tsx` variant definitions, and **no
   component in the POS renders those badge variants**. They represent
   Frollie Pro kitchen concepts with no POS surface today.

The canonical design-system source is
`frollie-pos design files/lucas-frollie-design-system/project/colors_and_type.css`.
The approved mock (commit 137c118) confirmed the following token values and
their WCAG-AA contrast against the paper surface:

| Token | Hex | Notes |
|---|---|---|
| Paper (`--background`) | `#102821` | deepest surface |
| Card (`--card`, `--popover`) | `#163630` | card surface |
| Elevated (`--secondary`, hover states) | `#1E4740` | raised surface |
| Warm ink (`--foreground`) | `#F1E9D8` | body copy — 12.9:1 on paper |
| Muted ink (`--muted-foreground`) | `#A9A290` | secondary copy — 6.1:1 on paper, 5.2:1 on card (both AA) |
| Teal primary (`--primary`) | `#14B8A6` | CTA, active states |
| Citrus accent (`--citrus`) | `#F9A84A` | new addition; the spark |

The POS is deployed on a **single Android tablet at an indoor mall booth**.
Real-world readability under bright mall lighting is not capturable in a
browser mock — glare on a dark canvas is the one failure mode that cannot be
verified offline.

## Decision

**Phthalo-dark is the POS default theme**, mounted via a **permanent
`class="dark"` on `<html>` in `index.html`**.

- The `.dark` block in `src/index.css` is populated with the phthalo palette
  (see token table above). This is the theme the app runs day-to-day.
- `:root` is **retained** as an enriched-light-with-phthalo-accents fallback
  — tuned toward warm paper + teal accents so it is coherent with the dark
  default, not the stock shadcn near-white.
- Citrus `#F9A84A` is added as a **dedicated** accent token (`--citrus` /
  `--citrus-foreground`, exposed to Tailwind via `@theme inline` as
  `--color-citrus`) so the spark is available to primitives and surfaces
  without reaching for a raw palette colour. (Note: the shadcn `--accent`
  slot stays mapped to the elevated surface `#1E4740` — citrus is its own
  token, not a remap of `--accent`.)

## Mechanism

**Tailwind 4 `dark:` variant.** Add to `src/index.css`:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

This re-keys `dark:` utilities from `@media (prefers-color-scheme: dark)` to
the `.dark` class. With `<html class="dark">` in place, all `dark:` utilities
activate globally, and removing the class (the glare-gate fallback) deactivates
them coherently.

**Why the class, not the media query.** The booth device is managed — staff do
not change OS colour-scheme settings. Tying the theme to a device-level OS
preference would make the glare fallback impossible to deploy without a device
settings change. A single HTML attribute is operator-controllable in seconds.

## HARD GATE: real-tablet readability under mall lighting

> This gate must be cleared before declaring the phthalo-dark rollout done.

The only reliable test is the tablet in the booth under mall ambient and
artificial lighting. A dark canvas that reads well in a development browser
may wash out or glare under different lighting conditions.

**Gate procedure:** open the shipped app on the booth tablet, navigate through
the sale + confirmation flows under typical operating lighting (midday + evening
both, if possible), and confirm readability for all text roles (body, muted,
labels, CTA).

**Fallback (instant rollback):** remove `class="dark"` from `index.html` and
redeploy. The `:root` enriched-light theme takes over immediately — no token
changes, no CSS changes. A single-attribute diff.

This fallback must remain trivially deployable. Do not embed the dark class in
a Convex setting, a localStorage flag, or a React context — keep it a static
HTML attribute so the rollback is a one-line commit.

## Token pruning

The following tokens are **removed** in the same PR as the phthalo-dark
implementation:

| Group | Tokens removed | Count |
|---|---|---|
| Station | `--color-station-production-{bg,border,text,icon}`, `--color-station-boxing-*`, `--color-station-stickering-*`, `--color-station-packing-*` | 16 |
| Channel | `--color-gofood-{bg,border}`, `--color-grabfood-{bg,border}`, `--color-k3mart-{bg,border}` | 8 |
| Kitchen | `--color-kitchen-{bg,border,counter}` | 3 |
| Semantic/role `*-bg` | `--color-{success,warning,error,info}-bg`, `--color-role-{admin,manager,staff,kitchen}-bg` | 8 |

**Total: ~35 tokens.** The semantic/role `*-bg` fills became dead writes once
the dark-tuned badge variants switched to opacity modifiers on the base color
(`bg-success/15` instead of `bg-success-bg`) — zero consumers remained, so they
are pruned alongside the kitchen-vocabulary tokens.

**Paired removal:** the `gofood`, `grabfood`, and `k3mart` variants in
`src/components/ui/badge.tsx` are deleted alongside the tokens. No POS
component renders these badge variants; the consumers should be verified as
zero before deletion.

**Tokens retained:**
- `--color-frollie-50..950` (palette scale — live in several components)
- `--color-role-{admin,manager,staff}` (role badge variants — rendered in staff
  list, audit log, session header)
- `--color-success/warning/error/info(-bg)` (semantic — rendered in banners and
  toast variants)
- Motion tokens (`--ease-*`, `--dur-*`) — consumed by Framer Motion and
  `tw-animate-css`

## Consequences

**Positive:**
- The POS finally matches the Frollie visual identity. All new features
  (v1.2+) are built on the correct canvas from the start.
- The glare-gate fallback is a single attribute — rollback risk is near-zero.
- Pruning ~35 dead tokens (27 station/channel/kitchen + 8 semantic/role `*-bg`)
  reduces `index.css` cognitive load and removes Frollie Pro kitchen concepts
  from the POS design vocabulary.
- `@custom-variant dark` makes `dark:` utilities class-driven, enabling
  coherent single-attribute theme switching without media-query dependence.

**Costs / risks:**
- Any component that hard-codes raw Tailwind palette colours (e.g.
  `bg-amber-50 text-amber-800`) will not respond to the theme. These must be
  swept to semantic tokens in the same PR; the spec identifies ~36 occurrences
  across 15 files.
- The citrus accent (`#F9A84A`) is new — components that previously used
  `--accent` (shadcn default = stone-ish) will pick up the citrus colour.
  Audit `--accent` usages before shipping.
- The enriched-light `:root` is a retune, not the original stock theme. If a
  future phase needs strict shadcn-stock-light, it will need its own `:root`
  block.

## Cross-references

- **DS source:** `frollie-pos design files/lucas-frollie-design-system/project/colors_and_type.css`
- **Roadmap spec:** `docs/superpowers/specs/2026-06-18-v1.2-phase1-design-system.md`
- **Supersedes:** nothing (additive — the `.dark` block previously contained
  shadcn defaults that were dead code)
- **Gates:** #12 (inline messaging) — reuses the phthalo tokens defined here;
  must ship after this ADR is implemented
- **Related ADRs:** [ADR-025](./025-service-worker-cache.md) (PWA/offline — no
  interaction with theme), [ADR-043](./043-web-bluetooth-escpos-printing.md)
  (printer sheet component touched in this phase)
