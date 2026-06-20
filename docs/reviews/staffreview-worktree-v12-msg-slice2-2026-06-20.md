# Staff review — v1.2 #12 slice 2 (inline messaging: settlements / staff / device / receipt + stock fence)

**Branch:** `worktree-v12-msg-slice2` · **Base:** `041dcd8` · **Head:** `05078cb`
**Reviewer:** staff-eng (architectural, ADR-034 deep-module + ADR-048 reuse lens)
**Date:** 2026-06-20

---

## Summary

**Verdict: this change keeps the design system DEEP and reuse-clean.** No new primitive, token, variant, or hook was introduced; `FieldMessage` and `useFieldErrors` are consumed verbatim across all four converted files using a single, identical idiom. The one genuinely tricky piece — the ESLint flat-config last-wins ordering bug that had silently killed the *entire* slice-1 fence — is correctly diagnosed and repaired, and I verified the repair is live (a scratch `toast.error(t(...))` in a registered file now fails lint, and all six registered files lint clean at exit 0). The change matches its spec and plan with high fidelity, including the two deliberate gate-loosenings and the net→fee placement call.

The only structural cost worth naming is the **duplicated i18n selector block** inside the #12 fence (necessary given flat-config semantics, but now two places to keep the JSXText/text-prop selectors in sync). That is an Important-tier maintainability note, not a blocker. The humanizer co-location question (now 6 instances) is a real rule-of-three trigger but the spec consciously chose co-location and the cost of extracting now is low-value; I land it as a Minor with a recommended follow-up, not a change request.

No critical issues. Ship-ready.

---

## Critical Issues

None.

---

## Improvements (Important)

### I1 — Duplicated i18n selectors in the #12 fence block: real, accepted, but flag the sync hazard
`eslint.config.js` now carries the two ADR-049 i18n selectors (`JSXText[value=/[A-Za-z]{3,}/]` and the `label|placeholder|title|aria-label` text-prop selector) in **both** the #1 block (lines 227–236) and the duplicated copy in the #12 block (lines 266–275). This is forced by flat-config's last-matching-config-wins resolution of `no-restricted-syntax`: a later `files:`-scoped block fully *replaces* the rule config for matched files rather than merging, so a file in both registries would lose the i18n selectors entirely if #12 (which must come last to win the toast selectors) didn't re-declare them.

The fix is correct and the inline `NOTE:` comment (lines 248–250) plus the ADR amendment explain it well. The residual cost is genuine: **if the #1 i18n selectors ever change (e.g. the watched attr set grows), the change must be made in two places** or the nine dual-registered files silently drift. There is no machine guard against that drift.

This is the cleanest available structure given ESLint flat-config semantics — the alternatives (a single merged block listing the union of all files, or a shared `const SELECTORS` array spread into both blocks) each have downsides:
- A shared `const toastFenceSelectors = [...]` / `const i18nSelectors = [...]` spread into both blocks would eliminate the copy-paste drift at the cost of one indirection. **Recommend this** — it is a pure mechanical dedupe with no semantic change and directly removes the two-places-to-edit hazard. Low effort, worth doing before this compounds in slice 3+.

Not a blocker; the duplication is correct today and documented. But the spread-const refactor is the right structural answer and I'd take it now while the duplication is only one pair of selectors.

---

## Refinements (Minor)

### M1 — Humanizer co-location has now hit rule-of-three (6 instances); open a follow-up, don't extract yet
The slice adds `humanizeThresholdError` (`src/routes/stock/$skuId.tsx:14`) co-located, mirroring `humanizeSettlementError` (`settlements.tsx:45`). The full census is now **six** co-located server-error humanizers, all with the same `(e: unknown, t) => string` shape and the same `instanceof Error ? e.message : String(e)` preamble:

- `settlements.tsx:45` `humanizeSettlementError`
- `mgr/staff.tsx:75` `humanizeAuthError`
- `components/layout/DeviceActivation.tsx:26` `friendlyActivationError`
- `mgr/receipt.tsx:53` `humanizeSettingsError`
- `mgr/stock.tsx:37` `humanizeDriftError`
- `stock/$skuId.tsx:14` `humanizeThresholdError` (new)

This is past the rule-of-three line, so it warrants a *note*. However: (a) the spec explicitly chose co-location ("humanizers are NOT in a shared lib", spec lines 102/156), (b) each humanizer maps a *different, domain-specific* set of error codes — there is no shared mapping table to extract, only the 3-line `Error→string` preamble, and (c) the value of extracting a shared `errorMessageRaw(e)` helper for just that preamble is marginal versus the import cost across six files. The honest call: the *pattern* recurs but the *duplicated code* is trivial (one line each). I would **not** extract a humanizer registry now. The defensible micro-extraction is only the `e instanceof Error ? e.message : String(e)` line — and `src/lib/errors.ts::errorMessage` already exists for the ConvexError-unwrapping case, so a future consolidation should route through there, not a new lib. Recommend opening a tracking issue ("humanizer preamble dedupe via lib/errors") rather than acting in this slice. Co-location here is correct; the finding is that the *next* humanizer should be the trigger to revisit, and that should be written down.

