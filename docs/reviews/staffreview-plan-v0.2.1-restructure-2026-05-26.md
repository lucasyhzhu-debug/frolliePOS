# Staff Review: v0.2.1 Architecture Restructure Plan

**Date:** 2026-05-26
**Plan:** `docs/superpowers/plans/2026-05-26-v0.2.1-architecture-restructure.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated

---

## 0. Plan Structure Additions

None — all six required sections present (Goal, File Changes table, Implementation Phases A–J, Testing per-task + Section J, Success Criteria checklist, Rollback notes within tasks + "do NOT auto-push"). ✅

---

## 1. Summary

**Overall Assessment:** **Revise** (3 Criticals — all in cross-task import-chain mechanics and schema-required-field cascade. None require rethinking the architecture; all are surgical fixes to specific task steps.)

The plan's structure is sound and matches the scope doc faithfully. Task sequencing (lint-first → foundational modules → domain modules → frontend → docs → verify) is correct. The three Critical issues are all execution-mechanics blind spots: (1) Task B1 moves `idempotency.ts` but doesn't update the import paths in still-flat `auth.ts` / `staff.ts` that consume it; (2) Task F6 flips `code` fields to required but multiple call sites — `_seedStaffCommit_internal`, `_createStaffCommit_internal`, and raw `ctx.db.insert("staff", ...)` in tests — don't pass a code, breaking the test suite + production createStaff path; (3) no feature-branch step, plan implicitly works on whatever branch the executor is on.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|---|---|---|
| 1 | Task B1 doesn't update import paths in `auth.ts` / `staff.ts` after moving `idempotency.ts` — breaks the build between tasks B1 and C3 | Implementation / Build | Plan §"Task B1" steps 2-4 |
| 2 | Task F6 flips `code` to required, but `_seedStaffCommit_internal` + `_createStaffCommit_internal` + raw test inserts don't supply a code — schema validator rejects every insert, breaking ~half the test suite | Logic / Testing | Plan §"Task F6" + §"Task E4" |
| 3 | No feature-branch step — plan implicitly assumes whatever branch the executor is on | Git workflow | Plan top-level (missing) |

### Issue 1: Task B1 leaves broken imports in still-flat files

After `git mv convex/idempotency.ts convex/idempotency/internal.ts` (Task B1 step 2), the existing `convex/auth.ts` and `convex/staff.ts` still have:

```ts
import { withIdempotency } from "./idempotency";  // auth.ts line 4, staff.ts line 4
```

Node / TypeScript module resolution tries `"./idempotency.ts"` (gone), then `"./idempotency/index.ts"` (doesn't exist). Resolution fails. Task B1 step 4 says "Expected: all idempotency tests pass" — actually `npm run test:convex` would fail wholesale because the test runner can't even compile the auth/staff modules.

Compare with Task B2 step 5 — that step correctly updates `logAudit` imports in `auth.ts` / `staff.ts` / `seed.ts` as part of the audit migration. B1 is missing the analogous step for `withIdempotency`.

**Recommendation:** Add new sub-step **B1.3a** between current steps 2 and 3:

> - [ ] **Step 2.5: Update import paths in still-flat consumers**
>
> In `convex/auth.ts`:
> ```ts
> // From: import { withIdempotency } from "./idempotency";
> import { withIdempotency } from "./idempotency/internal";
> ```
> Same change in `convex/staff.ts`.
> (No change needed in convex/seed.ts — doesn't import withIdempotency.)

Also update Step 4's expectation: "Run `npm run typecheck && npm test` — all suites pass."

This same fix-shape lives in B2 step 5; promote it as a general pattern stated near the top of Section B: **"After any cross-module move, update import paths in every still-existing consumer before running tests."**

### Issue 2: F6 cascades through ~5 hidden call sites

Task F6 flips `staff.code`, `pos_products.code`, `pos_inventory_skus.code` to required (`v.string()` not `v.optional(v.string())`). After this commit, Convex schema validation rejects any `ctx.db.insert("staff", {...})` that omits `code`. There are at least three such call sites — none updated by the plan:

1. **`_seedStaffCommit_internal`** (currently in `convex/auth.ts` lines 273-289; moves to `convex/auth/internal.ts` in Task C3):
   ```ts
   return await ctx.db.insert("staff", {
     name: args.name,
     pin_hash: args.pin_hash,
     role: args.role,
     active: true,
     created_at: Date.now(),
   });  // ← no `code` field
   ```
   This is called by `_seedHashedStaff_internal` (test-only helper), which is called by `seedStaff()` in every test file. **After F6, every test using `seedStaff` fails on the insert.**

2. **`_createStaffCommit_internal`** (currently in `convex/staff.ts` lines 49-87; moves to `convex/staff/internal.ts` in Task D1):
   ```ts
   const newId = await ctx.db.insert("staff", {
     name: args.name, pin_hash: args.pin_hash, role: args.role,
     active: true, created_at: Date.now(),
   });  // ← no `code` field
   ```
   This is the production path used by the manager's `createStaff` action. **After F6, creating new staff in production breaks.**

3. **Raw test inserts** like `convex/auth.test.ts` line 28-31:
   ```ts
   await t.run(async (ctx) =>
     ctx.db.insert("staff", {
       name: "Old", pin_hash: "x", role: "staff", active: false, created_at: 0,
     })  // ← no `code` field
   );
   ```
   Same problem. Quick grep across `convex/**/*.test.ts` would surface every such call.

The plan's Task F6 step 3 ("Run tests — expected: pass") would actually fail wholesale.

**Recommendation: Drop Task F6.** Keep `code` as `v.optional(v.string())` in v0.2.1. Document the deferral in CHANGELOG: "v0.2.1 ships stable code fields as optional; v0.3 promotes to required when createStaff + future create-product mutations gain allocation logic."

The justification is sound:
- **Seed already populates codes** for the standard 5 staff + 5 components + 7 products (per Tasks E2-E4 + F3). Format conformance tests in Task F5 verify this.
- **`createStaff` doesn't allocate codes today** — adding allocation logic is its own design question (sequential vs hash-derived, race-safety, etc.). Out of v0.2.1 scope.
- **Optional fields don't weaken the contract** — `docs/PUBLIC_API.md` (which doesn't ship endpoints yet) can document `staffCode` as "guaranteed present in seeded environments; v0.3 makes guaranteed across the board."

Alternative if you insist on flipping in v0.2.1: add three sub-steps to F6 that update each call site to allocate a code (sequential `S-NNNN` based on `max(existing) + 1`). But this is design work that triples F6's complexity for marginal gain over the deferral.

### Issue 3: No feature branch step

Plan jumps straight to Task A1 (install ESLint) with no instruction to create a branch. Per the user's workflow (CLAUDE.md mentions `/gsd-pr-branch` and GSD phase branches), v0.2.1 should land on a dedicated branch, not whatever main / WIP branch the executor inherits.

**Recommendation:** Add Task A0:

```markdown
## Task A0: Create feature branch

