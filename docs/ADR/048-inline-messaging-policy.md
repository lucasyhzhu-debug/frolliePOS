# ADR-048: Inline `FieldMessage` for sync validation; toasts for global/async

**Status:** Accepted (2026-06-19)

## Context

The app-wide feedback channel is Sonner (`<Toaster>` mounted once in `src/main.tsx`).
At the time this decision was made, **~150 `toast.*` calls** exist across **~23 files** (at planning time).

A large share of these are **synchronous client-side form-validation** errors — fired
the instant a manager taps "Continue" or "Save" with an invalid field. The toast
appears at the top of the screen, detached from the field that is wrong, auto-dismisses
in a few seconds, and on a booth tablet often fires *behind* the open dialog. The
manager has to read a transient banner, then hunt for the offending input. This is the
wrong affordance for "this specific field is invalid right now."

Two concrete problems:
1. **Wrong location.** The toast is physically separated from the field. On the booth
   tablet (a single Android device running a full-screen PWA), dialogs cover most of the
   viewport; a top-of-screen toast is partially hidden behind the open dialog.
2. **Wrong lifetime.** The toast auto-dismisses. A staff member tapping quickly may
   miss it entirely; a manager who reads it still has to locate the offending input.

**No inline field-message primitive existed** in the design system before this ADR.
`shadcn/ui` ships no `FieldMessage` equivalent; every existing validation path reached
for `toast.error("literal string")`.

### Three toast buckets

