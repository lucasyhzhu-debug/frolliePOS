# `useSession` Transient-Null Fix (issue #44) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `useSession` from wiping `localStorage` on a transient `null` from `useQuery(getSession)` during the Convex WS resubscribe window after a hard-nav, so PIN-gated e2e specs run un-skipped and real users aren't bounced to `/login` after a reload.

**Architecture:** Replace the `isDead`-derived effect in `src/hooks/useSession.ts` with a debounced `setTimeout` (constant `DEAD_SESSION_CONFIRM_MS = 1500`). The effect's cleanup-on-deps-change cancels the timer if `validation` flips back to a real session (transient) or back to `undefined` (defensive). Only a *sustained* null past 1500ms clears `localStorage`. Remove the `e2e/fixtures.ts` 1500ms warm-up workaround and revert `test.skip` → `test` on the 6 PIN-gated specs.

**Tech Stack:** React 19 + TypeScript, Vite, Convex 1.31.7 (`useQuery` from `convex/react`), vitest 1.x + `@testing-library/react` + fake timers (`vi.useFakeTimers()`, `vi.hoisted()`), Playwright (`@playwright/test`).

**Spec:** `docs/superpowers/specs/2026-06-05-useSession-transient-null-fix-design.md`
**Staffreview (spec):** `docs/reviews/staffreview-usesession-transient-null-fix-spec-2026-06-05.md`
**Tracking:** GitHub issue #44 · supersedes the `test.skip` layer (PR #43) and the 1500ms warm-up (PR #41).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/hooks/useSession.ts` | Session state + localStorage layer | Modify — add `DEAD_SESSION_CONFIRM_MS`, replace `isDead` effect with debounced `setTimeout`, replace stale "Fix V17" comment |
| `src/hooks/useSession.test.tsx` | Unit coverage for the hook | Modify — rewrite mock plumbing to `vi.hoisted()` + controllable `vi.fn()`; add 5 timing tests; keep existing 3 |
| `e2e/fixtures.ts` | Playwright `signedInAsLucas` / `signedInAsStaff` fixtures | Modify — delete the trailing `page.waitForTimeout(1500)` + the 4-line comment block above it |
| `e2e/specs/refund.spec.ts` | Refund spec | Modify — `test.skip` → `test`; delete the 9-line `// SKIPPED:` block |
| `e2e/specs/sale-bca-va.spec.ts` | BCA VA sale spec | Modify — `test.skip` → `test`; delete the 2-line `// SKIPPED:` block |
| `e2e/specs/sale-qris.spec.ts` | QRIS sale spec | Modify — same |
| `e2e/specs/spoilage.spec.ts` | Spoilage spec | Modify — same |
| `e2e/specs/voucher-offline.spec.ts` | Voucher offline spec | Modify — same |
| `e2e/specs/voucher-online.spec.ts` | Voucher online spec | Modify — same |
| `docs/CHANGELOG.md` | User-facing release notes | Modify — one-line entry under v0.5.8 (or v0.5.7.1) citing issue #44 |

**Naming used consistently across tasks** (self-review checked):
- Module constant: `DEAD_SESSION_CONFIRM_MS` (number, 1500).
- Mock hoist: `mockUseQuery` (a `vi.fn()`).
- Test ids: `"s_seed"` (a fake `Id<"staff_sessions">` string) and `"st_seed"` (fake `Id<"staff">`).
- Storage key: `SESSION_KEY` (already exported from `@/lib/storage-keys`).

---

## Task 0: Verify the null-hypothesis with one CI pass (instrument → confirm → strip)

The spec's Decision #6 mandates this. If empirically `validation` only goes `undefined → realSession` during the WS resubscribe (never transiently `null`), the debounced-timeout fix is a no-op for the e2e symptom and Option A is the wrong shape. One throwaway CI pass before writing the fix proves or disproves it cheaply.

**Files:**
- Modify: `src/hooks/useSession.ts` (temporary instrumentation block; reverted at end of task)

- [ ] **Step 1: Add temporary instrumentation in `useSession`**

After the `const validation = useQuery(...)` line (currently `src/hooks/useSession.ts:42-45`), add a debug block. Two-channel: `console.warn` (visible in Playwright trace) AND a `sessionStorage` ring buffer (read by a one-off Playwright assertion if console capture is noisy in CI):

