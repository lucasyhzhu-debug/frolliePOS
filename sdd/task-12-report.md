# Task 12 — /simplify cleanups (v1.3.0 owner cockpit)

**Date:** 2026-06-26  
**Worktree:** `D:/Claude/FrolliePOS/.claude/worktrees/v13-cockpit`

---

## Items applied (A–H)

**A — Drop `consolidatedSummary`; derive headline client-side**  
Deleted `consolidatedSummary` query from `convex/cockpit/dashboard.ts`. Added `refundTotal: s.refundsTotal` to `perOutletSummary` (return type updated). `src/routes/cockpit/index.tsx`: removed `consolidated` useQuery; compute `consolidatedData` by reducing over `perOutlet` rows; loading gates on single query. Updated `convex/cockpit/__tests__/dashboard.test.ts` (removed 3 consolidatedSummary tests; added `refundTotal: 0` assertions to perOutletSummary test). Updated `src/routes/cockpit/__tests__/index.test.tsx` (removed `CONSOLIDATED` fixture; added `refundTotal` to outlet fixtures; simplified `setLoadedQueries` to no-alternate). Updated `docs/API_REFERENCE.md` and `docs/CHANGELOG.md`.

**B — Reuse `useOutletContext().outlets` instead of re-subscribing**  
`outlets/index.tsx`: replaced `useQuery(listOutlets)` + `useSession` + sessionId derivation + early loading return with `const { outlets } = useOutletContext()`. Removed `useQuery`, `api`, `useSession` imports. `outlets/new/index.tsx`: added `outlets` to the existing `useOutletContext()` destructure; removed `listOutlets` useQuery call. Updated both test files: `outlets/__tests__/index.test.tsx` replaced convex/react `useQuery` mock with `useOutletContext` mock; `outlets/new/__tests__/index.test.tsx` simplified `setupDefaultQueries` to return staff only (no alternating).

**C — Extract `stepSlideVariants` to `src/lib/motion.ts`**  
Added `export const stepSlideVariants = (dir: 1 | -1, reduce: boolean) => ({...})` to `src/lib/motion.ts`. Removed local `mkVariants` from `outlets/new/index.tsx`; added `import { stepSlideVariants } from "@/lib/motion"` and replaced `mkVariants(dir, reduce)` with `stepSlideVariants(dir, reduce)`.

**D — Collapse 11 SET_* actions into one SET_FIELD**  
`WizardAction` union reduced from 11 individual action types to one `{ type: "SET_FIELD"; field: <12 string/bool keys>; value: string | boolean }`. Reducer case: `return { ...s, [a.field]: a.field === "code" ? String(a.value).toUpperCase() : a.value }`. All 11 dispatch call-sites updated. `SET_MODE`, `SET_SOURCE`, `TOGGLE_STAFF_ID` kept as distinct actions.

**E — `canNext`: drop `useMemo`, use plain `const`**  
Replaced `useMemo(() => {...}, [...deps])` with a ternary chain. Removed `useMemo` from React imports.

**F — `cloneCatalogRows`: remove redundant sku/product counters**  
Removed `let skuCount = 0`/`skuCount++` and `let productCount = 0`/`productCount++` from loops. Return statement now uses `skus.length`/`products.length` directly. `componentCount` preserved (its loop has a dangling-FK `continue`).

**G — Keepalive focus min-interval gate**  
Added `useRef` to React import. Added `const lastPingedAtRef = useRef<number>(0)` in `CockpitShell`. `ping` now guards with `if (Date.now() - lastPingedAtRef.current < 60_000) return` and sets `lastPingedAtRef.current = Date.now()` on success. Prevents DB write on every window focus.

**H — `seedSettingsRow`: apply undefined-key filter**  
Mirrors `cloneSettingsRow` sibling: filters `undefined`-valued entries from `values` into `cleanValues` before spread, and uses hardcoded `founders_summary_enabled: true` base default instead of `values.founders_summary_enabled ?? true` (correct: non-undefined value in cleanValues overrides the default; undefined value no longer clobbers it).

---

## Gate results

| Gate | Result |
|---|---|
| `npx convex codegen` | CLEAN |
| `npm run typecheck` (tsc -b + tsc -p convex) | CLEAN (0 errors) |
| `npx vitest run convex/cockpit convex/catalog convex/settings src/routes/cockpit src/contexts` | **131/131 PASS** |
| `npx eslint <8 changed files>` | 0 errors, 8 pre-existing warnings (destructure-to-omit `outlet_id`/`created_at`/`updated_at`/`updated_by` — not introduced by this task) |
