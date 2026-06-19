# Frollie POS — EN/ID Language Picker (#1 i18n)

**Date:** 2026-06-19
**Status:** Design approved (brainstorm) — feeds `/spec-plan-pipeline` (one PR for the phase).
**Roadmap item:** #1 — EN/ID toggle. `XL · ADR · deps: #2`. Last phase of the v1.2 backlog roadmap
(`docs/superpowers/specs/2026-06-18-pos-backlog-roadmap-design.md`).

## Locked decisions (from brainstorm)

1. **Scope = staff-facing app UI only** (the React tree under `src/`). Customer receipts
   (`convex/receipts/template.ts`, `src/lib/escpos.ts`) and Telegram messages
   (`convex/lib/telegramHtml.ts`, `convex/telegram/foundersSummary.ts`) are **out of scope** — they
   are server-generated, seen by different audiences, and stay as-is.
2. **Engine = lightweight typed dictionary, zero deps.** No `react-i18next` / `react-intl`. Two locales
   only (EN/ID); Indonesian is analytic (no plural/gender inflection), so the heavyweight-library value
   (CLDR plural categories, gender, case) does not apply. What we want — compile-time key safety and
   build-time missing-translation detection — a ~80-line custom layer delivers better.
3. **English is the default** (locked at roadmap level). Bahasa via toggle.
4. **Ownership = per-staff preference in the DB.** Language follows the staffer's login. This is a
   *hybrid*: per-staff applies only post-login; pre-login screens render the English default.
5. **Toggle placement = home page `YOU` ("self") group**, a big flag-backed in-place toggle beside
   **Change PIN**. Not the account page, not the header.
6. **Extraction = full coverage.** Every user-reachable string in `src/` becomes a keyed `{en, id}`
   pair. Execution is parallelized via a **Workflow fan-out** (one agent per file/cluster).
7. **`src/lib/format.ts` stays untouched.** Currency *and* dates remain `id-ID` (currency is locale
   *data*, not copy — cross-cutting lock from the roadmap; dates ride along as locale-data). English
   month names are an explicit out-of-scope follow-on.

## Grounding (verified against current code)

- **No i18n library** in `package.json` (confirmed). Copy is hardcoded JSX literals across **34 routes /
  72 components** (`find src -name '*.tsx'` excl. tests).
- **Copy is already a bilingual mess.** `src/routes/home.tsx` alone mixes English (`"New sale"`,
  `"Change PIN"`, `"History"`) and Indonesian (`"ubah PIN Anda"`, `"Saatnya menghitung ulang stok — ketuk
  untuk mulai"`, `"payouts ke BCA"`, `"{count} pembayaran belum selesai — ketuk untuk lanjutkan"`). So
  this is **extract-into-keyed-pairs-and-fill-the-missing-side**, not one-way EN→ID translation.
- **Home `YOU` group** (`src/routes/home.tsx:32`, `GROUP_LABELS.you = "YOU"`) currently holds a single
  tile: `{ id: "account", group: "you", label: "Change PIN", to: "/account", glyph: "⚷" }`, rendered in a
  `grid-cols-2` (`home.tsx:151`). A second cell sits empty — the toggle drops in there.
- **Tiles are `Link` navigations** (`home.tsx:155`). The toggle is **not** a tile — it's an in-place
  `button` that flips locale and writes the preference. It must be rendered as a special cell in the
  `YOU` section, outside the `TILES.map`.
- **`src/lib/storage-keys.ts`** is the declared localStorage namespace; **`src/lib/format.ts`** owns
  `rp()`/`fmtTime()`/`fmtDate()` (all `id-ID`/`Asia/Jakarta`) — left untouched (decision 7).
- **Framer Motion** is used in 3 files (incl. `home.tsx` grid-stagger via `src/lib/motion.ts`); the
  toggle wraps in the existing `gridItemVariants` like its sibling tiles.

## Architecture

### A. i18n core — `src/lib/i18n/`