```typescript
// TEMP issue #44: prove the transient-null hypothesis. Strip before final commit.
useEffect(() => {
  const tag = `[useSession#44] stored=${stored ? "Y" : "N"} validation=${
    validation === undefined ? "undefined" : validation === null ? "null" : "object"
  }`;
  console.warn(tag);
  try {
    const ring = JSON.parse(sessionStorage.getItem("__issue44_ring") ?? "[]") as string[];
    ring.push(`${Date.now()}|${tag}`);
    sessionStorage.setItem("__issue44_ring", JSON.stringify(ring.slice(-20)));
  } catch {
    // sessionStorage unavailable / quota — fine, console.warn is enough
  }
}, [stored, validation]);
```

- [ ] **Step 2: Commit the instrumentation on a draft-PR branch**

```bash
git add src/hooks/useSession.ts
git commit -m "chore(temp): instrument useSession transitions for issue #44 verification"
git push -u origin worktree-plan-issue-44-usesession-fix
gh pr create --draft --title "chore(temp): #44 hypothesis verification" \
  --body "Draft for one CI pass to confirm useQuery transient null. Will be stripped before the real fix lands. Tracks #44."
```

- [ ] **Step 3: Wait for the e2e workflow run (≈8-12 min)**

The `e2e` workflow runs on PR (`.github/workflows/e2e.yml:6`). Watch:

```bash
gh pr checks --watch
```

Expected: 7 specs continue to fail with the original symptom (still `test.skip`-ed today, so they pass-as-skipped; only `auth.spec.ts` runs in earnest). The instrumentation runs on every page load of every spec — the warns + ring buffer appear in any spec that loads `/`.

- [ ] **Step 4: Read the Playwright trace / artifact for proof**

Download the `playwright-report` artifact for any spec that calls `page.goto("/")`:

```bash
gh run download <run-id> -n playwright-report
```

Open `playwright-report/index.html` → any spec's trace → "Console" tab. **Look for the warn pattern after the post-login `page.goto(...)`:**

- ✅ Confirms spec: trace contains `[useSession#44] stored=Y validation=null` AT LEAST ONCE between the post-login `page.goto` and the `/login` redirect. → Proceed to Task 1.
- ❌ Refutes spec: trace ONLY shows `validation=undefined` (never `null`) between `page.goto` and the redirect, OR the storage ring buffer (read via `await page.evaluate(() => sessionStorage.getItem("__issue44_ring"))`) shows no `null` entries. → **STOP. Do not proceed.** The Option A debounce is the wrong shape. Escalate to the spec author with the trace — root cause is elsewhere (e.g., `RootLayout`'s `deviceRegistered === undefined` flip, or a router race).

If `auth.spec.ts` alone is insufficient (it does a single login flow, no `page.goto` after), temporarily un-skip one cheap spec (`sale-qris.spec.ts` is the simplest) just to drive the post-login navigation — revert the un-skip at the end of this task.

- [ ] **Step 5: Strip the instrumentation**

Remove the entire instrumentation block from `src/hooks/useSession.ts` (no traces left in code). If a spec was temporarily un-skipped in Step 4, revert that.

```bash
git add src/hooks/useSession.ts
git commit -m "chore(temp): revert #44 instrumentation — hypothesis confirmed"
```

(Or if Step 4 refuted the hypothesis, this entire plan is invalidated — see Rollback section.)

- [ ] **Step 6: Note the result in the PR**

Comment on the draft PR with a one-liner: "Confirmed: `validation === null` appears at <timestamp> between post-login `page.goto` and the redirect (run #<id>, spec <name>)." Keep the PR draft; subsequent tasks add the real fix and convert it to ready.

---

## Task 1: Add `DEAD_SESSION_CONFIRM_MS` constant + debounced effect (TDD)

**Files:**
- Modify: `src/hooks/useSession.ts` (replace lines 47-55 + add module-level constant)
- Test: `src/hooks/useSession.test.tsx` (mock plumbing rewrite — Task 2 adds tests; this task makes the mock controllable so the existing tests still pass)

- [ ] **Step 1: Rewrite the mock plumbing to `vi.hoisted()` (existing 3 tests stay green)**

Replace `src/hooks/useSession.test.tsx:1-10` with:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Hoisted so the vi.mock factory (which is itself hoisted above imports) can
// reference a mutable mock fn without relying on initialization order.
const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn<[], unknown>().mockReturnValue(undefined),
}));
vi.mock("convex/react", () => ({
  useQuery: mockUseQuery,
}));