- [ ] **Step 1: Verify on main with clean working tree**

Run: `git status`
Expected: "On branch main", "nothing to commit, working tree clean".
If not: stash or commit pending work before proceeding.

- [ ] **Step 2: Create + switch to feature branch**

Run: `git checkout -b feat/v0.2.1-architecture-restructure`

- [ ] **Step 3: Verify**

Run: `git branch --show-current`
Expected: `feat/v0.2.1-architecture-restructure`
```

Add a corresponding cleanup note to Task J5: "After tag, return to main only if user explicitly requests merge."

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|---|---|---|
| 1 | Handle `convex/__runtime_smoke__.test.ts` placement (currently at root convex/) | L | L |
| 2 | Section-level pattern statement: "after any cross-module move, update consumer imports before running tests" | M | L |
| 3 | Verify ESLint rule's regex on Windows paths (user is on win32) | M | L |
| 4 | Add a regression smoke step in J3 that confirms audit_log row writes still happen | M | L |
| 5 | Plan doesn't address `tsconfig.app.json` / `tsconfig.json` — verify no path aliases need updating | L | L |
| 6 | Subagent dispatch: per-task complexity varies (mechanical moves vs ESLint rule design); note this in the execution handoff | L | L |
| 7 | Task A2's RuleTester runs inside vitest — verify ESLint RuleTester is vitest-compatible (typically used with mocha) | M | L |

### Improvement 1: `__runtime_smoke__.test.ts`

This file exists at `convex/__runtime_smoke__.test.ts` (per the file glob in scope walk). Reading it: it's a standalone test for `hash-wasm` argon2 functionality — **no imports from any convex module**. So technically it survives the restructure as-is.

But: it lives at root `convex/` while every other test moves into a module subdirectory. After v0.2.1, `convex/` should ideally contain only `schema.ts` + `http.ts` + `_generated/` + module subdirs. A stray test file at root looks like an oversight.

**Recommendation:** Move to `convex/_runtime_smoke/__tests__/argon2.test.ts` (or just leave at root with an inline comment "runtime smoke test, deliberately at root — verifies hash-wasm loads in the test environment"). Pick one; document.

### Improvement 2: Cross-module-move pattern statement

Critical #1 surfaced the pattern. State it once at the top of Section B (and again at the top of any section that moves a foundational module):

> **Pattern: cross-module move sequence.** Any task in this section that moves a foundational module (`idempotency/`, `audit/`) MUST update import paths in every existing consumer before running tests. Consumers as of this section: `convex/auth.ts`, `convex/staff.ts`, `convex/seed.ts`. Grep for `from "./<moduleName>"` to find them.

This both prevents future occurrences of Critical #1 and educates the executor about why intermediate-state typecheck matters.

### Improvement 3: Windows path normalization in ESLint rule

The custom rule (Task A2) extracts the caller module from `context.filename`:

```js
const filename = context.filename.replace(/\\/g, "/");
const match = filename.match(/convex\/([^/]+)(?:\/|\.ts$)/);
```

The `replace(/\\/g, "/")` handles Windows backslashes — good. But the **test fixtures** in Task A2 use POSIX-style paths (`filename: "convex/catalog/public.ts"`). On the user's Windows machine, when running `npm run lint` for real, `context.filename` is `D:\Claude\FrolliePOS\convex\catalog\public.ts`. After normalization it's `D:/Claude/FrolliePOS/convex/catalog/public.ts`. The regex `convex\/([^/]+)(?:\/|\.ts$)/` matches the FIRST occurrence of "convex/" — which works, but only because the project isn't installed somewhere that has "convex" in the parent path.

**Recommendation:** Make the regex anchor at the project root or at the file extension. Safer regex:

```js
const match = filename.match(/\/convex\/([^/]+?)(?:\/|\.ts$)/) ?? filename.match(/^convex\/([^/]+?)(?:\/|\.ts$)/);
```

And add a Windows-path fixture test:
```js
{
  filename: "D:\\Claude\\FrolliePOS\\convex\\cart\\public.ts",  // Windows path
  code: `ctx.db.query("pos_products").collect();`,
  options: [{ ownership: { "pos_products": "catalog" } }],
  errors: [{ messageId: "crossModule" }],
},
```

### Improvement 4: Audit log regression smoke in J3

Manual smoke covers device activation → login → home → lock. None of these explicitly verifies audit_log writes. The plan's biggest behavioral risk is the `logAudit` clarification (Task B2 + I4): even though it stays a plain function, the import path moved. If a stale import slipped through anywhere, `logAudit` calls would silently no-op (or throw).

**Recommendation:** Add J3 step 6:
> - [ ] **Step 6: Verify audit_log row writes**
>
> After completing the smoke (device activation + login + lock), open the Convex dashboard or run:
> ```bash
> npx convex run --no-push -- "ctx => ctx.db.query('audit_log').order('desc').take(5)"
> ```
> Expected: see at least 3 recent rows — `device.activated`, `staff.login`, `staff.logout` — each with `created_at` within the last few minutes.

### Improvement 5: tsconfig path verification

Per the earlier code walk, no path aliases like `@convex/*` exist (the code uses relative imports). But the plan doesn't explicitly verify this. Add a step in Task A1 (or J1) that runs `grep -r "@convex" src/ convex/` and expects no matches — confirms no hidden alias depends on the flat layout.

### Improvement 6: Note dispatch granularity in the execution handoff

When the user picks "Subagent-Driven," the dispatcher should know that:
- Tasks A2, F3, F5, I4 are **30+ minute design / writing tasks** — dispatch carefully, give each subagent enough context
- Tasks B1-B2, C3-C5, D1-D2, E1-E4 are **5-10 minute mechanical moves** — fast subagent turnover
- Tasks G1-G5 are **2 minutes each** — could be a single subagent doing all five if context budget tight

Currently the plan treats every task as equivalent. The handoff comment in §"Execution" should note the dispersion.

### Improvement 7: RuleTester + vitest compatibility

ESLint's `RuleTester` was historically used with Mocha. The vitest pattern (`tester.run(name, rule, { valid, invalid })` inside `it()`) should work — `RuleTester.run` accepts assertions via the `it` global — but isn't guaranteed across all ESLint versions. ESLint 9.x exposes `RuleTester` with a constructor option for the test runner.

**Recommendation:** Task A2 step 2 should preface with: "If vitest doesn't pick up the RuleTester assertions correctly, switch to using `tester.run` outside an `it()` block (RuleTester auto-defines its own test cases). See ESLint docs for the vitest-compatible pattern."

Two-line note, executor adapts if needed.

## 4. Refinements (Optional)

- Section ordering: Section E (catalog) could parallelize with Section D (staff) since they don't share state. Sequential is also fine — keeps cognitive load low. **Refinement: leave as sequential** for clarity.
- The `productCode` derivation logic in Task F3 is buried inline in `seed/internal.ts`. Could extract to a helper later. For v0.2.1 it's only used by seed, so inline is fine.
- Task I3 (CLAUDE.md update) doesn't update the "How to add a feature" section, which references `convex/audit.ts logAudit` — could update that pointer too. Cosmetic.
- The ESLint config (Task A3) sets `@typescript-eslint/no-explicit-any` to `off` and `no-unused-vars` to `warn` — these are pragmatic defaults but worth a comment in the config explaining why ("Convex code uses `any` for some generic boundaries; revisit when v0.3 settles").

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|---|---|---|
| `withIdempotency` | `convex/idempotency.ts` → `convex/idempotency/internal.ts` | Plan correctly preserves verbatim |
| `logAudit` plain helper | `convex/audit.ts` → `convex/audit/internal.ts` | Plan correctly preserves verbatim (plus ADR amendment) |
| `requireSession` / `requireManagerSession` | `convex/staff.ts` → `convex/auth/sessions.ts` | Plan correctly extracts to break backwards dep |
| argon2id helper pattern | `convex/authActions.ts` `_hashPin_internal` | Reuse for future bearer-token hashing in v0.3 — plan notes this in the stub |
| Convex `_id` opaque IDs | Convex primitive | Plan correctly maps to stable string IDs at API boundary (not in v0.2.1; documented in PUBLIC_API.md stub) |

### Potential duplication risks

- The `productCode` derivation (Task F3) is one of several places where the codebase will need to allocate codes (seed today, manager portal in v0.5, transaction creation in v0.3). If three different sites end up with three different allocation algorithms, future bugs. **Defer the helper extraction until v0.3 when the second use site lands** — premature now.
- The `convex/seed/internal.ts` table-wipe list hardcodes table names. As schema fragments are added by future modules, easy to forget updating this list. **Refinement only**: comment in seed pointing to "if you add a table, add it here too."

## 6. Phase / Wave Accuracy

| Section | Assessment | Notes |
|---|---|---|
| A (Setup) | ✅ Good | Lint-first ordering is critical and correct |
| B (Foundational) | ⚠️ Needs Critical #1 fix | Idempotency move missing import update step |
| C (Auth) | ✅ Good | Sessions extraction sequencing is clever — transitional re-export keeps audit working until D2 |
| D (Staff) | ✅ Good | D1 → D2 sequence correctly removes the backwards dep |
| E (Catalog) | ✅ Good | Could parallelize with D but sequential is clearer |
| F (Seed + codes) | ⚠️ Needs Critical #2 fix | Task F6 cascade-breaks; drop or expand |
| G (Frontend) | ✅ Good | Atomic per-file commits, typecheck checkpoint at G5 |
| H (API scaffold) | ✅ Good | Stub-only is right for v0.2.1 |
| I (Docs) | ✅ Good | All 5 docs addressed |
| J (Verification) | ✅ Good | Comprehensive checklist; minor add per Improvement #4 |

**Ordering issues:** None other than what's covered in Criticals.

**Missing phases:** Task A0 (branch creation) per Critical #3.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|---|---|---|
| A1 (npm install) | (none — Bash directly) | Trivial |
| A2 (custom ESLint rule) | `general-purpose` | No specialized agent for ESLint rule authoring; Convex-expert overkill |
| A3 (eslint config) | `general-purpose` | Same |
| B1, B2, C1-C5, D1-D2, E1, F1-F2 | `convex-expert` | Convex-specific module migrations + schema composition |
| E2-E4, F3 | `convex-expert` | Schema field additions + seed updates |
| F5 (format conformance tests) | `convex-expert` | convex-test setup |
| F6 | (drop per Critical #2) | — |
| G1-G5 (frontend renames) | `frontend-integrator` | React + Convex hook integration is its specialty |
| H1, H2 | `general-purpose` | Scaffold stubs |
| I1-I5 (docs) | `general-purpose` | Plain markdown |
| J1-J5 (verification) | (no agent — orchestrator runs directly) | Verification is the dispatcher's job |

All agents listed exist in the project's roster per the available agents enumeration.

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|---|---|
| Feature branch specified | ❌ (Critical #3 fix needed) |
| Branch naming follows convention | ⚠️ Recommend `feat/v0.2.1-architecture-restructure` |
| Merge strategy documented | ❌ Plan doesn't say. Recommend: PR with `/gsd-pr-branch` for clean review (filters out `.planning/` per the user's CLAUDE.md tooling) |

### Commit checkpoints

Plan commits ~25 times across the 32 tasks. Natural boundaries:

1. Section A end → ESLint setup committed, passes baseline (3 commits)
2. Section B end → idempotency + audit migrated (2 commits, but B2 has 8 sub-steps in 1 commit — acceptable)
3. Section C end → auth + sessions extracted, schema composed (5 commits)
4. Section D end → staff migrated, backwards dep removed (2 commits)
5. Section E end → catalog + code fields added (4 commits)
6. Section F end → seed allocates codes, format tests pass (5 commits, minus F6 if dropped)
7. Section G end → frontend fully migrated (5 commits)
8. Section H end → API scaffold (2 commits)
9. Section I end → docs (5 commits)
10. Section J end → release commit + tag (1 commit + tag)

Total: ~32 commits. Granular, each one a logical unit. ✅

### Pre-push verification

- [x] `npm run build` — covered (Task J1 step 4)
- [x] `npm run typecheck` — covered (Task J1 step 1; also per-task)
- [x] `npm run lint` — covered (Task J1 step 3)
- [x] `npm test` — covered (Task J1 step 2; also per-task)
- [x] Manual smoke — covered (Task J3)

### CI/CD & rollback

| Concern | Status |
|---|---|
| Rollback strategy | ✅ via per-task atomic commits, `git revert` per task |
| Deployment order | ✅ schema → backend → frontend → docs |
| Data backup needed | ⚠️ Dev DB re-seeded in F4 (destructive); user's dev data is lost. Acceptable per the seed deny-list (prod is blocked) |
| Migration safety | ⚠️ See Critical #2 — F6 is unsafe as written |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|---|---|
| Task I1 | `docs/PUBLIC_API.md` (stub) |
| Task I2 | `docs/SCHEMA.md` (reframe) |
| Task I3 | `CLAUDE.md` (file locations) |
| Task I4 | `docs/ADR/034-...md` (logAudit clarification) |
| Task I5 | `docs/CHANGELOG.md` (v0.2.1 entry) |
| Task J5 | `docs/PROGRESS.md` (v0.2.1 shipped) + `package.json` version bump |

Comprehensive. ✅

### CHANGELOG draft (per plan's Task I5)

The plan's CHANGELOG draft is well-structured (Changed / Added / Deferred / Docs subsections). One amendment: if Critical #2 is resolved by dropping F6, the "Added — stable string identifiers" bullet should clarify:

> "**Stable string identifiers (optional in v0.2.1)** … fields are `v.optional(v.string())` and seed-populated; v0.3 promotes to required once `createStaff` gains allocation logic."

## 10. Testing Plan Assessment

**Verdict:** **Adequate, after Critical fixes.** Currently Critical #2 means the test suite breaks after Task F6 — that's a Critical issue against testing adequacy, not a missing test plan. If F6 is dropped (recommended), testing is Adequate.

### Planned tests

| Layer | What | Test type | Status |
|---|---|---|---|
| Custom ESLint rule | rule unit tests | RuleTester via vitest | ✅ planned (Task A2) |
| Schema composition | smoke deploy | `npx convex dev --once` | ✅ planned (Tasks C5, J2) |
| Module migrations | regression | existing 110 vitest tests | ✅ planned (per-task) |
| New code fields | format conformance | vitest + convex-test | ✅ planned (Task F5) |
| Frontend API rename | typecheck | tsc | ✅ planned (per Task G) |
| Manual smoke | activation → login → home | manual | ✅ planned (Task J3) |
| Telegram POC regression | manual + existing tests | manual | ✅ planned (Task J4) |

### Missing test coverage (must add per Improvements)

| # | Missing test | Why it matters | Approach |
|---|---|---|---|
| 1 | Windows-path ESLint rule fixture | User runs on win32; rule needs to work on both path separators | Add fixture in Task A2 test |
| 2 | audit_log row write verification in J3 | logAudit import path moved; verify writes still happen | Add J3 step 6 |
| 3 | Edge case: cross-tab session sync (existing test? unclear) | useSession uses listeners for cross-tab — verify still works after api rename | Should already be in `src/hooks/useSession.test.tsx` — verify it runs post-G1 |

### Test execution checkpoints

Plan already has checkpoints after each task. Section J runs the full suite. ✅

### Regression risk

- **Highest risk file:** `convex/audit.test.ts` + `convex/staff.test.ts` — both call `seedStaff` which goes through `_seedStaffCommit_internal`. If Critical #2 isn't fixed by dropping F6, these break catastrophically.
- **Medium risk:** `src/hooks/useSession.test.tsx` — exercises localStorage listeners + Convex query. Renaming the api path (Task G1) could break the mock setup if it hardcodes `api.auth.getSession` string.
- **Low risk:** `convex/__runtime_smoke__.test.ts` — fully standalone, doesn't touch the restructure surface.

## 11. Edge Cases to Address

- [ ] **Stale dev DB state:** if executor runs Tasks E2-E4 (adding optional code fields) but skips F4 (re-seed), then runs F5 tests — F5 expects seed to populate codes, but dev DB still has rows without codes from before E2. Mitigation: F5 calls `t.action(internal.seed.actions.reset)` inside each test, fresh fixture per case. ✅ Already covered.
- [ ] **Convex schema validator on optional → required flip:** if F6 lands and ANY existing row has `code: undefined`, deploy fails. Plan addresses via F4 re-seed prerequisite. But if executor uses a shared dev deployment (not local), other team members' work could have rows without codes. Document in F6 (or its replacement): "verify dev deployment has been re-seeded since E2-E4."
- [ ] **ESLint flat config + RuleTester compatibility on vitest:** see Improvement #7. Could be a 10-minute compatibility fix.
- [ ] **Convex codegen lag:** when `convex/auth.ts` is deleted (Task C3 step 4) but `convex/auth/public.ts` is created (Task C3 step 1), Convex codegen needs to regenerate `_generated/api`. If the executor's `npx convex dev` watcher isn't running, the generated types are stale. Add: "ensure `npx convex dev` watcher runs in a side terminal throughout the restructure" to Section B preamble.
- [ ] **Existing `convex/_generated/` directory** — plan doesn't touch but its contents change during the restructure (auto-regenerated). Ensure it's in `.gitignore` (verify) or commit the regenerated files alongside the source moves.
- [ ] **`__test_echo` / `__test_throw` exports from `convex/idempotency.ts`** — these test helpers were exported as `internalMutation`. After move to `idempotency/internal.ts`, their generated api path changes to `internal.idempotency.internal.__test_echo`. Any test that calls them needs the import update.

## 12. Approval Conditions

**To approve, address:**

1. **Critical #1**: add Task B1 step 2.5 (update imports in `auth.ts` / `staff.ts` after idempotency move). State the cross-module-move pattern at top of Section B.
2. **Critical #2**: drop Task F6 (keep `code` optional in v0.2.1). Document the deferral in the CHANGELOG draft (Task I5). v0.3 makes required when createStaff gains allocation logic. Alternative if you want required in v0.2.1: F6 expands to also update `_seedStaffCommit_internal`, `_createStaffCommit_internal`, and every raw `ctx.db.insert("staff", ...)` in tests to allocate a code — but this triples F6's complexity for marginal gain.
3. **Critical #3**: add Task A0 (create feature branch `feat/v0.2.1-architecture-restructure`).

**Recommended before implementation:**

1. Improvement #1: `__runtime_smoke__.test.ts` placement decision.
2. Improvement #2: section-level pattern statement.
3. Improvement #3: Windows-path test fixture for ESLint rule.
4. Improvement #4: J3 audit_log verification step.
5. Improvement #7: RuleTester + vitest compatibility note.

**Once Approved:**

1. Apply the three Critical fixes to the plan file in-place.
2. Run `/staffreview` once more is optional — the fixes are surgical and verifiable by inspection.
3. Dispatch via subagent-driven-development per the plan's execution handoff.

---

*Generated by /staffreview*
