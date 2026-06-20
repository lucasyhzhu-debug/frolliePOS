# ADR-049 — Client-side typed i18n dictionary (EN/ID)

**Status:** Accepted  
**Date:** 2026-06-19  
**Feature:** v1.2 #1 — EN/ID language picker  

---

## Context

Frollie POS is a single-device internal booth tool. Staff are Indonesian; managers may prefer English. The product needed a minimal, zero-dependency way to serve EN and ID copy to the same React tree, with the active locale driven by a per-staff preference stored in Convex (`staff.locale`).

Evaluated options:

| Approach | Pros | Cons |
|---|---|---|
| `react-i18next` / `i18next` | Battle-tested, rich features (plurals, interpolation, lazy loading) | 50–100 kB dependency; plural rules via CLDR overkill for two locales; adds runtime complexity |
| `react-intl` (FormatJS) | Standard; ICU plural support | Even heavier; ICU message syntax unfamiliar to the team |
| **Custom typed dictionary** | Zero deps; TypeScript enforces key exhaustiveness; simple enough for two locales | Must implement plural rule manually; no translation tooling |

## Decision

**Client-side typed dictionary with zero new dependencies.**

- `src/lib/i18n/` contains the full dictionary as two `as const` objects (`en.ts` = source of truth, `id.ts` typed as `Record<keyof typeof en, string>`).
- A TypeScript-enforced key union (`DictKey = keyof typeof en`) means missing or misspelled keys are compile errors.
- A pure `t(key, vars?)` function does substring interpolation (`{name}` → value) and the `_one`/`_other` plural split (Indonesian grammar: analytic, no morphological plurals — `_other` handles all counts ≥ 0 except 1).
- `LocaleProvider` reads `staff.locale` post-login and sets the active dictionary; pre-login defaults to `"en"`.
- `useT()` returns the bound `t()` for the current locale; `useLocale()` returns `[locale, setLocale]` for the optimistic toggle in `LocaleToggle`.

## Scope

**In:** UI copy in converted routes and components (home, LocaleToggle, and subsequent slices).  
**Out:**

- `format.ts` — currency (`Intl.NumberFormat("id-ID")`), dates, and times stay `id-ID` regardless of locale. Rupiah formatting is not locale-variable.
- Receipt HTML (`convex/receipts/template.ts`) — server-rendered; out of scope for v1.2 #1.
- Telegram messages (`convex/lib/telegramHtml.ts`) — internal ops channel; always Indonesian.
- Backend validation error strings — surfaced via `humanizeX()`, not t(); these do not need translation in v1.

## Plural convention

Keys come in `_one` / `_other` pairs (e.g. `home.catalogSummary_one`, `home.catalogSummary_other`). Callers always reference the `_other` variant and pass `{ count }`. The `t()` function selects `_one` when `count === 1`, `_other` otherwise. Indonesian has no grammatical plurals — the `_one` variant exists for English only; `id.ts` may use the same string for both.

## Locale ownership

- Pre-login: `"en"` (hard default in `LocaleProvider`).
- Post-login: `staff.locale` (`"en" | "id"`, default `"en"`, stored in Convex). Read from `useSession()` projection; `LocaleProvider` seeds from it on mount.
- Toggle: optimistic flip in `useLocale()` → `setOwnLocale` mutation → revert on failure.
- Persistence is **per-staff**, not per-device. Logging in on a different device inherits the staff's saved locale.

## Regression fence (ADR-049 ESLint rule)

As files are converted to route copy through `t()`, they are added to the i18n migration registry in `eslint.config.js`. The registry enforces:

1. No bare JSX text literals matching `[A-Za-z]{3,}` (catches hardcoded copy between tags).
2. No string literals in `label`, `placeholder`, `title`, or `aria-label` JSX attributes matching `[A-Za-z]{3,}` (catches hardcoded accessibility copy).

Brand names that are intentionally not translated are wrapped as `{"BrandName"}` (a `JSXExpressionContainer`, not `JSXText`) to keep them out of the `JSXText` selector without disabling the rule.

Files join the registry as they are converted. Task 7 will append the remaining routes.

## Consequences

- **No bundle delta** — two small `as const` objects replace the copy that was already inline.
- **Type-safe** — adding a key to `en.ts` without adding it to `id.ts` is a `tsc` error. Misspelling a key at the call site is a `tsc` error.
- **Lint-enforced** — converted files cannot silently regress to hardcoded copy.
- **Two-locale ceiling** — if a third locale is ever needed, this approach scales: add a third dictionary typed against `en`'s keys, add a picker variant, done. CLDR plural tables are only needed if a morphologically complex language is added.
- **Receipts / Telegram are deferred** — server-rendered copy is a separate migration; this ADR covers client-only.