import { useSession, storeSession, clearSession } from "./useSession";
import { SESSION_KEY } from "@/lib/storage-keys";
```

Then in the existing `beforeEach` block (currently `useSession.test.tsx:17-21`), reset the mock to the default before each test:

```typescript
beforeEach(() => {
  localStorage.clear();
  clearSession();
  mockUseQuery.mockReturnValue(undefined); // reset to "loading"
});
```

- [ ] **Step 2: Run the existing 3 tests — verify they still pass**

```bash
npx vitest run src/hooks/useSession.test.tsx
```

Expected: all 3 existing tests PASS. The mock plumbing rewrite is a no-op for them because the default return value remains `undefined`.

- [ ] **Step 3: Write the first failing test (sustained null clears after 1500ms)**

Add to `src/hooks/useSession.test.tsx`, inside the `describe(...)` block, after the existing 3 tests:

```typescript
describe("useSession (debounced dead-session clear)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears localStorage when validation stays null for ≥1500ms", async () => {
    // Seed localStorage so useState initializer reads a stored session id.
    localStorage.setItem(SESSION_KEY, "s_seed");
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() => useSession());

    // Hook returns "none" because validation is null; the debounced effect
    // schedules a clear at +1500ms.
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed");

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(result.current.status).toBe("none");
  });
});
```

- [ ] **Step 4: Run the new test — verify it FAILS**

```bash
npx vitest run src/hooks/useSession.test.tsx -t "clears localStorage when validation stays null"
```

Expected: FAIL. The existing `isDead`-derived effect clears `localStorage` SYNCHRONOUSLY on first render (no 1500ms wait), so the first assertion `expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed")` fails — the seed is already gone before `vi.advanceTimersByTime`.

This failure is exactly what proves the bug exists: the current code clears too eagerly.

- [ ] **Step 5: Implement the fix in `useSession.ts`**

Replace `src/hooks/useSession.ts:7-13` (the existing `// Module-level subscriber set…` comment block + helpers) with the same code preceded by the new constant:

```typescript
// Issue #44: confirm an apparent dead session for this long before wiping
// localStorage. During Convex WS resubscribe after a hard-nav (e.g.,
// page.goto in Playwright; full reload in a real browser), `useQuery(getSession)`
// transiently yields `null` before the real session row resolves. Trusting that
// `null` immediately wipes localStorage → next render shows status:"none" →
// RootLayout redirects to /login, even though the real session is healthy.
// This constant supersedes the `page.waitForTimeout(1500)` workaround
// formerly in e2e/fixtures.ts:awaitSignedIn (PR #41).
const DEAD_SESSION_CONFIRM_MS = 1500;

// Module-level subscriber set for same-tab sync.
// The `storage` event only fires in OTHER tabs; we need this for same-tab.
const listeners = new Set<(value: string | null) => void>();

function notify(value: string | null) {
  listeners.forEach((cb) => cb(value));
}
```

Then replace `src/hooks/useSession.ts:47-55` (the `// Fix V17:` comment + `isDead` derivation + effect) with:

```typescript
  // Debounce the dead-session clear (issue #44). On every change of stored or
  // validation, the cleanup cancels any pending clear; only a `validation: null`
  // that survives `DEAD_SESSION_CONFIRM_MS` is treated as ground truth. Handles:
  //   - transient null during WS resubscribe → cancelled when validation flips
  //     back to the real session object (or back to undefined defensively),
  //   - genuine logged-out-elsewhere (real session → null) → fires after 1500ms.
  // Manual `clearSession()` / `logout` clear directly; they don't depend on
  // this effect.
  useEffect(() => {
    if (stored == null || validation !== null) return;
    const t = setTimeout(() => {
      localStorage.removeItem(SESSION_KEY);
      notify(null);
    }, DEAD_SESSION_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [validation, stored]);
```

- [ ] **Step 6: Run the new test — verify it PASSES**

```bash
npx vitest run src/hooks/useSession.test.tsx -t "clears localStorage when validation stays null"
```

Expected: PASS.

- [ ] **Step 7: Run ALL `useSession` tests — verify all 4 PASS**

```bash
npx vitest run src/hooks/useSession.test.tsx
```

