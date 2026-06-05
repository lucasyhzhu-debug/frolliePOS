# `useSession` Transient-Null Fix (issue #44, Option B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `useSession`'s blanket "any `null` from `useQuery(getSession)` means dead" interpretation with evidence-based detection — a `null` is only treated as authoritative after we've successfully validated the current `sessionId` at least once. Unblocks the 6 PIN-gated e2e specs `test.skip`-ed in PR #43 and drops the 1500ms fixture-level warm-up from PR #41.

**Architecture:** Track a `useRef<{ sessionId, seen }>` in `useSession.ts`, keyed on `stored` (the current localStorage sessionId), with a render-phase reset on `stored` change so a same-instance lock+relogin doesn't inherit the previous session's evidence (RootLayout keeps `useSession` alive across route changes). Both the destructive effect AND the render-time null branch consult the derived `hasEverBeenReal` const. Add a `RootLayout` `RouteFallback` escape hatch ("Stuck on loading? Lock device and sign in again.") visible after 5s for the rare genuinely-stale-localStorage case so the user is never trapped on `Loading…`.

**Tech Stack:** React 19 + TypeScript, Vite, Convex 1.31.7 (`useQuery` from `convex/react`), vitest 2.1.8 + `@testing-library/react` + `vi.hoisted()` controllable mocks; `vi.useFakeTimers()` only in `RootLayout.test.tsx`. Playwright (`@playwright/test`) for e2e.

**Spec:** `docs/superpowers/specs/2026-06-05-useSession-transient-null-fix-design.md`
**Spec staffreview:** `docs/reviews/staffreview-usesession-transient-null-fix-spec-option-b-2026-06-05.md`
**Architectural-options review:** `docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md`
**Tracking:** GitHub issue #44 · supersedes the `test.skip` layer (PR #43) and the 1500ms warm-up (PR #41). **Replaces the Option A debounce plan that landed in PR #45** under the same filename.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/hooks/useSession.ts` | Session state + localStorage layer | Modify — add `useRef` import; insert `realSeenForStored` ref + render-phase reset + render-phase set + derived `hasEverBeenReal`; replace `isDead` effect with evidence-gated wipe; flip render-time null branch from `"none"` to `hasEverBeenReal ? "none" : "loading"`; replace stale `// Fix V17` comment |
| `src/hooks/useSession.test.tsx` | Unit coverage for the hook | Modify — rewrite mock plumbing to `vi.hoisted()` + controllable `vi.fn()`; add 3 timing-free tests (cold-mount-null, real→null transition, same-instance relogin); keep existing 3 |
| `src/components/layout/RootLayout.tsx` | App shell + gates | Modify — add `STUCK_LOADING_REVEAL_MS=5000` constant; compute `showSessionStuck`; pass to `RouteFallback`; rewrite `RouteFallback` to schedule the "Stuck on loading?" button after the threshold with `useEffect` + `setTimeout` cleanup |
| `src/components/layout/__tests__/RootLayout.test.tsx` | Unit coverage for the escape hatch | Create — 3 tests with `vi.useFakeTimers()` + `vi.hoisted()` mocks for `useSession`, `clearSession`, `useDeviceId`, `useQuery` (isDeviceRegistered), `useStartupReconciliation` |
| `e2e/fixtures.ts` | Playwright `signedInAsLucas` / `signedInAsStaff` fixtures | Modify — delete trailing `page.waitForTimeout(1500)` + 4-line comment block above it (lines 37-41) |
| `e2e/specs/refund.spec.ts` | Refund spec | Modify — `test.skip` → `test`; delete 8-line `// SKIPPED:` block (lines 4-11); `test.skip` is on line 12 |
| `e2e/specs/sale-bca-va.spec.ts` | BCA VA sale spec | Modify — `test.skip` → `test`; delete 2-line block (lines 4-5) |
| `e2e/specs/sale-qris.spec.ts` | QRIS sale spec | Modify — same as sale-bca-va |
| `e2e/specs/spoilage.spec.ts` | Spoilage spec | Modify — `test.skip` → `test`; delete 2-line block (lines 3-4) |
| `e2e/specs/voucher-offline.spec.ts` | Voucher offline spec | Modify — same as sale-bca-va |
| `e2e/specs/voucher-online.spec.ts` | Voucher online spec | Modify — same as sale-bca-va |
| `docs/CHANGELOG.md` | User-facing release notes | Modify — one-line v0.5.7.1 entry citing issue #44 |

