# Staff Review: Dev device pre-registration (spec)

**Date:** 2026-06-02
**Plan:** `docs/superpowers/specs/2026-06-02-dev-device-seed-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (it's a design spec; phases/waves implicit — fine at this stage)

---

## 1. Summary

**Overall Assessment:** Revise (one Critical, two Improvements)

The design is sound and minimal, and the core insight (gate is frontend-only; login
never checks device registration) is verified correct. But the chosen DEV gate
(`import.meta.env.DEV`) is **true under vitest** — it would silently activate the
short-circuit inside the test runner and break the entire existing
`useDeviceId.test.ts` suite. Two smaller gaps: there is no existing `reset` test to
extend, and `_reset_internal` currently discards the manager's inserted id that the
device row needs for `activated_by`.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `import.meta.env.DEV` is `true` under vitest → DEV short-circuit fires in tests, breaking `useDeviceId.test.ts` | Logic/Testing | Spec §"Changes" #2 |

### Issue 1: DEV gate fires inside the test runner

Empirically probed in this worktree:

```
ENVPROBE {"DEV":true,"PROD":false,"MODE":"test"}
```

`useDeviceId.test.ts` asserts the hook returns `null` first, then a UUID matching
`/^[0-9a-f-]{36}$/`, persists to IDB, and recovers from localStorage. If the hook
short-circuits when `import.meta.env.DEV` is true, **all four of those tests run with
the short-circuit active** and receive the constant `"dev-booth-device"` instead — the
whole suite fails.

**Recommendation:** Gate on `import.meta.env.MODE === "development"` instead of `DEV`.

| Context | `MODE` | Short-circuit |
|---|---|---|
| `npm run dev` (vite) | `"development"` | **ON** (intended) |
| `vitest` | `"test"` | off (existing tests stay green) |
| `vite build` (prod) | `"production"` | off (prod untouched) |

This is more precise than `DEV` anyway: it targets the dev *server* specifically, which
is exactly the Chrome-MCP scenario. Update the spec's §2 and the "Implementation note"
accordingly.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | No `reset` test exists — plan must CREATE `convex/seed/__tests__/reset.test.ts`, not "extend" | M | L |
| 2 | `_reset_internal` discards the manager insert id needed for `activated_by` | M | L |

### Improvement 1: There is no existing reset test

The only seed test is `bootstrap.test.ts`. The spec's testing section says "keep the
existing seed suite green (the `inserted` count assertion, if any...)" — there is **no**
reset test and **no** `inserted`-count assertion anywhere. So the plan must *create* a
focused reset test rather than extend one. Recommended: `convex/seed/__tests__/reset.test.ts`
with a test that runs `internal.seed.actions.reset` (or `_reset_internal` directly with
dummy hashes, the lighter path — no argon2 action needed) and asserts exactly one active
`registered_devices` row exists with `device_id === "dev-booth-device"` and a valid
`activated_by`. Note: `reset` (the action) is prod-guarded by `CONVEX_CLOUD_URL`; under
convex-test that env is absent so it passes the guard — either path works, but calling
`_reset_internal` directly avoids the two argon2 hash actions and is faster.

### Improvement 2: Capture the manager id for `activated_by`

`registered_devices.activated_by` is `v.id("staff")` (required, not optional). In
`_reset_internal` the manager insert at `convex/seed/internal.ts:55` discards its return:

```ts
await ctx.db.insert("staff", { name: "Lucas", code: mgrCode, ... });
```

The plan must change this to capture the id:

```ts
const lucasId = await ctx.db.insert("staff", { name: "Lucas", code: mgrCode, ... });
```

and insert the device row **after** that line (so `lucasId` exists), incrementing
`inserted`. The spec pseudo-code already references `lucasId` — just make the capture
explicit in the plan.

## 4. Refinements (Optional)

- **`storage-keys.ts` is a *key* namespace, not a value store.** Its header says "Every
  key the app sets in window.localStorage MUST be declared here." `DEV_DEVICE_ID` is a
  device-id *value*, not a localStorage key. Placing it there is convenient (the hook
  already imports `DEVICE_ID_KEY` from it) but slightly off-semantic. Either add a one-line
  comment distinguishing it ("dev-only fixed device-id value, not a storage key") or accept
  the minor stretch. Low stakes.
- The DEV branch can be unit-tested with `vi.stubEnv("MODE", "development")` before
  `renderHook` — asserts the hook returns `"dev-booth-device"`. Optional; the branch is
  dev-only tooling. If added, restore env in `afterEach` (the suite already uses
  `vi.unstubAllEnvs` patterns elsewhere).

## 5. Duplication Analysis

No duplication. The change reuses the existing `registered_devices` table, the existing
wipe loop, and the existing `storage-keys.ts` module. `_devMintSetupCode_internal`
correctly retained as the escape hatch rather than re-implemented.

## 6. Phase / Wave Accuracy

Single slice, three edits — no wave ordering concerns. Natural order: (1) shared constant,
(2) `useDeviceId` gate, (3) seed insert + test. Frontend and backend edits are independent
and could be done in either order.

## 7. Specialist Agent Recommendations

None needed — small, self-contained change. Default implementer is fine.

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `dev-device-seed` (worktree off main) |
| Squash-merge convention | ✅ per repo |
| Pre-push build/typecheck | ⚠️ Add `npm run typecheck` + `npx vitest run convex/seed src/hooks/useDeviceId.test.ts` to plan success criteria |
| Atomic commits | ✅ one commit suffices (small) |

## 9. Documentation Checkpoints

- `docs/CHANGELOG.md` — add a dev-tooling entry (per CLAUDE.md "How to add a feature" #9).
- CLAUDE.md "Auth" / seed notes — optional one-liner that `seed:reset` now pre-registers
  `dev-booth-device` so dev skips `/activate`. Recommended (helps the next agent).
- No `SCHEMA.md` change (no schema change — reuses `registered_devices`).

## 10. Testing Plan Assessment

**Verdict:** Insufficient as written → Adequate after fixes (Critical #1 + Improvement #1).

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `_reset_internal` seeds device row | convex-test | **create** `reset.test.ts` |
| Frontend | `useDeviceId` UUID path still works | vitest | exists — must stay green (Critical #1) |
| Frontend | `useDeviceId` DEV branch returns constant | vitest + stubEnv | optional (Refinement) |

### Regression risk
- **`useDeviceId.test.ts`** is the live regression — directly addressed by the MODE gate.
- No other suite reads `import.meta.env.MODE`/`DEV` for behavior.

## 11. Edge Cases to Address

- [x] Re-running `reset` → `registered_devices` already in wipe list (`internal.ts:28`), so
      no duplicate rows. Verified.
- [x] Fresh incognito/MCP profile with empty IDB → MODE gate returns constant before any
      IDB read. Verified by design.
- [x] Prod build → MODE `"production"`, gate off, UUID logic intact. Verified.
- [ ] Confirm `npm run dev` MODE is `"development"` (Vite default; no `--mode` override in
      `package.json` scripts — verify during implementation).

## 12. Approval Conditions

**To approve, address:**
1. Critical #1 — switch DEV gate to `import.meta.env.MODE === "development"`.

**Recommended before implementation:**
1. Improvement #1 — create `convex/seed/__tests__/reset.test.ts`.
2. Improvement #2 — capture `lucasId` for `activated_by`.

---

*Generated by /staffreview*
