# Peer Takeover of a Locked Booth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any staffer take over a booth left LOCKED by another holder using their own PIN — no manager override — while an actively-working (live-session) holder still requires a manager override.

**Architecture:** A holder with **no live booth session** (locked / went home) is takeover-eligible; a holder **with a live booth session** is not. Liveness is decided by one auth-owned internal query. `loginContext` exposes a new `holderLocked` boolean that drives the login FE (allow PIN instead of block), and a new single-writer atomic mutation `takeOverLockedBooth` ends the locked holder and mints the incoming shift in one transaction, re-checking liveness server-side as the hijack guard.

**Tech Stack:** Convex 1.31.7 (mutations/queries/internal fns, `withIdempotency` + dual-call `authCheck`), React 19 + React Router v7, convex-test + Vitest, i18n typed dictionaries (ADR-049).

## Global Constraints

- **Money as integer rupiah** — no floats (ADR-015). (Only relevant via the reused signoff summary; do not touch its math.)
- **Server time wins** — every `_at` via `Date.now()` inside the function (ADR-031).
- **Public mutations require `idempotencyKey` + `withIdempotency` + dual-call `authCheck`** re-calling `requireSession` (rule #20, ESLint-enforced). Distinct idempotency key roots per intent (idempotency shared-key collision).
- **Audit every state-changing mutation** via `logAudit`; `audit_log.action` is a free `v.string()` (no enum). Document new verbs in `docs/SCHEMA.md`.
- **Cross-module reads go through `_internal` fns** (ADR-034) — `staff_sessions` is auth-owned; `shifts/` reaches it only via `convex/auth/internal.ts`.
- **i18n:** new user-facing copy needs EN **and** ID keys in `src/lib/i18n/dictionaries/{en,id}.ts`; brand names in JSX use `{"Brand"}` (ADR-049 fence).
- **Schema changes here are additive only** — a straight revert is safe; no backfill.
- **All backend function names referenced below already exist** unless a task says *Create*.

---

## Task List

| ID | Title | Files touched | Agent | Wave | Depends-on |
|----|-------|---------------|-------|------|------------|
| T1 | Add `peer_takeover` to `ended_via` (schema + `_endShift_internal` validator) | `convex/shifts/schema.ts`, `convex/shifts/shiftsInternal.ts` | `convex-expert` | 1 | — |
| T2 | `_hasActiveBoothSession_internal` (booth-only liveness, excludes cockpit) | `convex/auth/internal.ts`, `convex/auth/__tests__/` | `convex-expert` | 1 | — |
| T3 | `loginContext` gains `holderLocked` | `convex/shifts/shifts.ts`, `convex/shifts/__tests__/` | `convex-expert` | 1 | T2 |
| T4 | `takeOverLockedBooth` public mutation | `convex/shifts/shifts.ts`, `convex/shifts/__tests__/` | `convex-expert` | 1 | T1, T2 |
| T5 | `useLoginContext` type + all new i18n keys | `src/hooks/useLoginContext.ts`, `src/lib/i18n/dictionaries/{en,id}.ts` | `frontend-integrator` | 2 | T3 (codegen) |
| T6 | `login.tsx` — locked-holder → PIN/takeover branching | `src/routes/login.tsx`, `src/routes/__tests__/` | `frontend-integrator` | 2 | T4, T5 |
| T7 | `begin.tsx` — takeover dispatch + race handling | `src/routes/shift/begin.tsx`, `src/routes/shift/__tests__/` | `frontend-integrator` | 2 | T4, T5 |
| T8 | Docs — SCHEMA.md verb + ended_via, ADR-053 amendment, CLAUDE.md rule #23 | `docs/SCHEMA.md`, `docs/ADR/053-two-level-booth-state.md`, `CLAUDE.md` | `general-purpose` | 3 | T1–T7 |

*(CHANGELOG entry + `package.json.version` bump to v1.5.0 happen at merge time as part of the execution close-out, not a task here — version-sync gate requires them to land together.)*

---

## Execution Strategy — multi-agent, wave-gated

**(a) Wave dispatch map**
- **Wave 1 — backend + backend tests (`convex-expert`).** T1 and T2 are independent (different files) → run in parallel. T3 and T4 both depend on T2 and **both edit `convex/shifts/shifts.ts`** → run them **sequentially, T3 then T4** (shared-file serialization). T4 also depends on T1. **Barrier:** after all four, run `npx convex codegen` once on the merged tree, then `npm run typecheck` + `npx vitest run convex/` must be green before Wave 2.
- **Wave 2 — frontend + FE tests (`frontend-integrator`).** T5 first (adds the `holderLocked` type + all i18n keys the routes consume). Then T6 (`login.tsx`) and T7 (`begin.tsx`) in parallel (different route files). **Barrier:** `npm run typecheck` + `npx vitest run src/` green.
- **Wave 3 — docs (`general-purpose`).** T8 solo. No code, no tests.

**(b) Shared-file / generated-file serialization**
- `convex/shifts/shifts.ts` — written by **T3 and T4**. Serialize T3 → T4 (never parallel).
- `convex/shifts/schema.ts` + `convex/shifts/shiftsInternal.ts` — T1 only.
- `convex/auth/internal.ts` — T2 only.
- `src/lib/i18n/dictionaries/en.ts` + `id.ts` — **T5 only** (all new keys land in T5 so T6/T7 don't collide on the dictionaries).
- `convex/_generated/*` — regenerated by adding T2's internal query + T4's public mutation. Run `npx convex codegen` **once** at the Wave-1 barrier on the merged tree (not per task). Wave 2 consumes `api.shifts.shifts.takeOverLockedBooth` + `loginContext.holderLocked` from that codegen.

**(c) Critical path**
`T2 → T3 → T4 → codegen → T5 → (T6 ‖ T7) → T8`. T2 is the spine gate for both backend consumers; the shared `shifts.ts` forces T3→T4 serial; codegen gates the FE wave.

**(d) What can't be done headless**
- Nothing in Waves 1–3 needs a live env — all verification is convex-test + Vitest + typecheck.
- The **`/persona-uat`** close-out (below) needs a live env (`npx convex dev` + `npm run dev` + `npx convex run seed/actions:reset`). If the executing session can't bring one up headless, flag persona-UAT **`pending: needs live env`** — do NOT claim done.

**(e) Close-out runs in the main session** (never a background agent), after all waves:
1. `/triple-review` — address every Critical + Improvement.
2. `/simplify xhigh` — apply reuse/simplification/efficiency cleanups.
3. `/persona-uat` — **required** (this plan reshapes the login + shift-begin journeys). Fix BLOCKER/BUG before merge; route UX-HIGH/UX-NIT to ROADMAP.
Then re-run `npm run typecheck` + full `npx vitest run`; bump `package.json.version` + CHANGELOG together; update CLAUDE.md rule #23.

**(f) Best-fit agent assignment**
- T1–T4 → **`convex-expert`** — Convex schema/index/idempotency + cross-module `_internal` boundaries + convex-test.
- T5–T7 → **`frontend-integrator`** — wiring `useLoginContext` ↔ routes, dispatch/race logic, i18n; React Router + Vitest.
- T8 → **`general-purpose`** — docs-only, cross-file (SCHEMA/ADR/CLAUDE), no single specialist fits.
- Between-wave gate verification → **`code-reviewer`** (optional) for type + pattern compliance before the FE wave consumes the new field.

**Recommended new agents:** none. The roster's `convex-expert` + `frontend-integrator` + `general-purpose` cover every task; no real, recurring gap justifies building one for this slice.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `convex/shifts/schema.ts` | `pos_shifts` table def | Add `peer_takeover` literal to `ended_via` union |
| `convex/shifts/shiftsInternal.ts` | shift internal writers | Add `peer_takeover` to `_endShift_internal.endedVia` validator |
| `convex/auth/internal.ts` | auth-owned internal reads | Add `_hasActiveBoothSession_internal` |
| `convex/shifts/shifts.ts` | shift public API | Extend `loginContext`; add `takeOverLockedBooth` |
| `src/hooks/useLoginContext.ts` | login-context subscription | Add `holderLocked` to `LoginContext` type |
| `src/lib/i18n/dictionaries/{en,id}.ts` | i18n copy | Add takeover keys (EN + ID) |
| `src/routes/login.tsx` | login journey | Locked-holder → PIN/takeover instead of block |
| `src/routes/shift/begin.tsx` | count wizard | Takeover dispatch + race handling |

---

## Task 1: Add `peer_takeover` to `ended_via`

**Files:**
- Modify: `convex/shifts/schema.ts:60-65` (the `pos_shifts.ended_via` union)
- Modify: `convex/shifts/shiftsInternal.ts:61` (the `_endShift_internal` `endedVia` validator)

**Interfaces:**
- Produces: `pos_shifts.ended_via` and `_endShift_internal({endedVia})` both accept `"peer_takeover"`. T4 relies on this.

- [ ] **Step 1: Add the literal to the schema union**

In `convex/shifts/schema.ts`, the `ended_via` field becomes:

```ts
    ended_via: v.union(
      v.literal("handover"),
      v.literal("end_of_day"),
      v.literal("manager_override"),
      v.literal("peer_takeover"),
      v.null(),
    ),
```

- [ ] **Step 2: Add the literal to the `_endShift_internal` validator**

In `convex/shifts/shiftsInternal.ts`, the `endedVia` arg becomes:

```ts
    endedVia: v.union(
      v.literal("handover"),
      v.literal("end_of_day"),
      v.literal("manager_override"),
      v.literal("peer_takeover"),
    ),
```

- [ ] **Step 3: Regenerate + typecheck**

Run: `npx convex codegen && npm run typecheck`
Expected: PASS (additive union — no existing caller breaks).

- [ ] **Step 4: Commit**

```bash
git add convex/shifts/schema.ts convex/shifts/shiftsInternal.ts
git commit -m "feat(shifts): add peer_takeover ended_via literal"
```

---

## Task 2: `_hasActiveBoothSession_internal`

**Files:**
- Modify: `convex/auth/internal.ts` (add one `internalQuery`)
- Test: `convex/auth/__tests__/hasActiveBoothSession.test.ts` (Create)

**Interfaces:**
- Produces: `internal.auth.internal._hasActiveBoothSession_internal({ staffId: Id<"staff"> }) → Promise<boolean>` — true iff the staff has a live session with `ended_at == null` **and** `kind` booth/legacy (cockpit sessions excluded). T3 and T4 both consume it.

- [ ] **Step 1: Write the failing test**

Create `convex/auth/__tests__/hasActiveBoothSession.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup"; // adjust to this repo's convex-test module glob

test("no sessions ⇒ false", async () => {
  const t = convexTest(schema, modules);
  const staffId = await t.run(async (ctx) =>
    ctx.db.insert("staff", {
      name: "Sasi", code: "S-0003", pin_hash: "x", role: "staff",
      active: true, created_at: Date.now(),
    }),
  );
  const res = await t.query(internal.auth.internal._hasActiveBoothSession_internal, { staffId });
  expect(res).toBe(false);
});

test("live BOOTH session ⇒ true", async () => {
  const t = convexTest(schema, modules);
  const { staffId, outletId } = await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", {} as any); // minimal — adjust to real outlet shape
    const staffId = await ctx.db.insert("staff", {
      name: "Sasi", code: "S-0003", pin_hash: "x", role: "staff",
      active: true, created_at: Date.now(),
    });
    await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, kind: "booth", outlet_id: outletId,
    });
    return { staffId, outletId };
  });
  const res = await t.query(internal.auth.internal._hasActiveBoothSession_internal, { staffId });
  expect(res).toBe(true);
});

test("live COCKPIT session only ⇒ false (not booth presence)", async () => {
  const t = convexTest(schema, modules);
  const staffId = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Lucas", code: "S-0001", pin_hash: "x", role: "owner",
      active: true, created_at: Date.now(),
    });
    await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "laptop", started_at: Date.now(),
      ended_at: null, end_reason: null, kind: "cockpit", last_active_at: Date.now(),
    });
    return staffId;
  });
  const res = await t.query(internal.auth.internal._hasActiveBoothSession_internal, { staffId });
  expect(res).toBe(false);
});

test("ended session ⇒ false", async () => {
  const t = convexTest(schema, modules);
  const staffId = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Sasi", code: "S-0003", pin_hash: "x", role: "staff",
      active: true, created_at: Date.now(),
    });
    await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: Date.now(), end_reason: "manual_lock", kind: "booth",
    } as any);
    return staffId;
  });
  const res = await t.query(internal.auth.internal._hasActiveBoothSession_internal, { staffId });
  expect(res).toBe(false);
});
```

> **Executor note:** match the existing convex-test harness in `convex/**/__tests__/` for the schema/modules import and the exact minimal `outlets`/`staff` insert shapes — copy a sibling test's setup rather than the `as any` placeholders above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/auth/__tests__/hasActiveBoothSession.test.ts`
Expected: FAIL — `_hasActiveBoothSession_internal` is not a function / not exported.

- [ ] **Step 3: Implement the internal query**

Add to `convex/auth/internal.ts` (ensure `internalQuery` and `v` are imported — they already are in this file):

```ts
/**
 * True iff `staffId` has a live BOOTH session (ended_at == null). Cockpit
 * sessions (ADR-052 / rule #26) are a different auth plane and do NOT count as
 * "present at the booth" — an owner/manager can hold a booth shift AND have a
 * cockpit tab open elsewhere; counting that would wrongly block a legit peer
 * takeover of their locked booth. Legacy rows carry no `kind` ⇒ treat as booth.
 * Reused by shifts.loginContext (holderLocked) and shifts.takeOverLockedBooth
 * (server hijack guard) so both gates agree on "present".
 */
export const _hasActiveBoothSession_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, { staffId }): Promise<boolean> => {
    const rows = await ctx.db
      .query("staff_sessions")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("ended_at", null))
      .collect();
    return rows.some((r) => (r.kind ?? "booth") === "booth");
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/auth/__tests__/hasActiveBoothSession.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add convex/auth/internal.ts convex/auth/__tests__/hasActiveBoothSession.test.ts
git commit -m "feat(auth): _hasActiveBoothSession_internal (booth-only liveness)"
```

---

## Task 3: `loginContext` gains `holderLocked`

**Files:**
- Modify: `convex/shifts/shifts.ts:261-289` (the `loginContext` query)
- Test: `convex/shifts/__tests__/loginContext.test.ts` (extend existing if present; else Create)

**Interfaces:**
- Consumes: `internal.auth.internal._hasActiveBoothSession_internal` (T2).
- Produces: `loginContext(deviceId)` now returns `{ outletOpen, holderStaffId, holderName, holderLocked: boolean }`. T5/T6/T7 consume `holderLocked`.

- [ ] **Step 1: Write the failing test**

Add to the shifts login-context test (mirror the existing loginContext / two-level-state tests in `convex/shifts/__tests__/`). Assert:
- holder with a live **booth** session → `holderLocked === false`.
- holder whose booth session is ended (locked) → `holderLocked === true`.
- holder whose only live session is `kind:"cockpit"` → `holderLocked === true`.
- no holder → `holderLocked === false`.

```ts
test("holderLocked true when holder has no live booth session", async () => {
  // seed: outlet open, a pos_shifts holder (ended_at null), holder's session ended
  // (manual_lock). Expect loginContext(deviceId).holderLocked === true.
});
test("holderLocked false when holder has a live booth session", async () => {
  // same seed but holder session ended_at === null, kind booth → holderLocked === false.
});
test("holderLocked true when holder's only live session is cockpit", async () => {
  // holder session kind:"cockpit", ended_at null → holderLocked === true.
});
```

> **Executor note:** reuse the seed helpers from the existing two-level-state / loginContext tests (device→outlet binding, `_setOutletOpen_internal`, `_startShift_internal`) rather than hand-inserting rows.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/shifts/__tests__/loginContext.test.ts`
Expected: FAIL — `holderLocked` is `undefined` on the result.

- [ ] **Step 3: Extend the query**

Replace the `loginContext` handler body in `convex/shifts/shifts.ts` with (return type gains `holderLocked`):

```ts
export const loginContext = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }): Promise<{
    outletOpen: boolean;
    holderStaffId: Id<"staff"> | null;
    holderName: string | null;
    holderLocked: boolean;
  }> => {
    const outletId = await ctx.runQuery(internal.auth.internal._getDeviceOutletIdOrNull_internal, { deviceId });
    if (!outletId) {
      return { outletOpen: false, holderStaffId: null, holderName: null, holderLocked: false };
    }
    const [status, holder] = await Promise.all([
      ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId }),
      ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId }),
    ]);
    let holderName: string | null = null;
    let holderLocked = false;
    if (holder) {
      const [staff, hasBoothSession] = await Promise.all([
        ctx.runQuery(internal.auth.internal._getStaffNameCode_internal, { staffId: holder.staff_id }),
        ctx.runQuery(internal.auth.internal._hasActiveBoothSession_internal, { staffId: holder.staff_id }),
      ]);
      holderName = staff?.name ?? null;
      holderLocked = !hasBoothSession;
    }
    return {
      outletOpen: status.is_open,
      holderStaffId: holder?.staff_id ?? null,
      holderName,
      holderLocked,
    };
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/shifts/__tests__/loginContext.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/shifts/shifts.ts convex/shifts/__tests__/loginContext.test.ts
git commit -m "feat(shifts): loginContext.holderLocked (booth-session liveness)"
```

---

## Task 4: `takeOverLockedBooth` public mutation

**Files:**
- Modify: `convex/shifts/shifts.ts` (add the mutation; reuse the existing `OpenBoothResult` type + imports already at the top of the file)
- Test: `convex/shifts/__tests__/takeOverLockedBooth.test.ts` (Create)

**Interfaces:**
- Consumes: `_endShift_internal` (T1 literal), `_hasActiveBoothSession_internal` (T2), `_getActiveShift_internal`, `_startShift_internal`, `_buildSignoffSummary_internal`, `_sendSignoffSummary`, `_getOutletStatus_internal`, `requireSession`, `withIdempotency`, `logAudit`.
- Produces: `api.shifts.shifts.takeOverLockedBooth({ idempotencyKey, sessionId, steps, openCount? }) → { ok: true, shiftId }`. T7 calls it.

- [ ] **Step 1: Write the failing tests**

Create `convex/shifts/__tests__/takeOverLockedBooth.test.ts` covering:
- **happy path:** outlet open, locked holder (H) ≠ caller (P). After takeover: H's shift `ended_via==="peer_takeover"`, `outgoing_uncounted===true`; a new active shift exists for P with `prev_shift_id === H._id`, `started_via==="handover"`; returns `{ ok:true, shiftId }`.
- **`HOLDER_ACTIVE`:** holder has a live booth session → throws `HOLDER_ACTIVE`; no shift ended/created.
- **`SELF_NOT_PEER`:** holder === caller → throws `SELF_NOT_PEER`.
- **`NO_HOLDER`:** no active holder → throws `NO_HOLDER`.
- **`BOOTH_NOT_OPEN`:** outlet closed → throws `BOOTH_NOT_OPEN`.
- **idempotent replay:** same `idempotencyKey` twice → only one incoming shift; second returns cached result.
- **signoff scheduled for the DISPLACED holder:** the scheduled `_sendSignoffSummary` arg `staffId === H.staff_id` (NOT the caller's id).

```ts
test("peer takes over a locked booth", async () => {
  // seed: outlet open; H holds (started via handover), H's session ended (lock);
  // P logs in (active booth session) → sessionId_P.
  // call takeOverLockedBooth({ idempotencyKey, sessionId: sessionId_P, steps: [...] })
  // assert: H shift ended_via==="peer_takeover", outgoing_uncounted===true;
  //         active shift now P with prev_shift_id===H._id, started_via==="handover".
});