**Naming used consistently across tasks** (self-review checked):
- Hook ref: `realSeenForStored` (object shape: `{ sessionId: string | null; seen: boolean }`)
- Hook derived const: `hasEverBeenReal` (boolean)
- RootLayout constant: `STUCK_LOADING_REVEAL_MS = 5000`
- RootLayout boolean: `showSessionStuck`
- RootLayout state: `stuckVisible` (set true after timeout fires)
- Mock names in tests: `mockUseQuery`, `mockUseSession`, `mockClearSession`, `mockUseDeviceId`
- Test session ids: `"s_seed"`, `"s_old"`, `"s_new"` / staff ids: `"st_seed"`, `"st_old"`, `"st_new"`

---

## Task 0: Verify the null-hypothesis with one CI pass (instrument → confirm → strip)

Same as the superseded Option A plan — Decision #7 of the spec keeps this as defence-in-depth. If empirically `validation` only goes `undefined → realSession` (never transiently `null`) on hard-nav, the Option B fix is still partially correct (the loading branch handles `undefined` regardless), but the e2e symptom has a different root cause and we need to surface it. Cheap insurance.

**Files:**
- Modify: `src/hooks/useSession.ts` (temporary instrumentation block; reverted at end of task)

- [ ] **Step 1: Add temporary instrumentation in `useSession`**

After the `const validation = useQuery(...)` line (currently `src/hooks/useSession.ts:42-45`), add a debug block:

```typescript
// TEMP issue #44: prove the transient-null hypothesis. Strip before final commit.
useEffect(() => {
  const tag = `[useSession#44] stored=${stored ? "Y" : "N"} validation=${
    validation === undefined ? "undefined" : validation === null ? "null" : "object"
  }`;
  // TEMP issue #44 instrumentation, stripped in Step 5.
  // eslint-disable-next-line no-console
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

- [ ] **Step 2: Commit the instrumentation on the draft-PR branch**

```bash
git add src/hooks/useSession.ts
git commit -m "chore(temp): instrument useSession transitions for issue #44 verification"
git push -u origin worktree-replan-issue-44-option-b
gh pr create --draft --title "chore(temp): #44 hypothesis verification (Option B)" \
  --body "Draft for one CI pass to confirm useQuery transient null. Stripped before the real fix lands. Tracks #44."
```

Note: GitHub's `pull_request` event fires on draft PRs by default (`opened`, `synchronize`), so the `e2e` workflow runs immediately — no need to mark ready until Task 5.

- [ ] **Step 3: Wait for the e2e workflow run (≈8-12 min)**

```bash
gh pr checks --watch
```

Expected: 7 specs continue to fail with the original symptom (still `test.skip`-ed today, so they pass-as-skipped; only `auth.spec.ts` runs in earnest). The instrumentation runs on every page load — the warns + ring buffer appear in any spec that loads `/`.

- [ ] **Step 4: Read the Playwright trace / artifact for proof**

Download the `playwright-report` artifact for any spec that calls `page.goto("/")`:

```bash
gh run download <run-id> -n playwright-report
```

Open `playwright-report/index.html` → any spec's trace → "Console" tab. Look for the warn pattern after the post-login `page.goto(...)`:

- **Confirms spec:** trace contains `[useSession#44] stored=Y validation=null` at least once between the post-login `page.goto` and the `/login` redirect. → Proceed to Task 1.
- **Refutes spec:** trace ONLY shows `validation=undefined` (never `null`), OR the storage ring buffer (read via `await page.evaluate(() => sessionStorage.getItem("__issue44_ring"))`) shows no `null` entries. → **STOP. Escalate.** The Option B render-time loading branch still partially helps (it preserves `undefined` as `"loading"`), but if `null` never appears, the root cause is elsewhere (likely `RootLayout`'s `deviceRegistered === undefined` flip during reload, or `useDeviceId`'s IDB race). Surface the trace.

If `auth.spec.ts` alone is insufficient (no `page.goto` after login), temporarily un-skip `sale-qris.spec.ts` to drive the post-login navigation — revert that un-skip at end of this task.

- [ ] **Step 5: Strip the instrumentation**

Remove the entire instrumentation block (`useEffect` + sessionStorage ring + `console.warn`) from `src/hooks/useSession.ts`. No traces left in code.

```bash
git add src/hooks/useSession.ts
git commit -m "chore(temp): revert #44 instrumentation — hypothesis confirmed"
```

- [ ] **Step 6: Note the result in the PR**

Comment on the draft PR: *"Confirmed: `validation === null` appears at <timestamp> between post-login `page.goto` and the redirect (run #<id>, spec <name>)."* Keep the PR draft; Task 5 converts it to ready.

---

## Task 1: Hook change + 3 new tests (TDD)

**Files:**
- Modify: `src/hooks/useSession.ts` (imports + ref + effect + render-time branch)
- Modify: `src/hooks/useSession.test.tsx` (mock plumbing rewrite + 3 new tests)

- [ ] **Step 1: Rewrite the mock plumbing to `vi.hoisted()` (existing 3 tests stay green)**

Replace `src/hooks/useSession.test.tsx:1-10` with:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Hoisted so the vi.mock factory (which is itself hoisted above imports) can
// reference a mutable mock fn without relying on initialization order.
// Untyped vi.fn() — vitest 2.x's fn generic is a function type, not args+return,
// and the consumer (useSession) sees the real `useQuery` type from convex/react
// regardless of the mock's typing.
const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn().mockReturnValue(undefined),
}));
vi.mock("convex/react", () => ({
  useQuery: mockUseQuery,
}));

