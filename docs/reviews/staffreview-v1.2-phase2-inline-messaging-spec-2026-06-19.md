# Staff Review: v1.2 #12 slice 1 — inline FieldMessage over toasts (SPEC)

**Date:** 2026-06-19
**Plan:** `docs/superpowers/specs/2026-06-19-v1.2-phase2-inline-messaging-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ This is a SPEC (pre-plan); formal plan-only sections (waves, commit boundaries, per-task ordering) are deferred to the `writing-plans` step — not penalized here. Spec content itself is complete and grounded.

---

## 1. Summary

**Overall Assessment: Approve (with 4 Improvements folded into the spec before planning).**

The spec is unusually well-grounded: real line numbers, corrected toast counts (37 sync, not the roadmap's ~54), the WCAG contrast problem surfaced and validated with a screenshot, and a machine-enforceable heuristic. No Critical blockers. Four Improvements must be folded in so the plan inherits them: the token lift must live in `@theme inline` (opacity-modifier correctness), the a11y `role`/`aria-live` pairing is self-contradictory, the core inline behavior needs one automated test (the harness already exists), and focus management needs a field→input-id map.

The Evidence-Before-Mitigation gate (§4.9) is **N/A** — this is a UX affordance change, not a flake/race fix; no Task 0 needed.

## 2. Critical Issues (Must Fix)

None. The spec has no data-loss, security, or correctness blocker.

## 3. Improvements (Recommended — fold into spec before planning)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Token lift must land in `@theme inline`, not a new static `@theme` | H | L |
| 2 | `role="alert"` + `aria-live="polite"` is contradictory — tone-dependent role | M | L |
| 3 | Add one automated inline-behavior test (harness exists) | H | L |
| 4 | Focus-management needs a field→input-id map (ids don't match field keys) | M | L |

### Improvement 1: Token lift must go in `@theme inline` for opacity modifiers to survive

`badge.tsx` renders `bg-error/15 text-error border-error/30` and `bg-success/15 …` (`src/components/ui/badge.tsx:19-24`), and the FieldMessage tint is `bg-error/10`. Those `/NN` opacity modifiers only work in Tailwind v4 when the color is inlined so it can be fed to `color-mix(... transparent)`. Today `--color-error`/`--color-success` are **direct hex in the static `@theme` block** (`src/index.css:32-35`) so modifiers work. The var-indirection pattern #2 uses for `--destructive` etc. lives in the **`@theme inline` block** (`src/index.css:104-130`) precisely so `var()`-backed colors still accept opacity modifiers. If the implementer naively adds a second static `@theme { --color-error: var(--error) }`, the `/15` `/30` `/10` modifiers can silently break badge tints — and `badge.test.tsx` only asserts class strings, so it stays green and the regression ships.

**Recommendation:** Spec must state explicitly: define `--error`/`--success` in `:root` (keep `#DC2626`/`#059669`) and `.dark` (lift to `#F87171`/`#34D399`), then move `--color-error: var(--error)` / `--color-success: var(--success)` into the existing **`@theme inline`** block (where `--color-destructive: var(--destructive)` already lives). Remove the old direct-hex lines from the static `@theme`. Verify badge tints render in the dark screenshot.

### Improvement 2: `role="alert"` + `aria-live="polite"` is self-contradictory

The spec (§3) sets both `role="alert"` and `aria-live="polite"` on the wrapper. `role="alert"` implies `aria-live="assertive"`; pairing it with `polite` is contradictory and screen-reader behavior is undefined/inconsistent. For a success message, assertive interruption is also wrong.

**Recommendation:** tone-dependent: **error → `role="alert"`** (implicit assertive — interrupts, correct for a blocking validation error); **success → `role="status"`** (implicit polite). Drop the explicit `aria-live` override entirely (let the role carry it). Mounting conditionally already triggers the announcement on appear.

### Improvement 3: One automated test of the inline behavior (the harness already exists)

`src/routes/mgr/__tests__/vouchers.test.tsx` exists (125 lines) and already mocks `convex/react` + `useSession` and renders `MgrVouchers` — but it only covers empty-state, list render, and role-gating; it does **not** exercise validation. The spec's §9 leaves the core new behavior (submit-invalid → inline message) to **manual** verification only. That's the one behavior this whole phase ships — it should have an automated guard, and the cost is low because the harness is already there.

**Recommendation:** extend `vouchers.test.tsx` (and add a minimal `products.test.tsx` mirroring it): open the Add dialog, submit with an invalid field, assert the `FieldMessage` text renders under the field and the input carries `aria-invalid="true"`; assert no success toast path runs. Bump the testing verdict from manual-only to Adequate. (sonner's `toast` is a no-op callable in jsdom — no mock needed; the test just shouldn't reach a toast path.)

### Improvement 4: Focus management needs a field→input-id map

§6 says "move focus to the first errored field." But the input `id`s don't match the field keys: products uses `new-price`, `new-product-name`, `new-sku-family`, etc. (`products.tsx:849-930`); a naive `getElementById(fieldKey)` won't resolve. Vouchers similarly (`new-voucher-code`, `new-voucher-value`).