test("throws HOLDER_ACTIVE when holder has a live booth session", async () => {
  // H has ended_at==null booth session → expect rejects /HOLDER_ACTIVE/.
});

test("throws SELF_NOT_PEER when holder === caller", async () => { /* ... */ });
test("throws NO_HOLDER when no active holder", async () => { /* ... */ });
test("throws BOOTH_NOT_OPEN when outlet closed", async () => { /* ... */ });
test("idempotent replay mints only one incoming shift", async () => { /* ... */ });
test("schedules signoff for the displaced holder", async () => {
  // use t.finishInProgressScheduledFunctions / inspect scheduler args per this repo's
  // convex-test pattern; assert the summary target is H.staff_id.
});
```

> **Executor note:** copy the seed + scheduler-assertion patterns from the existing `managerOverride` / `handover` / `endOfDay` tests in `convex/shifts/__tests__/` — they already set up outlet-open + holder + sessions and assert `_sendSignoffSummary` scheduling.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/shifts/__tests__/takeOverLockedBooth.test.ts`
Expected: FAIL — `takeOverLockedBooth` is not defined.

- [ ] **Step 3: Implement the mutation**

Add to `convex/shifts/shifts.ts` (after `startShift`). Note the **ORDER: end the locked holder BEFORE starting the incoming** — `_getActiveShift_internal` uses the `by_outlet_active` `.unique()` index, so two simultaneous active holders would corrupt that invariant.