import { useSession, storeSession, clearSession } from "./useSession";
import { SESSION_KEY } from "@/lib/storage-keys";
```

Update the existing `beforeEach` (currently `useSession.test.tsx:17-21`) to also reset the mock:

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

Expected: 3 PASS. The plumbing rewrite is a no-op for them because the default mock value is `undefined`.

- [ ] **Step 3: Write the first failing test (cold-mount null → loading, no wipe)**

Add to `src/hooks/useSession.test.tsx`, inside the `describe(...)` block, after the existing 3 tests:

```typescript
describe("useSession (evidence-based null trust — issue #44)", () => {
  it("returns 'loading' when validation is null but no real session has ever been seen", async () => {
    localStorage.setItem(SESSION_KEY, "s_seed");
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.status).toBe("loading"));
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_seed"); // NOT wiped
  });
});
```

- [ ] **Step 4: Run the new test — verify it FAILS**

```bash
npx vitest run src/hooks/useSession.test.tsx -t "returns 'loading' when validation is null"
```

Expected: FAIL. The existing render-time branch at line 59 maps `validation === null` to `status: "none"`, AND the existing effect at lines 47-55 wipes `localStorage` immediately — both assertions fail.

- [ ] **Step 5: Implement the hook change in `src/hooks/useSession.ts`**

**(a) Update the React import on line 1:**

```typescript
import { useEffect, useRef, useState } from "react";
```

**(b) Insert immediately after the `const validation = useQuery(...)` block (current lines 42-45), BEFORE the existing `// Fix V17` comment:**

```typescript
  // Issue #44: distinguish a transient null from useQuery (during Convex WS
  // resubscribe after hard-nav) from a genuine logout-elsewhere. Trust a null
  // as ground truth only after we've validated THIS sessionId at least once —
  // the same evidence the subscription itself provides. The ref is keyed on
  // `stored` so a same-instance lock+relogin resets the evidence for the new
  // sessionId (RootLayout keeps useSession alive across route changes, so the
  // lifetime-of-hook-instance is longer than the lifetime-of-session).
  //
  // Pattern precedent: src/hooks/useCatalogCache.ts:53 (`liveSeenRef`) gates a
  // destructive overwrite with the same "have we ever observed a fresh value"
  // shape.
  const realSeenForStored = useRef<{ sessionId: string | null; seen: boolean }>(
    { sessionId: null, seen: false },
  );
  if (realSeenForStored.current.sessionId !== stored) {
    realSeenForStored.current = { sessionId: stored, seen: false };
  }
  if (validation !== null && validation !== undefined) {
    realSeenForStored.current.seen = true;
  }
  const hasEverBeenReal = realSeenForStored.current.seen;
```

**(c) Replace the existing `// Fix V17` block + `isDead` derivation + effect (current lines 47-55) with:**

```typescript
  // Wipe localStorage only on a REAL → null transition (genuine logout-elsewhere).
  // A null seen BEFORE we've ever observed a real session for THIS sessionId is
  // the transient-reconnect case (issue #44) — not authoritative; do nothing.
  useEffect(() => {
    if (validation === null && stored != null && hasEverBeenReal) {
      localStorage.removeItem(SESSION_KEY);
      notify(null);
    }
  }, [validation, stored, hasEverBeenReal]);
```

**(d) Replace the current render-time line 59:**

```typescript
  // BEFORE:
  // if (validation === null) return { status: "none", sessionId: null, staff: null };

  // AFTER:
  if (validation === null) {
    return {
      status: hasEverBeenReal ? "none" : "loading",
      sessionId: null,
      staff: null,
    };
  }
```

The other render-time branches (current lines 57, 58, 60-63) stay unchanged.

- [ ] **Step 6: Run the new test — verify it PASSES**

```bash
npx vitest run src/hooks/useSession.test.tsx -t "returns 'loading' when validation is null"
```

Expected: PASS.

- [ ] **Step 7: Add test — real → null transition (wipe + status: "none")**