```
src/lib/i18n/
  dictionaries/en.ts   // export const en = { "home.newSale": "New sale", ... } as const  ← key source of truth
  dictionaries/id.ts   // export const id: Record<keyof typeof en, string> = { ... }       ← typed = completeness
  types.ts             // Locale = "en" | "id"; TranslationKey = keyof typeof en
  t.ts                 // pure t(locale, key, params?) + plural rule  (pure fn, unit-testable)
  context.tsx          // LocaleProvider + useT() hook + useLocale() [locale, setLocale]
  index.ts             // barrel
```

- **`en.ts` is the source of truth for keys.** `as const` makes `keyof typeof en` the literal union of
  every key → autocomplete + compile-time completeness.
- **`id.ts` typed as `Record<keyof typeof en, string>`** ⇒ a missing or mistyped key is a **`tsc`
  error**, not a runtime `[missing]`. (A runtime keyset-parity test backstops `as`-casting holes — see
  Testing.)
- **Flat dotted keys**, namespaced by surface: `home.*`, `sale.*`, `login.*`, `charge.*`, `history.*`,
  `mgr.*`, `stock.*`, `refund.*`, `settlements.*`, `common.*` (shared verbs: `common.cancel`,
  `common.save`, `common.confirm`, …).
- **`t(locale, key, params?)`** — dictionary lookup + `{param}` interpolation (`replace(/\{(\w+)\}/g, …)`).
  Returns the EN value as a last-resort fallback if a locale lookup is ever empty (defensive; should be
  unreachable given the typed dict).
- **Minimal plural rule (the only "grammar"):** keys that vary by count are authored as
  `key_one` / `key_other`. When `t` is called with a numeric `count` param it selects the suffix:
  **English** → `count === 1 ? _one : _other`; **Indonesian** → always `_other` (analytic). English is
  the default and genuinely needs "1 product" vs "2 products"; this is ~5 lines, not a CLDR engine.
  Example: `t("home.catalogSummary_other", { count: 12 })` → `"12 products · 3 SKUs"`.
- **`LocaleProvider`** holds `[locale, setLocale]` state and provides `t`. Mounted high — in
  `src/main.tsx` (or `RootLayout`) **above the router** so every route sees it.
- **`useT()`** returns `t` bound to the current locale; **`useLocale()`** returns `[locale, setLocale]`
  for the toggle.

### B. Persistence & lifecycle (per-staff, hybrid)

- **Schema:** add `locale: v.optional(v.union(v.literal("en"), v.literal("id")))` to the `staff` table at
  **`convex/auth/schema.ts:5`** (the `auth/` module owns Staff — there is **no** `convex/staff/schema.ts`)
  + document in `docs/SCHEMA.md`. Optional ⇒ absent means English (no migration; absent is the common
  case until a staffer toggles).