Expected: 4 PASS (3 existing + 1 new). Existing tests still green because their mock value is `undefined` (early-return path).

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: clean — no new errors.

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useSession.ts src/hooks/useSession.test.tsx
git commit -m "$(cat <<'EOF'
fix(useSession): debounce dead-session clear (issue #44)

Replaces the isDead-derived effect with a setTimeout(clear, 1500ms) whose
cleanup cancels on every [validation, stored] change. Avoids wiping
localStorage on a transient null from useQuery(getSession) during the
Convex WS resubscribe window after a hard-nav, which was bouncing users
to /login despite a healthy session.

Mock plumbing in useSession.test.tsx switched to vi.hoisted() + a
controllable vi.fn() so subsequent timing tests (next commits) can drive
useQuery return values across renders. Existing 3 tests stay green.

Refs #44.
EOF
)"
```

---

## Task 2: Add the 4 remaining timing tests

**Files:**
- Test: `src/hooks/useSession.test.tsx`

- [ ] **Step 1: Add test — "transient null is ignored"**

Inside the `describe("useSession (debounced dead-session clear)", …)` block, after the test added in Task 1:

```typescript
  it("ignores a transient null that flips back to a real session within 1500ms", async () => {
    localStorage.setItem(SESSION_KEY, "s_seed");
    mockUseQuery.mockReturnValue(null);

    const { result, rerender } = renderHook(() => useSession());
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed");

    // 500ms in — timer still pending, nothing cleared yet.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed");

    // Validation flips to a real session — cleanup runs, timer cancelled.
    mockUseQuery.mockReturnValue({
      sessionId: "s_seed",
      staff: { _id: "st_seed", name: "Lucas", role: "manager" },
      deviceId: "dev-x",
      startedAt: 0,
    });
    act(() => {
      rerender();
    });

    // Advance well past the original deadline — nothing should have cleared.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed");
    expect(result.current.status).toBe("active");
  });
```

- [ ] **Step 2: Add test — "real → null transition honoured"**

```typescript
  it("clears localStorage on a real-session → null transition after 1500ms", async () => {
    localStorage.setItem(SESSION_KEY, "s_seed");
    mockUseQuery.mockReturnValue({
      sessionId: "s_seed",
      staff: { _id: "st_seed", name: "Lucas", role: "manager" },
      deviceId: "dev-x",
      startedAt: 0,
    });

    const { result, rerender } = renderHook(() => useSession());
    expect(result.current.status).toBe("active");

    // Server-side row goes away (e.g., logged out elsewhere).
    mockUseQuery.mockReturnValue(null);
    act(() => {
      rerender();
      vi.advanceTimersByTime(1500);
    });

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(result.current.status).toBe("none");
  });
```

- [ ] **Step 3: Add test — "clearSession mid-pending-timer doesn't race"**

```typescript
  it("cancels the pending clear when clearSession is called mid-window", async () => {
    localStorage.setItem(SESSION_KEY, "s_seed");
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() => useSession());

    // 500ms in — pending timer not yet fired, seed still present.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed");

    // User locks. clearSession synchronously removes the key + notifies
    // listeners. The effect cleanup then runs because `stored` flips Y → N,
    // cancelling the pending setTimeout.
    act(() => {
      clearSession();
    });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(result.current.status).toBe("none");

    // Advance past the original 1500ms deadline. The cancelled timer must
    // not produce any observable effect (storage stays empty, status stays
    // "none"). If it leaked through, this would re-call notify(null), which
    // is idempotent for state but would expose a bug if any side-effect
    // were ever added to the timer body.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(result.current.status).toBe("none");
  });