```typescript
  it("wipes localStorage and returns 'none' on a real → null transition", async () => {
    localStorage.setItem(SESSION_KEY, "s_seed");
    mockUseQuery.mockReturnValue({
      sessionId: "s_seed",
      staff: { _id: "st_seed", name: "Lucas", role: "manager" },
      deviceId: "dev-x",
      startedAt: 0,
    });

    const { result, rerender } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.status).toBe("active"));

    // Server-side row goes away (e.g., logged out elsewhere).
    mockUseQuery.mockReturnValue(null);
    act(() => {
      rerender();
    });

    await waitFor(() => {
      expect(localStorage.getItem(SESSION_KEY)).toBeNull();
      expect(result.current.status).toBe("none");
    });
  });
```

- [ ] **Step 8: Add test — same-instance relogin doesn't inherit prev session's evidence**

This is the Critical-1 regression coverage from the spec staffreview. It proves the render-phase reset on `stored !== current.sessionId` works.

```typescript
  it("resets the 'real-seen' evidence on relogin (new sessionId), so the first transient null doesn't wipe the just-stored session", async () => {
    localStorage.setItem(SESSION_KEY, "s_old");
    mockUseQuery.mockReturnValue({
      sessionId: "s_old",
      staff: { _id: "st_old", name: "Alice", role: "manager" },
      deviceId: "dev-x",
      startedAt: 0,
    });

    const { result, rerender } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.status).toBe("active"));

    // User A locks.
    act(() => {
      clearSession();
    });
    await waitFor(() => expect(result.current.status).toBe("none"));

    // User B logs in — same hook instance.
    act(() => {
      storeSession(
        "s_new",
        "st_new" as import("../../convex/_generated/dataModel").Id<"staff">,
      );
    });

    // Convex's subscription resets for the new sessionId. The first response
    // is transiently null (the bug condition).
    mockUseQuery.mockReturnValue(null);
    act(() => {
      rerender();
    });

    // Must NOT wipe — the ref's render-phase reset on `stored !== current.sessionId`
    // discarded the previous "seen" evidence. The first null for s_new is the
    // cold-mount-loading case, not a real → null transition.
    await waitFor(() => {
      expect(result.current.status).toBe("loading");
      expect(localStorage.getItem(SESSION_KEY)).toBe("s_new");
    });
  });
```

- [ ] **Step 9: Run all useSession tests**

```bash
npx vitest run src/hooks/useSession.test.tsx
```

Expected: 6 PASS (3 existing + 3 new). No act-warnings in output.

- [ ] **Step 10: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/hooks/useSession.ts src/hooks/useSession.test.tsx
git commit -m "$(cat <<'EOF'
fix(useSession): evidence-based null trust (issue #44, Option B)

Replaces the always-on "any null means dead" interpretation with a
useRef<{ sessionId, seen }> keyed on `stored`. Both the destructive
effect and the render-time null branch consult the derived
hasEverBeenReal const. A transient null seen BEFORE the subscription
has ever yielded a real value for this sessionId is treated as "still
loading," not as "session ended" — fixes the hard-nav redirect-to-/login
bug at the root.

The ref is keyed on `stored` (not just hook lifetime) so a same-instance
lock+relogin correctly discards the previous session's evidence. Pattern
matches src/hooks/useCatalogCache.ts:53 (liveSeenRef).

Test plumbing rewritten to vi.hoisted() + controllable vi.fn() for the
3 new tests; existing 3 stay green via the default `undefined` return.

Refs #44.
EOF
)"
```

---

## Task 2: RootLayout escape hatch + 3 new tests (TDD)

**Files:**
- Modify: `src/components/layout/RootLayout.tsx`
- Create: `src/components/layout/__tests__/RootLayout.test.tsx`

- [ ] **Step 1: Write the first failing test — escape hatch hidden initially**

Create `src/components/layout/__tests__/RootLayout.test.tsx`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { mockUseSession, mockClearSession, mockUseDeviceId, mockUseQuery } = vi.hoisted(() => ({
  mockUseSession: vi.fn().mockReturnValue({
    status: "loading", sessionId: null, staff: null,
  }),
  mockClearSession: vi.fn(),
  mockUseDeviceId: vi.fn().mockReturnValue("dev-test"),
  // useQuery → true satisfies RootLayout's single isDeviceRegistered query
  // (RootLayout.tsx:26-29). If RootLayout grows a second useQuery call in the
  // future, this global mock will return `true` for it too — tighten via
  // mockImplementation((q) => q === api.staff.public.isDeviceRegistered ? true : undefined)
  // at that point.
  mockUseQuery: vi.fn().mockReturnValue(true),
}));
vi.mock("@/hooks/useSession", () => ({
  useSession: mockUseSession,
  clearSession: mockClearSession,
  storeSession: vi.fn(),
}));
vi.mock("@/hooks/useDeviceId", () => ({ useDeviceId: mockUseDeviceId }));
vi.mock("convex/react", () => ({ useQuery: mockUseQuery }));
vi.mock("@/hooks/useStartupReconciliation", () => ({ useStartupReconciliation: vi.fn() }));
// Defensive only — every test in this file exercises a gate-fallback path
// (session.status === "loading"), so RootLayout returns <RouteFallback /> at
// line 41 and PrinterProvider is never instantiated. PrinterProvider's
// imports (src/components/pos/PrinterProvider.tsx) have no side effects, so
// this mock isn't load-bearing today. Kept as a guard in case a future test
// renders an active-session path (which would otherwise pull in the real
// useThermalPrinter hook + BLE typings).
vi.mock("@/components/pos/PrinterProvider", () => ({
  PrinterProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { RootLayout } from "../RootLayout";
import { SESSION_KEY } from "@/lib/storage-keys";

describe("RootLayout — stuck-loading escape hatch (issue #44)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mockUseSession.mockReturnValue({ status: "loading", sessionId: null, staff: null });
    mockClearSession.mockClear();
    mockUseDeviceId.mockReturnValue("dev-test");
    mockUseQuery.mockReturnValue(true);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("hides the escape hatch initially (before the threshold elapses)", () => {
    localStorage.setItem(SESSION_KEY, "s_seed");

    render(
      <MemoryRouter initialEntries={["/sale"]}>
        <RootLayout />
      </MemoryRouter>,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Stuck on loading/i }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
npx vitest run src/components/layout/__tests__/RootLayout.test.tsx -t "hides the escape hatch initially"
```