```ts
type TakeOverArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{ key: string; label: string; type: "instruction" | "count"; confirmed_at: number }>;
  openCount?: number;
};

export const takeOverLockedBooth = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    openCount: v.optional(v.number()),
  },
  handler: withIdempotency<TakeOverArgs, OpenBoothResult>(
    "shifts.takeOverLockedBooth",
    async (ctx, args): Promise<OpenBoothResult> => {
      const { staffId, deviceId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (!status.is_open) throw new Error("BOOTH_NOT_OPEN");

      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      if (!holder) throw new Error("NO_HOLDER");
      if (holder.staff_id === staffId) throw new Error("SELF_NOT_PEER");

      // SAFETY GATE (server-side hijack guard): a live BOOTH session for the holder
      // means they're present → this would be hijacking an active shift, not taking
      // over a locked booth. Same helper as loginContext.holderLocked so FE + server
      // agree on "present". Cockpit sessions don't count (ADR-052 / rule #26).
      const holderActive = await ctx.runQuery(
        internal.auth.internal._hasActiveBoothSession_internal,
        { staffId: holder.staff_id },
      );
      if (holderActive) throw new Error("HOLDER_ACTIVE");

      // End the DISPLACED holder first (preserves the by_outlet_active single-holder
      // invariant), then mint the incoming holder — one atomic mutation, no stranded
      // intermediate state.
      const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
        shiftStartMs: holder.started_at, endMs: now, outletId,
      });
      await ctx.runMutation(internal.shifts.shiftsInternal._endShift_internal, {
        shiftId: holder._id, endedVia: "peer_takeover", closeCount: null,
        steps: [], outgoingUncounted: true,
        summary: {
          durationMs: summary.durationMs, totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount, manualBcaCount: summary.manualBcaCount,
          manualBcaTotalIdr: summary.manualBcaTotalIdr,
        },
      });
      const shiftId: Id<"pos_shifts"> = await ctx.runMutation(
        internal.shifts.shiftsInternal._startShift_internal,
        {
          outletId, deviceId, staffId, startedVia: "handover",
          openCount: args.openCount ?? null, steps: args.steps, prevShiftId: holder._id,
        },
      );
      await logAudit(ctx, {
        actor_id: staffId, action: "shift.peer_takeover", entity_type: "pos_shifts",
        entity_id: holder._id, source: "booth_inline",
        metadata: {
          displaced_staff_id: holder.staff_id, prev_shift_id: holder._id,
          incoming_staff_id: staffId, new_shift_id: shiftId, durationMs: summary.durationMs,
        },
      });
      // Signoff to the DISPLACED holder (decision #1) — note staffId is holder.staff_id,
      // NOT the incoming caller. Mirrors the managerOverride callsite.
      await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
        eventId: holder._id, staffId: holder.staff_id, shiftStartMs: holder.started_at, shiftEndMs: now,
        totalSalesIdr: summary.totalSalesIdr, txnCount: summary.txnCount,
        manualBcaCount: summary.manualBcaCount, manualBcaTotalIdr: summary.manualBcaTotalIdr,
        idempotencyKeySuffix: holder._id, outletId,
      });
      return { ok: true as const, shiftId };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx convex codegen && npx vitest run convex/shifts/__tests__/takeOverLockedBooth.test.ts && npm run typecheck`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add convex/shifts/shifts.ts convex/shifts/__tests__/takeOverLockedBooth.test.ts convex/_generated