```

- [ ] **Step 4: Add test — "storeSession(newId) mid-pending-timer cancels the clear"**

```typescript
  it("cancels the pending clear when storeSession is called mid-window", async () => {
    localStorage.setItem(SESSION_KEY, "s_old");
    mockUseQuery.mockReturnValue(null);

    renderHook(() => useSession());

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_old");

    // Fresh login mid-window — storeSession writes the new id and notifies.
    // The effect's cleanup cancels the pending clear because `stored` changes
    // from "s_old" → "s_new".
    act(() => {
      storeSession(
        "s_new",
        "st_new" as import("../../convex/_generated/dataModel").Id<"staff">,
      );
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // The new session id must survive past the original deadline.
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_new");
  });
```

- [ ] **Step 5: Run all useSession tests**

```bash
npx vitest run src/hooks/useSession.test.tsx
```

Expected: 8 PASS (3 existing + 1 from Task 1 + 4 from this task). No act-warnings in output.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSession.test.tsx
git commit -m "$(cat <<'EOF'
test(useSession): add 4 debounced-clear timing tests (issue #44)

Covers: transient null ignored, real→null transition honoured, clearSession
mid-pending-timer race, storeSession(newId) mid-pending-timer cancellation.
All wrap vi.advanceTimersByTime in act(); fake timers cleared in afterEach.

Refs #44.
EOF
)"
```

---

## Task 3: Remove the fixture workaround

**Files:**
- Modify: `e2e/fixtures.ts:37-41`

- [ ] **Step 1: Open `e2e/fixtures.ts` and delete lines 37-41**

The block to remove (exact current content):

```typescript
  // Convex client warm-up window. Without this, the next page.goto in the test
  // can trigger a transient null on the session-validation query during WS
  // reconnect → useSession.isDead effect clears localStorage → next render
  // redirects to /login. Empirically reproduced on every signedIn fixture spec.
  await page.waitForTimeout(1500);
```

After deletion, `awaitSignedIn` ends with the URL assertion (line 36 in the current file: `await expect(page).not.toHaveURL(/\/login/, { timeout: 2_000 });`).

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures.ts
git commit -m "$(cat <<'EOF'
fix(e2e): drop awaitSignedIn warm-up sleep — superseded by useSession debounce

The hook now handles the transient-null race correctly (issue #44 fix in
src/hooks/useSession.ts), so the 1500ms fixture-level workaround introduced
in PR #41 is dead weight (a 1.5s tax on every signedIn spec).

Refs #44.
EOF
)"
```

---

## Task 4: Un-skip the 6 PIN-gated e2e specs

Each spec gets the same two changes: `test.skip(...)` → `test(...)`, and the leading `// SKIPPED:` comment block deleted. `refund.spec.ts` has a 9-line block; the other 5 have a 2-line block.

**Files:**
- Modify: `e2e/specs/refund.spec.ts:4-12` (delete the 9-line block) + the `test.skip` on line 13
- Modify: `e2e/specs/sale-bca-va.spec.ts:4-5` (delete the 2-line block) + the `test.skip`
- Modify: `e2e/specs/sale-qris.spec.ts:4-5` (delete the 2-line block) + the `test.skip`
- Modify: `e2e/specs/spoilage.spec.ts:3-4` (delete the 2-line block) + the `test.skip`
- Modify: `e2e/specs/voucher-offline.spec.ts:4-5` (delete the 2-line block) + the `test.skip`
- Modify: `e2e/specs/voucher-online.spec.ts:4-5` (delete the 2-line block) + the `test.skip`

- [ ] **Step 1: Un-skip `e2e/specs/refund.spec.ts`**

Delete lines 4-12 (the entire `// SKIPPED:` block, which spans from "SKIPPED: session-loss-on-hard-nav…" through "the refunds module's other unit tests."). Then on the next line, change:

```typescript
test.skip("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
```

to:

```typescript
test("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
```

- [ ] **Step 2: Un-skip `e2e/specs/sale-bca-va.spec.ts`**

Delete the 2-line `// SKIPPED:` block (currently lines 4-5). Change `test.skip("BCA VA sale:…` to `test("BCA VA sale:…`.

- [ ] **Step 3: Un-skip `e2e/specs/sale-qris.spec.ts`**

Delete the 2-line `// SKIPPED:` block. Change `test.skip("QRIS sale:…` to `test("QRIS sale:…`.

- [ ] **Step 4: Un-skip `e2e/specs/spoilage.spec.ts`**

Delete the 2-line `// SKIPPED:` block (currently lines 3-4). Change `test.skip("spoilage (booth):…` to `test("spoilage (booth):…`.

- [ ] **Step 5: Un-skip `e2e/specs/voucher-offline.spec.ts`**

Delete the 2-line `// SKIPPED:` block. Change `test.skip("voucher (offline):…` to `test("voucher (offline):…`.

- [ ] **Step 6: Un-skip `e2e/specs/voucher-online.spec.ts`**

Delete the 2-line `// SKIPPED:` block. Change `test.skip("voucher (online):…` to `test("voucher (online):…`.

- [ ] **Step 7: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add e2e/specs/refund.spec.ts e2e/specs/sale-bca-va.spec.ts e2e/specs/sale-qris.spec.ts e2e/specs/spoilage.spec.ts e2e/specs/voucher-offline.spec.ts e2e/specs/voucher-online.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): un-skip 6 PIN-gated specs after useSession fix (issue #44)

The session-loss-on-hard-nav race that justified test.skip in PR #43 is
fixed by the debounced clear in src/hooks/useSession.ts. Reverts the skip
layer + deletes the tracking-note blocks.

Specs: refund, sale-bca-va, sale-qris, spoilage, voucher-offline,
voucher-online.

Closes #44.
EOF
)"
```

---

## Task 5: CHANGELOG entry + open PR for ready review

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Decide the version line**

Default: **v0.5.8** (bug-only fast follow under its own version). If the team is batching this with a separate v0.5.7 patch series, use **v0.5.7.1** instead. Check `docs/CHANGELOG.md` head + recent `git log --oneline -10` to see what's already in flight. Pick one before editing.

- [ ] **Step 2: Insert the entry**

Open `docs/CHANGELOG.md`. Above the most recent version header, add:

```markdown
## v0.5.8 — 2026-06-?? — bug fix