- **Mutation:** new `staff.setOwnLocale` (public mutation, in **`convex/staff/public.ts`** — that module
  owns staff-row writes; the read-side stays in `auth.getSession`) — **staff-session, self-only**
  (low-stakes config per CLAUDE.md rule #22; no manager-PIN). **Args = `{ locale, sessionId,
  idempotencyKey }` only — NO `staffId` arg.** It derives `staff_id` from the validated session, so a
  staffer can only set **their own** locale (an explicit `staffId` would let anyone rewrite another
  staffer's preference). Wrapped with `withIdempotency` + a **real** staff-session `authCheck` re-calling
  the session check before the cache lookup (rule #20 / `docs/PATTERNS/idempotency-dual-call-authcheck.md`)
  — **not** the deliberately-lax `authCheck: async () => {}` that `logout` uses (`auth/public.ts:63-70`).
- **Audit:** emit a light append-only `staff.locale_set` audit entry, `source: "booth_inline"` (matches
  `logout`'s shape), `actor_id` = the session's `staff_id` (rule #4 — state-changing writes log; cheap).
- **Session projection (explicit ADD, not "don't strip"):** `getSession` (`convex/auth/public.ts:33-38`)
  returns an **explicit allowlist** of staff fields (`{ _id, name, role, must_change_pin }`) — a new field
  is invisible to the client unless added. Two edits required:
  1. `convex/auth/public.ts` `getSession` → add `locale: staff.locale ?? "en"` to the returned `staff`.
  2. `src/hooks/useSession.ts:21-26` → add `locale: "en" | "id"` to the `status:"active"` staff type.
  (`getActiveStaff`, the pre-auth login query at `auth/public.ts:12-21`, intentionally has no locale —
  reinforcing English pre-login.)
- **Apply-on-login (login-transition SEED, not a continuous sync):** an effect in `RootLayout` (where
  `useSession()` is already consumed) seeds `setLocale(session.staff.locale ?? "en")` **only when session
  status transitions `none/loading → active`** (track the previous status with a ref). It must **not**
  continuously sync on every `staff.locale` change — that would clobber the toggle's optimistic flip
  before `getSession` refetches and flicker the UI back. The **toggle is the single writer** of runtime
  locale post-login. On lock/logout, reset to `"en"`.
- **Pre-login** (login, staff-picker, device-activation): always English default — no staff identity
  exists yet, so per-staff cannot apply. (No device-level localStorage cache for v1; English default is
  locked and sufficient. A "remember last staffer's locale pre-login" is an additive follow-on.)

### C. Home toggle UI — `src/components/pos/LocaleToggle.tsx`

- A `Card`-shaped **`button`** rendered as the second cell of the home `YOU` group (beside Change PIN),
  inside the same `grid-cols-2`, wrapped in `gridItemVariants` motion like the tiles.
- **Current locale's flag fills the card background** (object-cover) with a dark contrast scrim; overlaid:
  the language name (`English` / `Bahasa`) + a `⇄` switch affordance. The flag shown = the **active**
  language (state, not destination).
- **In-place toggle:** tap → optimistic `setLocale(next)` immediately (UI re-renders instantly) →
  fire `setOwnLocale({ locale: next })`. On mutation failure, revert + a global toast (this is the
  async/global error class that stays a toast per #12 policy).
- **Flags are inline SVG components** (`FlagGB`, `FlagID` in `src/components/pos/flags/` or co-located)
  — **NOT emoji.** Windows (the booth tablet, Chrome-on-Windows) does not render regional-indicator
  emoji as flags; `🇬🇧`/`🇮🇩` show as bare "GB"/"ID" letters. Indonesia = two horizontal bars
  (`#CE1126` over white) — trivial SVG. English = a small Union Jack SVG.
- **A11y:** `role="switch"`, `aria-checked={locale === "id"}`, `aria-label` like
  `"Language: English. Tap to switch to Bahasa Indonesia."` (itself a `t()` key). Touch target ≥ the
  tile height. Honors `useReducedMotion` like the rest of home.

ASCII (YOU group, active = ID):

```
YOU
┌──────────────┐ ┌──────────────┐
│ ⚷  Change PIN│ │▓▓▓ Bahasa ⇄▓▓│   ← Indonesia flag bg + scrim; tap → English
│    ubah PIN  │ │▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
└──────────────┘ └──────────────┘
```

### D. Copy extraction (full coverage, Workflow-driven)

