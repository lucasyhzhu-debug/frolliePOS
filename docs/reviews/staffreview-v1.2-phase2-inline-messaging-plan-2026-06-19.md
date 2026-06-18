# Staff Review: v1.2 #12 slice 1 — inline FieldMessage over toasts (PLAN)

**Date:** 2026-06-19
**Plan:** `docs/superpowers/plans/2026-06-19-v1.2-phase2-inline-messaging.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — header, global constraints, file structure, 6 tasks with TDD steps, success criteria, rollback, self-review all present.

---

## 1. Summary

**Overall Assessment: Approve (1 Improvement folded in).**

The plan is execution-ready: real signatures, complete code, exact line anchors, per-site conversion tables, and the task order keeps the tree green. I verified the two flagged assumptions against real code — one passed clean, one needed a fix:

- **esquery selectors (the biggest risk): VERIFIED ✓.** Ran the plan's three selectors against a parsed AST using the repo's own `espree`+`esquery`: `error+Literal` matched only `toast.error("…")` (not `toast.error(humanizeX(err))`, not `toast.success`); `error+emptyTemplate` matched only a zero-substitution backtick (not `\`tmpl ${x}\``); `warning+Literal` isolated correctly. The indexed `arguments.0.type` / `arguments.0.expressions.length=0` attribute selectors are supported. The guard will work as designed.
- **Test harness: FIX NEEDED (Improvement 1).** The plan's T3/T4 test snippets render `<MemoryRouter><MgrVouchers/></MemoryRouter>`, but the existing `vouchers.test.tsx` renders via a `renderRoute()` helper (`ConvexProvider` + `MemoryRouter` + `Routes/Route`) with a specific mock-session setup. The snippets must mirror that helper or the tests won't run correctly.

No Critical blockers. Evidence-Before-Mitigation gate: N/A (UX change, not a flake fix).

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended — folded into plan)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Test snippets must reuse the real `renderRoute()` harness, not a bare MemoryRouter | H | L |

### Improvement 1: Match the existing test harness exactly

`src/routes/mgr/__tests__/vouchers.test.tsx:52-64` renders through:

```tsx
function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/vouchers"]}>
        <Routes>
          <Route path="/mgr/vouchers" element={<MgrVouchers />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}
```

…with `beforeEach` setting `mockSessionReturn = { sessionId: FAKE_SESSION_ID, staff: { role: "manager" } }`, `localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID)`, and the module-level `vi.mock("convex/react", …)` returning `mockListReturn` for `listAllVouchers`. `MgrProducts` additionally needs `useNavigate` context — so the products test MUST also wrap in the Routes harness (a bare component render throws on `useNavigate`).

**Resolution:** plan updated — T4 Step 3 now says "reuse the existing `renderRoute()` helper + `beforeEach` manager setup; just add the new `it(...)`." T3 Step 3 now says "create `products.test.tsx` replicating vouchers.test.tsx's harness verbatim (`ConvexProvider` + `MemoryRouter` + `Routes`, the `vi.mock('convex/react')` block, the `useSession` mock, manager `mockSessionReturn`), with `listAllProducts` → `{ products: [], skus: [], components: [] }`." The bare-MemoryRouter snippets are replaced.

## 4. Refinements (Optional)

- **Radix Dialog in jsdom:** the inline-behavior tests open a shadcn `Dialog` (Radix, portaled to `document.body`). Testing Library `screen` queries `document.body`, so portaled content is found, and the dialog opens off React `open` state (not Radix's own trigger animation), so it renders synchronously. Low risk; if focus-trap noise appears, keep the assertion on the message text + `role="alert"` + `aria-invalid` (the behavior under test) and ignore act() warnings. Noted in the plan's test-step caveats.
- **Selector fallback note** (plan T5 Step 3) can stay as defensive documentation, but the empirical verification above means it won't trigger.
- **Duplicate field key in Add-product handler:** the bundle-slug error and the top-level skuFamily-empty error share `add.skuFamily` (last-write-wins). Intentional — both describe the same input. Fine.

## 5. Duplication Analysis

| Code | Location | Plan usage |
|------|----------|------------|
| `renderRoute()` + convex/useSession mocks | `vouchers.test.tsx` | Reuse for vouchers; replicate for products (Imp 1) |
| `badge.test.tsx` variant-guard | `__tests__/badge.test.tsx` | Template for `field-message.test.tsx` ✓ |
| `--color-destructive: var(--destructive)` indirection | `index.css:119` | Exact template for error/success lift ✓ |
| `humanize*Error` | both route files | Preserved for dynamic toasts ✓ |

No new duplication introduced.

## 6. Phase / Wave Accuracy

Task order verified correct: token lift → primitive → convert products → convert vouchers → **ESLint guard last** (after both files are literal-toast-free, so lint never goes red) → docs. This is the right sequencing — the guard would fail lint if added before conversion. ✓

## 7. Specialist Agent Recommendations

| Task | Agent | Rationale |
|------|-------|-----------|
| T1-T2 (tokens + primitive) | `ui-component-builder` | cva/Tailwind-token specialist |
| T3-T4 (form conversion) | `frontend-integrator` or direct subagent | React state + a11y wiring |
| T5-T6 (lint + docs) | direct | mechanical |

(Execution model per handoff: fresh subagent per task.)

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Worktree isolation | ✅ `worktree-v1.2-phase2-inline-messaging` |
| Atomic commits | ✅ one per task, 6 total, conventional messages |
| Pre-push verify | ✅ T6 Step 4 runs typecheck + lint + vitest + build |
| Rollback | ✅ pure FE/lint/docs, revert PR; no migration |
| Deploy ordering | ✅ N/A — no backend/function-type change, no deploy-skew |

## 9. Documentation Checkpoints

✅ ADR-048 (T6), CLAUDE.md:42 extension (T6), CHANGELOG (T6). No SCHEMA/API_REFERENCE (no backend change). PROGRESS.md handled by pipeline step 6.

## 10. Testing Plan Assessment

**Verdict:** Adequate.

| Layer | What | Type | Task |
|-------|------|------|------|
| Primitive | `fieldMessageVariants` tones + default + bad-tone type guard | vitest | T2 |
| Behavior | submit-invalid → `FieldMessage` text + `role=alert` + `aria-invalid` | vitest + RTL | T3, T4 |
| Lint | guard fires on literal `toast.error` (+ empirically pre-verified) | smoke | T5 |
| Type | bad tone fails `tsc -b` | typecheck | T2/T6 |
| Build | prod build | `npm run build` | T1/T6 |
| Manual | each dialog at booth viewport, focus, clear-on-edit, badge tints | `/browse` | success criteria |

**Regression risk:** Low. Existing `vouchers.test.tsx` doesn't assert on toasts; conversion won't red it. Badge tests assert class strings, unaffected by the token-value lift.

## 11. Edge Cases to Address

- [x] Collect-all (not early-return) — plan's worked handler accumulates into `next`
- [x] Clear-on-edit + clear-on-open — recipe steps 5-6
- [x] `aria-describedby` only when error exists — recipe step 4
- [x] Dynamic + success toasts preserved — recipe step 8
- [x] Components row-level errors keyed by index — T3 Step 2
- [x] Focus map (ids ≠ keys) — recipe step 7 + per-handler maps

## 12. Approval Conditions

**To approve:** Improvement 1 (test harness) — **folded in.**
**Recommended:** Refinements optional.

**Verdict: Approved for execution.** Both flagged assumptions verified against real code (esquery ✓ empirically; test harness ✓ corrected).

---

*Generated by /staffreview*