### Fixed
- `useSession`: debounced the "session-dead" effect so a transient `null` from
  the Convex session-validation query during WS resubscribe (after hard-nav)
  no longer wipes `localStorage` and bounces the user to `/login`. Unblocks
  the 6 PIN-gated e2e specs that were `test.skip`-ed in PR #43, and drops
  the 1500ms fixture-level warm-up introduced in PR #41. (issue #44)
```

Fill in the actual date when shipping.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean (CHANGELOG is markdown — no impact, but run for completeness).

- [ ] **Step 4: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v0.5.8 — useSession transient-null fix (issue #44)"
```

- [ ] **Step 5: Push and convert the draft PR to ready**

```bash
git push
gh pr ready
```

The e2e workflow runs automatically. **Acceptance signal: all 8 specs green** (was 1 passed / 7 skipped per workflow run #27001616950).

- [ ] **Step 6: Watch the e2e workflow**

```bash
gh pr checks --watch
```

If any of the 6 newly-un-skipped specs fail with a Convex / payment / inventory error UNRELATED to session-loss-on-hard-nav, that's a different bug — surface it on the PR, don't re-skip blindly. The acceptance criterion is "the session race is fixed", not "every spec passes regardless of pre-existing flake".

---

## Success Criteria

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npx vitest run src/hooks/useSession.test.tsx` — 8 tests pass (3 existing + 5 new).
- [ ] `npm run test` — full vitest suite green (no regression elsewhere).
- [ ] `e2e` GH Action workflow on the PR: all 8 specs green (`auth.spec.ts` + the 6 un-skipped + any others).
- [ ] No `test.skip` remaining in `e2e/specs/*.spec.ts` (except `auth.spec.ts:24` which is the unrelated 60s-lockout long-wait skip — leave it).
- [ ] `e2e/fixtures.ts:awaitSignedIn` no longer calls `page.waitForTimeout(1500)`.
- [ ] `src/hooks/useSession.ts` has the `DEAD_SESSION_CONFIRM_MS` constant and the debounced-effect block; the "Fix V17" comment is gone.
- [ ] `docs/CHANGELOG.md` has the v0.5.8 entry.

## Rollback

If Task 0 refutes the null hypothesis (`validation` is only ever `undefined`, never `null`, between `page.goto` and the redirect):

- **STOP this plan immediately.** Do not write the Task 1 fix.
- Commit the Task 0 strip commit (so the temporary instrumentation is fully removed).
- Comment on the draft PR with the refutation evidence and close it without merging.
- File a follow-up: the actual root cause is elsewhere — likely candidates are `RootLayout`'s `deviceRegistered === undefined` race during reload, `useDeviceId`'s IDB read returning null transiently, or a Convex-client reconnect mode that leaves `validation` stuck at the previous value rather than re-firing. None of those is fixed by debouncing here.

If Task 1's fix lands but the e2e workflow still fails on session loss:

- `git revert` Task 1's commit (the `fix(useSession): debounce…` commit) and Task 3's commit (the fixture sleep removal). This restores the prior behaviour: `e2e/fixtures.ts` regains the 1500ms warm-up; the `isDead` effect goes back to immediate clear. Specs go back to flake-prone but pre-PR-#43 specs at least pass with the fixture sleep restored. Re-investigate via the Task 0 instrumentation, kept around in the draft PR history.

If the hook fix is right but a different e2e spec fails for an unrelated reason (e.g., a Xendit simulate helper drift, a seed reset race):

- Treat as a separate bug. Open a new issue. Do not roll back this plan — the session-race acceptance is met if the redirect-to-`/login` symptom is gone.