- **Target:** every user-facing literal in `src/` — JSX text nodes, text-bearing props (`label`,
  `placeholder`, `title`, `aria-label`), and the **kept** Sonner toast strings (they're client-side UI).
  **Excluded:** `data-testid`, route paths, `src/lib/format.ts` output, and anything under `convex/`
  (server-side, out of scope).
- **Bilingual merge:** existing hardcoded ID strings seed the `id` dict; their EN counterparts are
  written. Existing EN strings seed `en`; ID counterparts written. Shared strings collapse into
  `common.*`.
- **Workflow shape** (execution-phase, opted in by Lucas): `pipeline` over the file list —
  - **Stage 1 (per file):** agent extracts literals, assigns namespaced keys, authors `{en, id}` values
    (filling the missing side), rewrites literals to `t("…")` / `t("…", {param})`, returns proposed dict
    entries (structured schema). `isolation: "worktree"` since agents edit files in parallel.
  - **Stage 2 (merge):** consolidate all entries into `en.ts`/`id.ts`, dedup shared strings into
    `common.*`, resolve key collisions.
  - **Stage 3 (verify):** `tsc` + an agent sweep for missed literals and obviously-wrong translations.
- This is the XL grunt-work; the infra (A/B/C) is bounded and lands first so the toggle is live before
  the long-tail extraction completes.

### E. Guards, ADR, testing

- **ESLint regression fence** (scoped allowlist, mirroring the #12 `no-restricted-syntax` toast fence in
  `eslint.config.js`): in converted files, ban bare user-facing JSX text / string literals in known text
  props so new hardcoded copy can't regress. Files join the fence registry as they're converted.
- **ADR-049** (roadmap-gated; highest existing ADR = 048): "i18n architecture — client-side typed
  dictionary, per-staff locale, English default, `format.ts` (currency + dates) excluded;
  receipts/Telegram out of scope." Records why no library (2 analytic-friendly locales) and the hybrid
  pre-login fallback.
- **Tests:**
  - `t.ts` unit: lookup, `{param}` interpolation, plural selection (EN `_one`/`_other`, ID `_other`),
    EN fallback path.
  - **Keyset-parity runtime test:** assert `Object.keys(en)` ≡ `Object.keys(id)` — backstops any `as`
    casting hole the type system can't see.
  - `LocaleToggle`: renders the active flag, tap flips locale + calls `setOwnLocale`, optimistic update,
    revert-on-failure.
  - `setOwnLocale` (convex-test): self-only patch, idempotency, audit row written.
  - Session-applies-locale: active session with `staff.locale = "id"` ⇒ context locale `"id"`.
  - Pre-login default: no session ⇒ `"en"`.

## Cross-cutting constraints & collisions

- **`format.ts` untouched** — currency + dates stay `id-ID` (locked). i18n never imports/edits it.
- **Receipts / Telegram out of scope** — no `convex/` copy is keyed in this phase.
- **#2 (phthalo-dark) is a dependency** — the toggle uses semantic tokens (`bg-card`, scrim via
  `bg-foreground/…`), no raw palette literals; flags are the only raw-color exception (national colors).
- **#12 (FieldMessage) precedes #1** — inline messages already exist by the last phase; their literals
  are extracted too. Toast-vs-inline policy is unchanged; the toggle's async-failure path stays a toast.
- **#4 (home declutter) / #5 (lock icon) touch `home.tsx` first** — #1 adds the `YOU`-group toggle after
  those land; coordinate the `YOU` section render (the toggle is an extra cell, not a `TILES` entry).
- **Deploy:** adding an optional `staff.locale` field is additive (no skew risk); `setOwnLocale` is a
  net-new mutation (no rename → no mutation↔action skew).

## Decisions resolved in spec staffreview (2026-06-19)

- **Audit the locale change** → **yes** (`staff.locale_set`, `source: "booth_inline"`).
- **Mutation module** → **`convex/staff/public.ts`** (owns staff-row writes); read-side in `auth.getSession`.
- **Provider mount** → `LocaleProvider` in `src/main.tsx` (above router); apply-on-login effect in
  `RootLayout` (consumes `useSession`), as a **login-transition seed** (not continuous sync).
- **ADR** → **ADR-049**.
- **Plural** → `_one`/`_other` suffix convention.
- **Pre-login locale** → always English (v1).
- **ESLint fence** → add **now**; registry grows per converted file.

## Open decisions (confirm at plan time)

1. **Flag for English** — Union Jack (GB) vs US. Recommend **Union Jack** (conventional "English" marker).
2. **Extraction batching** — file-cluster size per Workflow Stage-1 agent (tune for the 16-agent cap).