Expected: PASS at first glance — the current `RouteFallback` shows only "Loading…" with no button. This test locks down the "not yet visible" case ahead of the conditional implementation in steps 4-5.

To prove the test is meaningful, momentarily edit the assertion to expect the button (`getByRole` instead of `queryByRole`) and confirm it FAILS. Then revert.

- [ ] **Step 3: Add the failing test — escape hatch visible after 5s + click calls clearSession**

```typescript
  it("reveals the escape hatch after 5s and clicking it calls clearSession", () => {
    localStorage.setItem(SESSION_KEY, "s_seed");

    render(
      <MemoryRouter initialEntries={["/sale"]}>
        <RootLayout />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("button", { name: /Stuck on loading/i }),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    const stuckBtn = screen.getByRole("button", { name: /Stuck on loading/i });
    expect(stuckBtn).toBeInTheDocument();

    fireEvent.click(stuckBtn);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 4: Run — verify it FAILS**

```bash
npx vitest run src/components/layout/__tests__/RootLayout.test.tsx -t "reveals the escape hatch after 5s"
```

Expected: FAIL — the current `RouteFallback` has no button regardless of how much time passes.

- [ ] **Step 5: Implement the escape hatch in `src/components/layout/RootLayout.tsx`**

**(a) Update imports** at the top of the file:

```typescript
import { Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useSession, clearSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useStartupReconciliation } from "@/hooks/useStartupReconciliation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { PrinterProvider } from "@/components/pos/PrinterProvider";
import { SESSION_KEY } from "@/lib/storage-keys";
```

(Adds `useEffect`, `useState`, `clearSession`, and `SESSION_KEY`.)

**(b) Add the module-level constant** above `export function RootLayout()`:

```typescript
// Issue #44: how long a session-loading state must persist before we offer
// the user an explicit escape hatch. Covers the rare genuinely-stale-
// localStorage case (server reaper deleted the session row while the device
// was idle overnight), where useSession returns "loading" indefinitely
// because hasEverBeenReal never flips true. Matches the 5s cadence used by
// src/components/layout/ConnDot.tsx:46 (the only other "reasonable wait"
// in the layout layer).
const STUCK_LOADING_REVEAL_MS = 5000;
```

**(c) Compute `showSessionStuck` inside `RootLayout()`**, after the existing `session = useSession()` and `deviceRegistered = useQuery(...)` declarations and before the gate at line 40:

```typescript
  const showSessionStuck =
    deviceId !== null &&
    deviceRegistered !== undefined &&
    session.status === "loading" &&
    typeof localStorage !== "undefined" &&
    localStorage.getItem(SESSION_KEY) !== null;
```

**(d) Pass it into `RouteFallback`** by changing the return on line 41:

```typescript
  // BEFORE:
  // return <RouteFallback />;

  // AFTER:
  return <RouteFallback showSessionStuck={showSessionStuck} />;