**Recommendation:** the plan must thread an explicit `fieldKey → inputId` map per dialog (or attach refs). Keep it small — focus only the primary Add dialogs if wiring every dialog is heavy (spec already allows this downgrade; make the map requirement explicit so it isn't discovered mid-implementation).

## 4. Refinements (Optional)

- **ESLint backtick evasion:** the `[arguments.0.type='Literal']` selector won't catch a zero-substitution `toast.error(\`literal\`)` (`TemplateLiteral`). None exist today, but adding a second selector `…[arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0]` closes the loophole cheaply.
- **`tw-animate-css` is now available** (`src/index.css:2`, added by #2) — `animate-in fade-in` is a viable, dependency-free entrance for FieldMessage if Lucas wants subtle motion (gate on `prefers-reduced-motion`). Optional; static is fine for slice 1.
- **Light-mode error/success values are effectively dead** (app is `<html class="dark">`-only, `index.html:2`). Keeping `:root` values is harmless hygiene; just don't spend effort tuning them.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `badgeVariants` cva pattern | `src/components/ui/badge.tsx` | Template for `fieldMessageVariants` (spec does this correctly) |
| `badge.test.tsx` variant-guard | `src/components/ui/__tests__/badge.test.tsx` | Template for `field-message.test.tsx` (spec does this correctly) |
| `humanizeCatalogError`/`humanizeVoucherError` | both route files | Keep as-is for dynamic server errors → `toast.error` (spec preserves correctly) |
| `@theme inline` indirection (`--destructive`) | `src/index.css:104-130` | Exact pattern for the error/success lift (see Improvement 1) |
| `vouchers.test.tsx` harness | `src/routes/mgr/__tests__/` | Extend for the inline-behavior test (Improvement 3) |

### Potential duplication risks
- None. No existing inline-message component; the primitive is genuinely net-new.

## 6. Phase / Wave Accuracy

Deferred to `writing-plans`. Natural ordering the plan should follow: (1) token lift in `index.css` → (2) `FieldMessage` + test → (3) ESLint guard (lands red until files convert, so sequence it WITH or AFTER conversion to avoid a red tree) → (4) convert products → (5) convert vouchers → (6) ADR/CLAUDE/CHANGELOG. **Ordering note for the plan:** the ESLint registry block will fail lint the moment it's added if literal toasts remain — add it in the SAME commit as (or after) each file's conversion, not before.

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| FieldMessage primitive + token lift | `ui-component-builder` | shadcn/cva/Tailwind-token specialist |
| Convert products/vouchers forms | `frontend-integrator` or direct | React state + a11y wiring |
| (Execution) | subagent per plan task | per the handoff's subagent-execution model |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch / worktree | ✅ pipeline runs in `worktree-v1.2-phase2-inline-messaging` |
| Commit boundaries | ⚠️ to be set by `writing-plans` (suggest: token+primitive, guard+convert-products, convert-vouchers, docs) |
| Pre-push verify | ✅ spec §9 lists typecheck + lint + test |
| Rollback | ✅ pure FE/lint/docs — revert the PR; no schema/data migration |
| Deploy ordering | ✅ N/A — no backend/function-type change, no deploy-skew risk |

## 9. Documentation Checkpoints

| Item | Status |
|------|--------|
| ADR-048 | ✅ planned (outline in spec §8) |
| CLAUDE.md design-system note | ✅ planned — extend the line at `CLAUDE.md:42` (currently lists semantic-token guidance; add FieldMessage as sanctioned inline-message primitive + ESLint fence) |
| CHANGELOG.md | ✅ planned |
| SCHEMA.md / API_REFERENCE.md | N/A — no backend change |

## 10. Testing Plan Assessment

**Verdict:** Insufficient → **Adequate after Improvement 3.**

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Primitive | `fieldMessageVariants` tones | vitest variant-guard | ✅ planned |
| Behavior | submit-invalid → inline message + `aria-invalid` | vitest + RTL (extend vouchers harness) | ❌ add (Imp 3) |
| Lint | guard fires on literal `toast.error` | scratch smoke | ✅ planned (§5) |
| Type | bad tone fails `tsc -b` | typecheck | ✅ planned |
| Manual | each dialog at booth viewport, focus, clear-on-edit | `/browse` | ✅ planned |

**Regression risk:** Low. `vouchers.test.tsx` doesn't assert on toasts, so conversion won't red it. No products test exists (add a minimal one).

## 11. Edge Cases to Address

- [x] Dynamic server errors stay as `toast.error` (spec handles)
- [x] `toast.success` stays (spec handles)
- [ ] Multi-field forms: light up ALL invalid fields in one pass, not just the first (spec §6 says so — ensure plan implements collect-all, not early-return)
- [ ] Clear-on-edit must also clear when the dialog is closed/reopened (stale errors on re-open)
- [ ] Components-editor row errors attach to the right row index (spec notes; plan must wire per-row)
- [ ] `aria-describedby` only set when an error exists (don't point at a non-existent id)

## 12. Approval Conditions

**To approve (fold into spec before planning):**
1. Improvement 1 — `@theme inline` placement for the token lift.
2. Improvement 2 — tone-dependent `role`, drop conflicting `aria-live`.
3. Improvement 3 — one automated inline-behavior test.
4. Improvement 4 — field→input-id map for focus.

**Recommended:** Refinement on backtick-evasion selector.

---

*Generated by /staffreview*