git commit -m "feat(shifts): takeOverLockedBooth peer-takeover mutation"
```

---

## Task 5: `useLoginContext` type + i18n keys

**Files:**
- Modify: `src/hooks/useLoginContext.ts` (add `holderLocked` to `LoginContext`)
- Modify: `src/lib/i18n/dictionaries/en.ts`, `src/lib/i18n/dictionaries/id.ts` (add takeover keys)

**Interfaces:**
- Consumes: `loginContext` return shape (T3).
- Produces: `LoginContext.holderLocked: boolean`; i18n keys `login.boothLeftOpenBy`, `shiftBegin.takeoverNote`. T6/T7 consume both.

- [ ] **Step 1: Extend the hook type**

In `src/hooks/useLoginContext.ts`:

```ts
export type LoginContext = {
  outletOpen: boolean;
  holderStaffId: Id<"staff"> | null;
  holderName: string | null;
  holderLocked: boolean;
};
```

- [ ] **Step 2: Add EN keys**

In `src/lib/i18n/dictionaries/en.ts`, near the other `login.*` / `shiftBegin.*` keys:

```ts
  "login.boothLeftOpenBy": "Booth left open by {name} — log in to take over.",
  "shiftBegin.takeoverNote": "Taking over from {name}. Count the stock, then start your shift.",