### M2 — Stale `src/components/auth/DeviceActivation.tsx` path in spec/ADR prose
The spec scope table (design doc line 24) and the ADR-048 amendment (line 202) both reference `src/components/auth/DeviceActivation.tsx`. The file actually lives at `src/components/layout/DeviceActivation.tsx` — which is what the ESLint registry (line 257), the diff, the test, and the real imports (`activate.tsx`, the new test) all correctly use. So the *code* is right and consistent; only two doc strings carry the wrong directory. Harmless today (the registry glob is correct), but it's a latent trap for anyone who greps the ADR to find the file. One-line doc fix in the ADR amendment.

### M3 — `grossAmount: gross!` non-null assertions are sound but lean on validator/gate coupling
In `settlements.tsx::submitFormOpenPin`, after the collect-all validator returns, the dispatch uses `gross!`, `mdr!`, `count!` (diff line 1193). These are safe **because** the same `next` map that gates the early `return` is built from `gross === null` / `mdr === null` / `count === null` checks — so reaching the `setPinAction` line guarantees non-null. This is correct, but the safety is an implicit invariant between the validator and the assertions rather than something the type system enforces. The slice-1 pattern does the same, so this is consistent (not a divergence). No change required; noting it as the one spot where a future edit to the validator (e.g. making a field optional) could silently invalidate the `!`. A short `// non-null: guarded by the null-checks in `next` above` comment would inoculate it. Minor.

### M4 — `mgr/receipt.tsx` logo: `uploadKey!` assertion is correctly guarded and well-commented
`generateLogoUploadUrl({ idempotencyKey: uploadKey!, ... })` (diff line 837) carries the inline comment `// guarded above: if (!uploadKey) applyErrors → return`. Good — this is exactly the POC/invariant-comment discipline that saves a reviewer trip. No action; calling it out as a positive that the rest of the assertions (M3) could mirror.

---

## Nitpick

### N1 — `applyErrors` clears the input on the precondition-via-validator branch only in receipt
In `receipt.tsx::onPickLogo`, when `applyErrors` returns true the file input is reset (`fileInputRef.current.value = ""`, diff line 828). This is correct and desirable (lets the user re-pick the same file). It's a per-file detail not shared with the other three converters (which don't have a file input to reset), so it's not a consistency violation — just noting it's a deliberate local nuance, well-placed.

### N2 — ADR heuristic-table row wording drift
The amended heuristic table adds `toast.error(t("key"))` rows (ADR lines 69, 83) and the upper `humanize*Error` row gained the clarifying `(callee ≠ t)` qualifier (line 67). Internally consistent and accurate against the selectors. Pure documentation polish — no action.

---

## Focus-area dispositions

1. **Reuse discipline** — PASS. No new primitive/token/variant/hook. `FieldMessage` (`src/components/ui/field-message.tsx`) and `useFieldErrors` (`src/hooks/useFieldErrors.ts`) imported and consumed verbatim; no fork. The spec's "no new message type" constraint is honored (net<0 reuses `entry.mdr` + the existing `settlements.errorNetInvalid` key, reworded only).
2. **Pattern consistency** — PASS. All four converters apply the identical idiom: module-scope `*_FOCUS` map, collect-all `next` record → `applyErrors(prefix, next, FOCUS)`, per-field `aria-invalid` + `aria-describedby` + `FieldMessage`, `clearFieldError` in `onChange`, `clearErrors(prefix)` on dialog open. `staff.tsx`'s rename row correctly uses `mergeErrors` (single field, no focus map) — a documented, acceptable variant, not drift.
3. **Humanizer locality** — Co-location is correct for this slice (see M1). Rule-of-three is technically tripped but the duplicated *code* is one trivial line per site and the mappings are domain-distinct; extraction now would be low-value over-abstraction. Follow-up issue recommended, no in-slice action.
4. **ESLint fence repair** — PASS, and verified live. The flat-config last-wins diagnosis is correct; moving #12 after #1 and duplicating the i18n selectors is the right fix. Residual two-places-to-sync cost is real → see I1 (recommend a shared-const spread to dedupe).
5. **Graft integrity / scope** — PASS. FE-only, no schema/Convex/API surface touched, no money/audit/idempotency paths altered. Exporting `humanizeThresholdError` from a route module is a slightly unusual shape (a route file now has a named non-component export) but it's test-only surface and mirrors the existing co-location convention; no graft risk. No scope creep beyond the spec — the i18n-gap closure in `staff.tsx` (raw literals → `t()` keys) is in-spec and a net positive.
6. **Plan fidelity** — High. Both deliberate gate-loosenings (settlements `disabled={!entryKey}`, staff `disabled={!createKey}`) match the plan's CRITICAL steps 4b/5b; the net→fee key reword, the two new `mgrStaff.*` keys with en+id parity, the variable-idiom for all three kept precondition/async toasts, and the five new test files + humanizer unit test are all present as specified.

---

## Verification performed

- `npx eslint` on all six registered files → **exit 0**, clean.
- Fence regression check: injected `toast.error(t("settlements.errorTryAgain"))` into a registered file → lint **failed** with the ADR-048 message (confirms the ordering fix is live, not just present). Scratch reverted.
- Confirmed `FieldMessage` / `useFieldErrors` are imported, not copied, and unchanged from slice 1.
- Confirmed `DeviceActivation.tsx` real path (`components/layout/`) vs the stale `components/auth/` doc references.