```

**(e) Rewrite `RouteFallback`** at the bottom of the file (currently lines 65-71):

```typescript
function RouteFallback({ showSessionStuck = false }: { showSessionStuck?: boolean }) {
  const [stuckVisible, setStuckVisible] = useState(false);
  useEffect(() => {
    if (!showSessionStuck) {
      setStuckVisible(false);
      return;
    }
    const t = setTimeout(() => setStuckVisible(true), STUCK_LOADING_REVEAL_MS);
    return () => clearTimeout(t);
  }, [showSessionStuck]);

  return (
    <div className="flex-1 grid place-items-center text-muted-foreground text-sm gap-4">
      <span>Loading…</span>
      {stuckVisible && (
        <button
          type="button"
          onClick={() => clearSession()}
          className="text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
        >
          Stuck on loading? Lock device and sign in again.
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the 2 RootLayout tests — verify both PASS**

```bash
npx vitest run src/components/layout/__tests__/RootLayout.test.tsx
```

Expected: 2 PASS.

- [ ] **Step 7: Add the cleanup-path test — loading→active before 5s doesn't flash the hatch**

```typescript
  it("does NOT flash the escape hatch when loading resolves before the threshold", () => {
    localStorage.setItem(SESSION_KEY, "s_seed");

    const { rerender } = render(
      <MemoryRouter initialEntries={["/sale"]}>
        <RootLayout />
      </MemoryRouter>,
    );

    // 2s in — still loading, button not yet visible.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(
      screen.queryByRole("button", { name: /Stuck on loading/i }),
    ).toBeNull();

    // Session resolves to active (the bug-fix happy path).
    mockUseSession.mockReturnValue({
      status: "active",
      sessionId: "s_seed" as never,
      staff: { _id: "st_seed" as never, name: "Lucas", role: "manager" },
    });
    rerender(
      <MemoryRouter initialEntries={["/sale"]}>
        <RootLayout />
      </MemoryRouter>,
    );

    // Advance past the original 5s deadline.
    act(() => {
      vi.advanceTimersByTime(6000);
    });

    expect(
      screen.queryByRole("button", { name: /Stuck on loading/i }),
    ).toBeNull();
  });
```

- [ ] **Step 8: Run all 3 RootLayout tests**

```bash
npx vitest run src/components/layout/__tests__/RootLayout.test.tsx
```

Expected: 3 PASS.

- [ ] **Step 9: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/components/layout/RootLayout.tsx src/components/layout/__tests__/RootLayout.test.tsx
git commit -m "$(cat <<'EOF'
feat(RootLayout): 'Stuck on loading?' escape hatch (issue #44)

Covers the rare genuinely-stale-localStorage case the new useSession
introduces: when validation === null and hasEverBeenReal never flips true
(server reaper deleted the session row overnight), the hook returns
"loading" indefinitely. The 5s escape hatch in RouteFallback gives the
user an explicit, ADR-003-aligned Lock-and-re-login action so they're
never trapped on the Loading… screen.

STUCK_LOADING_REVEAL_MS = 5000 matches the 5s cadence used by ConnDot.tsx.
The setTimeout cleanup ensures normal loading→active transitions never
flash the button.

Refs #44.
EOF
)"
```

---

## Task 3: Remove the fixture workaround

**Files:**
- Modify: `e2e/fixtures.ts` (delete lines 37-41)

- [ ] **Step 1: Open `e2e/fixtures.ts` and delete lines 37-41**

The block to remove (verified against current content):

```typescript
  // Convex client warm-up window. Without this, the next page.goto in the test
  // can trigger a transient null on the session-validation query during WS
  // reconnect → useSession.isDead effect clears localStorage → next render
  // redirects to /login. Empirically reproduced on every signedIn fixture spec.
  await page.waitForTimeout(1500);
```

After deletion, `awaitSignedIn` ends with the URL assertion on line 36 (`await expect(page).not.toHaveURL(/\/login/, { timeout: 2_000 });`).

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures.ts
git commit -m "$(cat <<'EOF'
fix(e2e): drop awaitSignedIn warm-up sleep — superseded by useSession Option B

The hook now interprets a transient null evidence-aware (issue #44 fix in
src/hooks/useSession.ts), so the 1500ms fixture-level workaround from
PR #41 is dead weight (a 1.5s tax on every signedIn spec).

Refs #44.
EOF
)"
```

---

## Task 4: Un-skip the 6 PIN-gated e2e specs

Each spec gets the same two changes: `test.skip(...)` → `test(...)`, and the leading `// SKIPPED:` comment block deleted. `refund.spec.ts` has an 8-line block at lines 4-11 with `test.skip` on line 12; the other 5 have a 2-line block.

**Files:**
- Modify: `e2e/specs/refund.spec.ts:4-11` (delete 8-line block) + `test.skip` on line 12
- Modify: `e2e/specs/sale-bca-va.spec.ts:4-5` (delete 2-line block) + `test.skip`
- Modify: `e2e/specs/sale-qris.spec.ts:4-5` (delete 2-line block) + `test.skip`
- Modify: `e2e/specs/spoilage.spec.ts:3-4` (delete 2-line block) + `test.skip`
- Modify: `e2e/specs/voucher-offline.spec.ts:4-5` (delete 2-line block) + `test.skip`
- Modify: `e2e/specs/voucher-online.spec.ts:4-5` (delete 2-line block) + `test.skip`

- [ ] **Step 1: Un-skip `e2e/specs/refund.spec.ts`**

Delete lines 4-11 (the 8-line `// SKIPPED:` block from "SKIPPED: session-loss-on-hard-nav…" through "the refunds module's other unit tests."). Then on line 12, change:

```typescript
test.skip("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
```

to:

```typescript
test("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
```

- [ ] **Step 2: Un-skip `e2e/specs/sale-bca-va.spec.ts`**

Delete lines 4-5 (`// SKIPPED: session-loss-on-hard-nav (see refund.spec.ts for full context).` + `// Business logic covered by convex/payments/__tests__ + convex/transactions tests.`). Change `test.skip("BCA VA sale:…` to `test("BCA VA sale:…`.

- [ ] **Step 3: Un-skip `e2e/specs/sale-qris.spec.ts`**

Delete the 2-line `// SKIPPED:` block (lines 4-5). Change `test.skip("QRIS sale:…` to `test("QRIS sale:…`.

- [ ] **Step 4: Un-skip `e2e/specs/spoilage.spec.ts`**

Delete the 2-line block (lines 3-4). Change `test.skip("spoilage (booth):…` to `test("spoilage (booth):…`.

- [ ] **Step 5: Un-skip `e2e/specs/voucher-offline.spec.ts`**

Delete the 2-line block (lines 4-5). Change `test.skip("voucher (offline):…` to `test("voucher (offline):…`.

- [ ] **Step 6: Un-skip `e2e/specs/voucher-online.spec.ts`**

Delete the 2-line block (lines 4-5). Change `test.skip("voucher (online):…` to `test("voucher (online):…`.

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
test(e2e): un-skip 6 PIN-gated specs after useSession Option B (issue #44)

The session-loss-on-hard-nav race that justified test.skip in PR #43 is
fixed by the evidence-based null trust in src/hooks/useSession.ts.
Reverts the skip layer + deletes the tracking-note blocks.

Specs: refund, sale-bca-va, sale-qris, spoilage, voucher-offline,
voucher-online.

Closes #44.
EOF
)"
```

---

## Task 5: CHANGELOG entry + open PR for ready review + file follow-up issues

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Confirm the version line**

**Target: v0.5.7.1** (hotfix between shipped v0.5.7 and the already-planned v0.5.8 "orphan-wiring" phase). Verify with `grep -n "^## v0.5" docs/CHANGELOG.md` — should not already contain v0.5.7.1.

- [ ] **Step 2: Insert the entry**

Open `docs/CHANGELOG.md` and add this above the most recent version header:

```markdown
## v0.5.7.1 — 2026-06-?? — bug fix

### Fixed
- `useSession`: replaced the always-on "any null means session is dead"
  interpretation with evidence-based detection — a null from
  `useQuery(getSession)` is only treated as authoritative after we've
  successfully validated the current sessionId at least once. Stops a
  transient null during Convex WS resubscribe (after hard-nav) from wiping
  `localStorage` and bouncing the user to `/login`. The ref is keyed on
  `stored` so a same-instance lock+relogin correctly discards the previous
  session's evidence. Adds a small "Stuck on loading?" escape hatch in
  `RootLayout` for the rare genuinely-stale-localStorage case. Unblocks
  the 6 PIN-gated e2e specs `test.skip`-ed in PR #43 and drops the 1500ms
  fixture-level warm-up introduced in PR #41. (issue #44)
```

Fill in the actual date at ship time.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v0.5.7.1 — useSession transient-null fix Option B (issue #44)"
```

- [ ] **Step 5: File the two follow-up issues**

Per the spec's Decision #6 and the architectural-options review — mitigation-vs-root-cause discipline says these get filed in the SAME PR as the fix, not after.

```bash
gh issue create \
  --title "Migrate getSession (and other ambiguous-null public queries) to tagged-union return shape" \
  --body "Background: issue #44 was resolved client-side (Option B from docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md) — evidence-based null trust in useSession. The architectural review identified Option D (tagged-union return from getSession) as the cleaner long-term shape: server returns { kind: 'active' | 'ended' | 'not_found' } instead of nullable. Park until a second motivating query exists (where the same null-ambiguity pattern recurs). When that happens, this is the right time to introduce the tagged-union convention at the public-query boundary.

Refs #44."

gh issue create \
  --title "Audit useQuery-driven hooks for destructive null-handling (starting with useApproval)" \
  --body "Same shape as the bug fixed in issue #44. src/hooks/useApproval.ts:22 has the same trust-null-immediately pattern (if (res === null) return 'missing'). Lower stakes than useSession (no localStorage wipe, just a UI flash from 'pending' to 'missing' during a reconnect window) but worth a sweep. The realSeenForStored pattern from useSession (src/hooks/useSession.ts post-#44) transfers as a rule.

Refs #44."
```

- [ ] **Step 6: Push and convert the draft PR to ready**

```bash
git push
gh pr ready
```

The e2e workflow runs automatically. **Acceptance signal: all 8 specs green.**

- [ ] **Step 7: Watch the e2e workflow**

```bash
gh pr checks --watch
```

If any of the 6 un-skipped specs fail with a Convex / payment / inventory error unrelated to session-loss-on-hard-nav, that's a different bug — surface on the PR, don't re-skip blindly. The acceptance criterion is "the session race is fixed," not "every spec passes regardless of pre-existing flake."

---

## Success Criteria

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npx vitest run src/hooks/useSession.test.tsx` — 6 tests pass (3 existing + 3 new).
- [ ] `npx vitest run src/components/layout/__tests__/RootLayout.test.tsx` — 3 tests pass (all new).
- [ ] `npm run test` — full vitest suite green (no regression elsewhere).
- [ ] `e2e` GH Action workflow on the PR: all 8 specs green (`auth.spec.ts` + the 6 un-skipped + any others).
- [ ] No `test.skip` remaining in `e2e/specs/*.spec.ts` (except `auth.spec.ts:24`, the unrelated 60s-lockout long-wait skip — leave it).
- [ ] `e2e/fixtures.ts:awaitSignedIn` no longer calls `page.waitForTimeout(1500)`.
- [ ] `src/hooks/useSession.ts` has the `realSeenForStored` ref + render-phase reset + render-phase set + derived `hasEverBeenReal` const + evidence-gated effect + flipped render-time null branch. The "Fix V17" comment is gone.
- [ ] `src/components/layout/RootLayout.tsx` has `STUCK_LOADING_REVEAL_MS = 5000`, the `showSessionStuck` computation, and the rewritten `RouteFallback` with the escape-hatch button.
- [ ] `docs/CHANGELOG.md` has the v0.5.7.1 entry.
- [ ] Two follow-up issues filed on GitHub (tagged-union migration; useQuery-null-handling audit).

## Rollback

**If Task 0 refutes the null hypothesis** (`validation` is only ever `undefined`, never `null`, between `page.goto` and the redirect):

- **STOP this plan immediately.** Do not write the Task 1 fix.
- Commit the Task 0 strip commit (so the instrumentation is fully removed).
- Comment on the draft PR with the refutation evidence and close without merging.
- The Option B render-time loading branch would still partially help (it preserves `validation === undefined` as `"loading"`, same as today), but if `validation` never goes `null`, the bug has a different root cause — likely candidates are `RootLayout`'s `deviceRegistered === undefined` race during reload, `useDeviceId`'s IDB read returning null transiently, or a Convex-client reconnect mode that leaves `validation` stuck at the previous value rather than re-firing. Open a new investigation issue with the trace attached.

**If Tasks 1-2 land but the e2e workflow still fails on session loss:**

- `git revert` Task 1 (the hook commit), Task 2 (the RootLayout commit), and Task 3 (the fixture sleep removal). This restores the prior behaviour: `e2e/fixtures.ts` regains the 1500ms warm-up; the hook goes back to immediate clear. Specs go back to flake-prone but pre-PR-#43 specs at least pass with the fixture sleep restored.
- Keep the Task 0 instrumentation history in the PR branch for re-investigation. Re-open this plan only after the alternative root cause is understood.

**If the RootLayout escape hatch causes a regression** (e.g., flashes on a normal slow reconnect because real reconnects sometimes exceed 5s in prod):

- `git revert` Task 2 only (the RootLayout commit) — independent of Task 1. The hook change is correct on its own; the escape hatch is purely UX for the genuinely-stale case.
- Re-tune `STUCK_LOADING_REVEAL_MS` upward (e.g., 8000 or 12000) and re-land Task 2 separately.

**If the hook fix is right but a different e2e spec fails for an unrelated reason** (e.g., a Xendit simulate helper drift, a seed reset race):

- Treat as a separate bug. Open a new issue. Do not roll back this plan — the session-race acceptance is met if the redirect-to-`/login` symptom is gone.