```

- [ ] **Step 3: Add ID keys (same key names)**

In `src/lib/i18n/dictionaries/id.ts`:

```ts
  "login.boothLeftOpenBy": "Booth ditinggalkan terbuka oleh {name} — masuk untuk mengambil alih.",
  "shiftBegin.takeoverNote": "Mengambil alih dari {name}. Hitung stok, lalu mulai shift Anda.",
```

- [ ] **Step 4: Typecheck (i18n key types + hook)**

Run: `npm run typecheck`
Expected: PASS. (If the repo generates an i18n key union type, both dictionaries must carry identical keys — the ID/EN parity test in `src/lib/i18n/__tests__/` enforces this; run it.)

Run: `npx vitest run src/lib/i18n`
Expected: PASS (dictionary parity).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLoginContext.ts src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/id.ts
git commit -m "feat(login): holderLocked type + takeover i18n keys"
```

---

## Task 6: `login.tsx` — locked-holder → PIN/takeover branching

**Files:**
- Modify: `src/routes/login.tsx` (pre-stage guard ~122, `onPinSubmit` re-check ~224, nav target ~247, `handleStaffTap` ~284, PIN-stage hint)
- Test: `src/routes/__tests__/login.test.tsx` (extend existing if present; else Create a focused test)

**Interfaces:**
- Consumes: `ctx.holderLocked` (T5), `login.boothLeftOpenBy` (T5).
- Produces: locked-holder → PIN entry + `/shift/begin` nav target; active-holder → `blocked` (unchanged).