From the roadmap spec (`docs/superpowers/specs/2026-06-18-pos-backlog-roadmap-design.md` §#12):

| Bucket | What | Disposition |
|---|---|---|
| **A** | Synchronous client-side **form-validation** toasts | **Convert to inline** (by-file slices) |
| **B** | ~10 PIN-flow toasts | **Out of scope** — owned by the coordinated **#11 + #7** phase |
| **C** | ~70 global/async toasts (print, draft saved, cancelled, server-rejection, Telegram, low-stock) | **Keep as toasts** — correct affordance for transient global events |

Slice 1 (this ADR) converts the 2 worst offenders:
`src/routes/mgr/products.tsx` (**26** literal-arg `toast.error` calls) and
`src/routes/mgr/vouchers.tsx` (**12** literal-arg `toast.error` calls).

## Decision

**Sync client-side form-validation feedback renders inline** via the `FieldMessage`
design-system primitive, anchored directly under the offending field, AA-legible on
the phthalo canvas.

**Global/async feedback stays as Sonner toasts.** This includes:
- Print feedback, draft saved, order cancelled
- Server-rejection errors surfaced via `humanize*Error(err)` helpers
- Telegram approval result notifications
- Low-stock and stock-drift alerts

**PIN-flow feedback is owned by the PIN surface** — `login.tsx`, `PinSheet`,
`PinEntry`, `NumericKeypad`. The existing `PinSheet error` prop is already inline.
The #11 and #7 phases own the PIN/login surface holistically; #12 must not touch it.

## Heuristic (machine-enforced)

The distinction between bucket-A and bucket-C is mechanically derivable from the
call site:

| Call form | Classification | Rule |
|---|---|---|
| `toast.error("literal string")` | Sync validation → **inline** | Must use `FieldMessage` |
| `` toast.error(`template without substitution`) `` | Sync validation → **inline** | Must use `FieldMessage` |
| `toast.error(humanize*Error(err))` | Server/async → **toast OK** | First arg is a `CallExpression` (callee ≠ `t`) |
| `toast.error(msg)` | Server/async → **toast OK** | First arg is a variable |
| `toast.error(t("key"))` | Sync validation → **inline** | Must use `FieldMessage` (post-i18n shape) |
| `toast.warning("literal")` | Sync validation → **inline** | Must use `FieldMessage` |
| `toast.warning(t("key"))` | Sync validation → **inline** | Must use `FieldMessage` (post-i18n shape) |
| `toast.success(...)` | Positive global feedback → **toast OK** | Always legal |

This heuristic is **machine-enforced** via a scoped `no-restricted-syntax` ESLint
block in `eslint.config.js`. The block is scoped via `files:` to a migrated-file
registry that grows as later #12 slices convert additional files:

```js
{
  files: ["src/routes/mgr/products.tsx", "src/routes/mgr/vouchers.tsx"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "CallExpression[callee.object.name='toast'][callee.property.name='error'][arguments.0.type='Literal']",
        message:
          "Sync form-validation must use <FieldMessage>, not toast.error(\"literal\"). See ADR-048.",
      },
      {
        selector:
          "CallExpression[callee.object.name='toast'][callee.property.name='error'][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0]",
        message:
          "Sync form-validation must use <FieldMessage>, not a literal toast.error(`...`). See ADR-048.",
      },
      {
        selector:
          "CallExpression[callee.object.name='toast'][callee.property.name='warning'][arguments.0.type='Literal']",
        message:
          "Sync form-validation must use <FieldMessage>, not toast.warning(\"literal\"). See ADR-048.",
      },
    ],
  },
},
```

New files join the `files:` array as their slice converts them. The guard fires on
literal-arg calls only; dynamic first-arg calls (`toast.error(fn(e))`) and all
`toast.success(...)` remain legal in migrated files.

## Tokens

The semantic `--color-error` (`#DC2626`) and `--color-success` (`#059669`) were fixed
static `@theme` tokens — not dark-lifted. On the phthalo card (`#163630`) their body
text fails WCAG-AA:

| Token | vs card #163630 | AA body (4.5:1)? |
|---|---|---|
| `#DC2626` (error, light) | 2.7:1 | ✗ |
| `#059669` (success, light) | 3.5:1 | ✗ |
| **`#F87171`** (red-400, lifted) | **4.7:1** | **✓** |
| **`#34D399`** (emerald-400, lifted) | **6.8:1** | **✓** |

**`--color-error`/`--color-success` are dark-lifted to `#F87171`/`#34D399`** via the
var-indirection pattern already used for `--destructive` (ADR-047):

- `--error`/`--success` raw values in `:root` (light fallback: `#DC2626`/`#059669`)
  and `.dark` (lifted: `#F87171`/`#34D399`).
- `--color-error: var(--error)` / `--color-success: var(--success)` in the existing
  `@theme inline` block (NOT a second static `@theme` — opacity modifiers like
  `bg-error/15` require `@theme inline` for `color-mix()` to resolve correctly).
- The two direct-hex lines are removed from the static `@theme` block.

**This amends ADR-047** — the token lift is an additive consequence of shipping inline
messaging, not a design-system revision in its own right. Badge `error`/`success`
variants (`bg-error/15 text-error border-error/30`) resolve to slightly brighter
red/green in dark as a side-effect — accepted (see Consequences).

**Tone set for slice 1:** `error` + `success` only. `warning`/`info` tones are
omitted until a consumer needs them (ADR-047 no-dead-tokens ethos). Adding a tone
is a one-line cva addition.

## Rollout

By-file slices. Each slice:
1. Converts all literal-arg `toast.error`/`toast.warning` validation calls in the
   target file to `<FieldMessage>` with per-field error state.
2. Adds `aria-invalid` + `aria-describedby` wiring on the inputs.
3. Adds focus-management on submit (first errored field receives `focus()` +
   `scrollIntoView`).
4. Appends the file to the `files:` array in the ESLint migration-registry block.

**Slice 1 (this ADR):** `src/routes/mgr/products.tsx` (26 sites) +
`src/routes/mgr/vouchers.tsx` (12 sites).

**Slice 2 (2026-06-20):** Converted four additional files and extended the ESLint fence.

*Post-v1.2 #1 (i18n) complication.* After the i18n migration, sync validation calls in
converted files changed shape from `toast.error("literal")` to `toast.error(t("key"))`.
The `t(...)` call is a `CallExpression`, not a `Literal` — so the original literal-only
selectors were blind to it and the fence was silently not enforcing the policy on those
sites.

Two new selectors were added to ban the post-i18n form of escaped sync validation:

```js
{
  selector:
    "CallExpression[callee.object.name='toast'][callee.property.name='error'][arguments.0.type='CallExpression'][arguments.0.callee.name='t']",
  message:
    "Sync form-validation must use <FieldMessage>, not toast.error(t(...)). See ADR-048.",
},
{
  selector:
    "CallExpression[callee.object.name='toast'][callee.property.name='warning'][arguments.0.type='CallExpression'][arguments.0.callee.name='t']",
  message:
    "Sync form-validation must use <FieldMessage>, not toast.warning(t(...)). See ADR-048.",
},
```

**Convention for legitimate server/async toasts in i18n-converted files:**
server-rejection errors, precondition failures, and other async toasts route their
translated message through a **humanizer** (`toast.error(humanize*Error(err))`) or
through a **local variable** (`const msg = t("..."); toast.error(msg)`).
A bare `toast.error(t(...))` is reserved-and-banned as the escaped-sync-validation
shape — it indicates the call should be a `FieldMessage` instead.

**Flat-config ordering fix.** `eslint.config.js` flat-config resolves `no-restricted-syntax`
with last-matching-config-wins. The v1.2 #12 fence block was originally positioned
*before* the v1.2 #1 i18n block. Because all #12-registered files are also in the #1
registry, the i18n block (placed last) overrode the fence block — making the fence
**completely dead** for all nine registered files, including slice 1's original two. The
fix moves the #12 block *after* the #1 block, and duplicates the two i18n selectors
(`JSXText` and `JSXText` brand-name fence) into the #12 block so that files appearing in
both registries carry both fences simultaneously.

**Files converted in slice 2:**
- `src/routes/settlements.tsx` — "entry key required" / "amount required" validation
- `src/routes/mgr/staff.tsx` — "name required" / "PIN required" validation (also closed
  an i18n literal gap: a hardcoded `"Staff name is required"` literal bypassed the #1
  fence until this slice)
- `src/components/auth/DeviceActivation.tsx` — setup-code validation
- `src/routes/mgr/receipt.tsx` — logo file validation

**Files joining the fence only (server errors via humanizers, no `FieldMessage` conversion needed):**
- `src/routes/mgr/stock.tsx` — server errors routed through a local
  `humanizeThresholdError(e, t)` helper; no sync validation calls to convert
- `src/routes/stock/$skuId.tsx` — same pattern; `humanizeThresholdError` co-located

The heuristic table (above) gains two rows:

| Call form | Classification | Rule |
|---|---|---|
| `toast.error(t("key"))` | Sync validation → **inline** | Must use `FieldMessage` |
| `toast.warning(t("key"))` | Sync validation → **inline** | Must use `FieldMessage` |

**Follow-up slices** (bucket-A, remaining files): none identified as of 2026-06-20.
Files join the ESLint `files:` glob as they convert.

**Out of scope forever:** PIN/login surfaces (`login.tsx`, `PinSheet`, `PinEntry`,
`NumericKeypad`) — owned by #11 and #7. Bucket-C global/async toasts — kept as toasts.

## Consequences

**Positive:**
- Validation errors appear anchored under the offending field — the correct affordance
  for a booth tablet where the manager's eyes are already on the input.
- Error state persists until corrected; no auto-dismiss race.
- Focus management (`focus()` + `scrollIntoView` on first errored field on submit)
  removes the "hunt for the bad field" UX problem.
- `aria-invalid` + `aria-describedby` + `role="alert"` satisfy WCAG 1.3.1 and 4.1.3
  for form error identification.
- The ESLint fence prevents migrated files regressing back to literal toast calls;
  grows mechanically per slice.

**Costs / risks:**
- One more primitive to maintain (`src/components/ui/field-message.tsx`).
- Error/success **badge** variants render slightly lifted in dark (brighter red/green)
  as a side-effect of the token lift — accepted. No class-name change; badge tests
  stay green. The lifted colors are strictly more accessible than the originals.
- Files not yet in the ESLint registry remain unrestricted — consistency is a
  process property (slices), not an instantaneous guarantee.

## Cross-references

- **ADR-047** (`docs/ADR/047-phthalo-dark-design-system.md`) — phthalo-dark design
  system; this ADR amends ADR-047 by dark-lifting the `error`/`success` tokens.
- **Roadmap spec §#12** (`docs/superpowers/specs/2026-06-18-pos-backlog-roadmap-design.md`)
  — backlog item that scoped this work; slice 1 of N.
- **#11 and #7** — own the PIN/login surface; bucket-B toasts are out of scope for #12.
- **Primitive:** `src/components/ui/field-message.tsx` (cva + `fieldMessageVariants`,
  parallel to `badgeVariants`).
- **ESLint guard:** `eslint.config.js` migration-registry block (final element of
  the exported array).