- [ ] **Step 1: Write the failing tests**

In `src/routes/__tests__/login.test.tsx`, assert (mock `useLoginContext`):
- holder ≠ tapped staff AND `holderLocked === true` → tapping the name opens **PIN entry** (not the blocked stage).
- holder ≠ tapped staff AND `holderLocked === false` → tapping opens the **blocked** stage (unchanged).
- after a successful login with a locked holder ≠ me → `navigate` called with `/shift/begin`.

> **Executor note:** follow the existing login route test's mocking of `useLoginContext`, `useAction(loginWithPin)`, and `useNavigate` (they exist for the v1.3.1/v1.4.x block/override tests).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/__tests__/login.test.tsx`
Expected: FAIL — a locked holder currently routes to `blocked`.

- [ ] **Step 3: Branch on `holderLocked` at all four sites**

**3a. `handleStaffTap` (~284):**

```ts
  const handleStaffTap = (s: { _id: Id<"staff">; name: string; role: "staff" | "manager" }) => {
    // Block ONLY when the outlet is open with a DIFFERENT, actively-working holder.
    // A LOCKED holder (no live booth session) can be taken over with the incoming
    // staffer's own PIN (v1.5.0 peer takeover), so fall through to PIN entry.
    if (
      ctx?.outletOpen === true &&
      ctx.holderStaffId !== null &&
      ctx.holderStaffId !== s._id &&
      !ctx.holderLocked
    ) {
      setStage({ kind: "blocked", staff: s });
      return;
    }
    setStage({ kind: "pin", staff: s });
  };
```

**3b. `onPinSubmit` re-check (~224-233):** add `&& !ctx.holderLocked` to the block predicate:

```ts
    if (
      ctx !== undefined &&
      ctx.outletOpen === true &&
      ctx.holderStaffId !== null &&
      ctx.holderStaffId !== stage.staff._id &&
      !ctx.holderLocked
    ) {
      setPhase({ kind: "error", message: t("login.shiftHeldBy", { name: ctx.holderName ?? "" }), sticky: true });
      setPinReset((n) => n + 1);
      return;
    }
```

**3c. Pre-stage guard (~122-126):** allow pre-staging a locked-holder takeover:

```ts
    if (
      ctx?.outletOpen === true &&
      ctx.holderStaffId !== null &&
      ctx.holderStaffId !== lastId &&
      !ctx.holderLocked
    ) return;
```

**3d. Post-login nav target (~247-253):** add the locked-holder → `/shift/begin` branch:

```ts
      let target = "/";
      if (ctx?.outletOpen === false) {
        target = "/shift/start";
      } else if (
        ctx?.holderStaffId === null ||
        (ctx?.holderLocked === true && ctx?.holderStaffId !== stage.staff._id)
      ) {
        target = "/shift/begin";
      }
      // else: outlet open + holderStaffId === me → resume at "/" (holder shift untouched)
```

- [ ] **Step 4: Add the takeover hint on the PIN stage**

In the PIN-stage JSX branch (the final `else` that renders `<PinEntry />`), add a hint above `PinEntry` when this is a takeover:

```tsx
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          {stage.kind === "pin" &&
            ctx?.holderLocked === true &&
            ctx?.holderStaffId !== null &&
            ctx?.holderStaffId !== stage.staff._id && (
              <p className="text-sm text-muted-foreground text-center">
                {t("login.boothLeftOpenBy", { name: ctx.holderName ?? "" })}
              </p>
            )}
          <PinEntry
            onSubmit={onPinSubmit}
            reset={pinReset}
            pending={phase.kind === "pending"}
            {...pinFeedback}
          />
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/routes/__tests__/login.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/login.tsx src/routes/__tests__/login.test.tsx
git commit -m "feat(login): route locked-holder to PIN/takeover, keep active-holder block"
```

---

## Task 7: `begin.tsx` — takeover dispatch + race handling

**Files:**
- Modify: `src/routes/shift/begin.tsx` (guard ~79, add `takeOverLockedBooth` mutation + key, dispatch in `onComplete`)
- Test: `src/routes/shift/__tests__/begin.test.tsx` (extend existing if present; else Create)

**Interfaces:**
- Consumes: `ctx.holderLocked` (T5), `api.shifts.shifts.takeOverLockedBooth` (T4), `session.staff._id`.
- Produces: takeover terminal calls `takeOverLockedBooth`; normal handover terminal still calls `startShift`.

- [ ] **Step 1: Write the failing tests**

In `src/routes/shift/__tests__/begin.test.tsx`, assert (mock `useLoginContext`, `useSession`, the mutations, `useNavigate`):
- locked holder ≠ me → completing the wizard calls `takeOverLockedBooth` (not `startShift`), then navigates `/`.
- no holder (normal handover) → completing calls `startShift` (unchanged), self-handover Resume prompt still appears on `SELF_HANDOVER_NOT_ALLOWED`.
- `takeOverLockedBooth` throws `NO_HOLDER` (hold cleared mid-count) → falls back to `startShift`, no raw error surfaced.
- active holder ≠ me (not locked) → route redirects to `/` (login owns the block).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/shift/__tests__/begin.test.tsx`
Expected: FAIL — `begin.tsx` currently redirects `/` whenever `holderStaffId !== null`.

- [ ] **Step 3: Add the takeover mutation + key + `me`**

Near the existing hooks in `ShiftBegin`:

```ts
  const takeOverLockedBooth = useMutation(api.shifts.shifts.takeOverLockedBooth);
  const me = session.status === "active" ? session.staff._id : null;
  const takeoverKey = useIdempotency(
    sessionId ? `shift:begin:takeover:${sessionId}` : "shift:begin:takeover:none",
  );
```

- [ ] **Step 4: Rewrite the stray-visit guard (~79)**

```ts
  // Render the count wizard for a NORMAL incoming shift (no holder) OR a peer
  // takeover of a LOCKED holder (holder present, no live booth session, ≠ me).
  // Redirect home for: active holder ≠ me (login owns the block), holder === me
  // (resume — ADR-053), or outlet closed. Suppressed while the resume prompt owns nav.
  const isTakeover =
    ctx.holderStaffId !== null && ctx.holderLocked === true && ctx.holderStaffId !== me;
  const isNormalBegin = ctx.holderStaffId === null;
  if (resumePrompt === null && (!ctx.outletOpen || !(isNormalBegin || isTakeover))) {
    return <Navigate to="/" replace />;
  }
```

- [ ] **Step 5: Extract the normal-start path + dispatch in `onComplete`**

Keep `runStart` as-is. Extract the existing normal-path body into `startNormally`, and dispatch by live ctx:

```ts
  async function startNormally(confirmed: ConfirmedStep[], countChanged: number | null) {
    try {
      await runStart(confirmed, countChanged, false);
    } catch (err) {
      if (errorMessage(err).includes("SELF_HANDOVER_NOT_ALLOWED")) {
        setResumePrompt({ confirmed, countChanged });
        return;
      }
      throw err;
    }
  }

  async function onComplete(confirmed: ConfirmedStep[], countChanged: number | null) {
    if (!idempotencyKey || !sessionId) return;
    // Dispatch from LIVE ctx at call time (it can go stale during the count).
    const takeover =
      ctx !== undefined &&
      ctx.holderStaffId !== null &&
      ctx.holderLocked === true &&
      ctx.holderStaffId !== me;

    if (!takeover) {
      await startNormally(confirmed, countChanged);
      return;
    }

    if (!takeoverKey) return;
    try {
      await takeOverLockedBooth({
        idempotencyKey: takeoverKey,
        sessionId,
        steps: confirmed,
        ...(countChanged != null ? { openCount: countChanged } : {}),
      });
      navigate("/", { replace: true });
    } catch (err) {
      const msg = errorMessage(err);
      // Hold cleared between count-start and submit → claim the now-empty booth.
      if (msg.includes("NO_HOLDER")) {
        await startNormally(confirmed, countChanged);
        return;
      }
      // Holder came back and is working → let login show the block screen.
      if (msg.includes("HOLDER_ACTIVE")) {
        navigate("/", { replace: true });
        return;
      }
      throw err;
    }
  }
```

- [ ] **Step 6: (optional) Show the takeover note in the wizard**

If the `ShiftWizard` accepts a subtitle/note prop, pass `t("shiftBegin.takeoverNote", { name: ctx.holderName ?? "" })` when `isTakeover`. If it doesn't, skip — do not add a prop just for this (YAGNI); the login hint already tells the operator. (Refinement only.)

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/routes/shift/__tests__/begin.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/shift/begin.tsx src/routes/shift/__tests__/begin.test.tsx
git commit -m "feat(shift): begin.tsx peer-takeover dispatch + race handling"
```

---

## Task 8: Docs — SCHEMA.md, ADR-053, CLAUDE.md rule #23

**Files:**
- Modify: `docs/SCHEMA.md` (audit verb `shift.peer_takeover`; `pos_shifts.ended_via` gains `peer_takeover`)
- Modify: `docs/ADR/053-two-level-booth-state.md` (amendment)
- Modify: `CLAUDE.md` (rule #23 wording)

**Interfaces:** none (docs).

- [ ] **Step 1: SCHEMA.md**

Add `shift.peer_takeover` to the audit-verb list with a one-line description (metadata: `displaced_staff_id`, `prev_shift_id`, `incoming_staff_id`, `new_shift_id`, `durationMs`). Update the `pos_shifts.ended_via` enum to include `peer_takeover`.

- [ ] **Step 2: ADR-053 amendment**

Append an amendment note: *"v1.5.0 — peer takeover of a **locked** holder (holder with no live booth session) is staff-allowed via `takeOverLockedBooth` (incoming staffer's own PIN). Manager override remains required for an **active** holder and for closing the outlet. Liveness excludes cockpit sessions (ADR-052)."*

- [ ] **Step 3: CLAUDE.md rule #23**

Extend rule #23's wording: after the `managerOverride` sentence, add that a **locked** holder (no live booth session) can be taken over by any other staffer with their own PIN via `takeOverLockedBooth` (`ended_via="peer_takeover"`); `managerOverride` remains for active holders + close.

- [ ] **Step 4: Commit**

```bash
git add docs/SCHEMA.md docs/ADR/053-two-level-booth-state.md CLAUDE.md
git commit -m "docs(shifts): peer-takeover verb, ADR-053 amendment, rule #23"
```

---

## Success Criteria

- `npm run typecheck` clean; `npx vitest run` fully green (new tests + no regressions).
- Locked-holder booth: a different staffer logs in with their own PIN and takes over (no manager) — verified in `/persona-uat`.
- Active-holder booth: peer is still blocked → manager override path intact.
- Displaced holder receives their Telegram signoff summary (scheduled with their `staff_id`).
- Deploy: additive schema, safe skew both directions (see spec Rollback notes).

## Rollback / Deployment

- **Additive only** — revert the branch to undo; no backfill, no migration.
- **Deploy skew safe** both directions (not a mutation↔action rename): FE-first degrades to current block-and-override (`holderLocked` reads `undefined` → falsy); backend-first leaves the field/mutation unused. The atomic Vercel build ships both together.
- **Version-sync gate:** bump `package.json.version` → `1.5.0` and add the CHANGELOG heading together at merge (execution close-out), else `tools/version-sync.test.mjs` fails.

## Regression Risk

- Normal handover (`holderStaffId === null` → `startShift`) and the v1.4.7 self-handover Resume prompt must be unchanged — asserted in T7 tests.
- The `blocked` stage for active holders must be unchanged — asserted in T6 tests.
- `loginContext` consumers other than login (if any) tolerate the added field (additive).
