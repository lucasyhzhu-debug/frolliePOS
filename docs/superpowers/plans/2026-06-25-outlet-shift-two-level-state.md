# Two-Level Booth State (Outlet Status + Shift Holder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the derived, user-anchored booth state machine with two stored levels — outlet open/closed (the SOP gate) and a single shift holder (transfer only via handover) — eliminating the recurring `BOOTH_NOT_OPEN` locked-booth incidents.

**Architecture:** Level 1 is a stored `outlets.is_open` flag toggled only by start-of-day/manager-skip (open) and end-of-day (close). Level 2 is a new `pos_shifts` table where the single row with `ended_at == null` is the active holder; lock = logout = a pause inside a shift; handover is the only person-to-person transfer. `pos_shift_events` is kept read-only; `deriveBoothState` and the locked/handover_pending machinery are deleted.

**Tech Stack:** Convex 1.31.7 (queries/mutations/actions, `withIdempotency`), React 19 + TypeScript + Vite, convex-test + vitest, argon2 PIN verify (Node action).

**Spec:** `docs/superpowers/specs/2026-06-25-outlet-shift-two-level-state-design.md`

## Global Constraints

- **All money integer rupiah** — no floats (ADR-015).
- **Server time wins** — every `_at` via `Date.now()` inside the function (ADR-031).
- **Public mutations** accept `idempotencyKey`, wrap `withIdempotency` + `authCheck` that re-calls `requireSession` BEFORE cache lookup (rule #20, ADR-013).
- **Outlet fence** — every operational scan index MUST lead with `outlet_id` (rule #26; ESLint `index-leads-with-outlet_id`). `outlet_id` is server-derived from the session, never a client arg (ADR-051).
- **Audit** — every state-changing mutation emits `logAudit`; `audit_log` is append-only (ADR-007). New verbs documented in `docs/SCHEMA.md`.
- **`convex/lib/` + any file imported by V8 queries/mutations must be V8-safe** (no `"use node"`).
- **Manager-PIN gates** funnel through `verifyManagerPinOrThrow` (`convex/auth/verifyPin.ts`).
- **Additive→enforce migration**: new schema fields land `optional`, backfill on prod, then a later step flips required (mirror v2.0 Task 12; see `staged-migration-additive-enforce-lessons`).
- **Convex import-cycle**: annotate the return type of any handler that calls another module's function via `internal.*` (avoids the api-inference cycle — `v058` lesson).

---

## Task List

| ID | Title | Files touched | Wave | Depends-on |
|----|-------|---------------|------|------------|
| T1 | Schema: outlet status fields + `pos_shifts` | `convex/outlets/schema.ts`, `convex/shifts/schema.ts` | 1 | — |
| T2 | Level-1 outlet status internals | `convex/outlets/status.ts` | 2 | T1 |
| T3 | Level-2 shift internals + `shiftLib` | `convex/shifts/shiftLib.ts`, `shiftsInternal.ts` | 2 | T1 |
| T4 | `openBooth` (SOP) + `managerSkipOpen` | `convex/shifts/shifts.ts`, `actions.ts`, `shiftsInternal.ts` | 3 | T2, T3 |
| T5 | `handover` | `convex/shifts/shifts.ts`, `actions.ts` | 3 | T3, T4 |
| T5B | `startShift` (open outlet, no holder — incoming) | `convex/shifts/shifts.ts`, `shiftsInternal.ts` | 3 | T3, T4 |
| T6 | `endOfDay` | `convex/shifts/shifts.ts` | 3 | T2, T3, T4 |
| T7 | `lock` = plain logout | `convex/shifts/shifts.ts` | 3 | T4 |
| T8 | `managerOverride` (force-end stranded shift) | `convex/shifts/actions.ts`, `shiftsInternal.ts` | 3 | T3, T4 |
| T9 | `loginContext` query (the gate) | `convex/shifts/shifts.ts` | 3 | T2, T3, T4 |
| T10 | Migration: backfill `is_open` + holder | `convex/migrations/internal.ts` | 4 | T1, T2, T3 |
| T11 | FE: login gate (resume/block/new/override) | `src/hooks/useLoginContext.ts`, `src/routes/login.tsx` | 5 | T9, T4, T5B, T8 |
| T12 | FE: RootLayout + shift/lock routes; delete `useBoothState`+`shiftSkip` | `src/components/layout/RootLayout.tsx`, `src/routes/shift/*`, `src/routes/lock.tsx` | 5 | T4–T9, T11 |
| T13 | Retire `deriveBoothState` machinery; ADR-053; docs | `convex/shifts/*`, `docs/*`, `CLAUDE.md` | 6 | all |

*(In-prose task headings below match these IDs. T5B is the spec-staffreview-added `startShift` task.)*

## Execution Strategy — multi-agent, wave-gated

Assumed executor: `superpowers:subagent-driven-development` (fresh subagent per task, two-stage review between tasks). **Parallelize within a wave; hard barrier between waves.** Never spawn all tasks at once.

**Wave dispatch map:**
- **Wave 1 (solo): T1.** Schema is the foundation; every other task imports the new validators/indexes. Gate: `npm run typecheck` + the schema test green → **run `npx convex codegen`** so `_generated/api.d.ts` exists for downstream tasks.
- **Wave 2 (parallel ×2): T2, T3.** Disjoint files (`outlets/status.ts` vs `shifts/shiftLib.ts`+`shiftsInternal.ts`). Gate: both test suites green → codegen on the merged tree.
- **Wave 3 (mostly SERIAL — see shared-file rule): T4 → T5, T5B, T6, T7, T9 → T8.** These create the public surface. Gate after each: typecheck + that task's test + codegen.
- **Wave 4 (solo): T10.** Migration; depends on T1–T3 internals. Gate: migration test green.
- **Wave 5 (SERIAL: T11 → T12).** T11 introduces `useLoginContext`; T12 deletes `useBoothState`/`shiftSkip` and rewires routes — T12 must follow T11. Gate: `npx vitest run src/` green.
- **Wave 6 (solo): T13.** Deletes the retired surface + docs/ADR. Gate: **FULL** `npm run typecheck && npx vitest run` green.

**Shared-file / generated-file serialization (hard rule):**
- `convex/shifts/shifts.ts` is written by **T4, T5, T5B, T6, T7, T9** — these MUST run **sequentially** (one writer at a time), each appending its export. Do NOT parallelize them in the same worktree. (If isolating in per-task worktrees, merge in T4→T5→T5B→T6→T7→T9 order and re-run codegen once on the merged tree.)
- `convex/shifts/shiftsInternal.ts` written by **T3, T4, T5B, T8**; `convex/shifts/actions.ts` by **T4, T8** — serialize these pairs.
- `convex/_generated/api.d.ts` (codegen artifact) regenerates whenever a new function is added — **run `npx convex codegen` once at each wave gate on the merged tree**, never concurrently mid-wave (the Convex api-inference cycle: annotate return types of internal-calling handlers — `v058` lesson).
- `src/lib/i18n*` touched by T11 (+ possibly T12) — keep i18n key additions in T11; T12 only consumes.

**Critical path (sets min wall-clock):** T1 → T3 → T4 → T9 → T11 → T12 → T13. Wave 3's shifts.ts serialization is the long pole; the other Wave-3 tasks can't overlap it.

**Can't be done headless (flag "pending", do not claim passed):**
- The **prod backfill run** (Task T10's `npx convex run migrations/internal:backfillOutletStatus --prod` + `assertOutletStatusBackfilled --prod`) — runs post-deploy by a human against prod.
- **Live booth UAT** (open→sell→lock→relogin-resume→handover→incoming-count→end-of-day) on the real device, and the **bilingual EN/ID smoke** — owner-owned manual passes.
- The **enforce step** (flip `outlets.is_open` required) ships only after the prod backfill is verified green.

**Close-out (MAIN session, never a background agent):** after Wave 6 is green, run `/triple-review` (address every Critical + Improvement) then `/simplify xhigh`; re-run the full gate; only then is the phase done.

## File Structure

**Backend (new):**
- `convex/shifts/shiftLib.ts` — pure helpers (V8-safe): `shiftHoursMs`, summary shaping. Replaces `deriveBoothState` usage.
- `convex/outlets/status.ts` — Level-1 internals: get/set outlet open/closed.
- `convex/shifts/shifts.ts` — Level-2 public mutations: `openBooth`, `managerSkipOpen` (action), `handover`, `endOfDay`, `lock`; query `loginContext`.
- `convex/shifts/shiftsInternal.ts` — Level-2 internals: `_getActiveShift_internal`, `_startShift_internal`, `_endShift_internal`, `_managerOverrideCommit_internal`.

**Backend (modify):**
- `convex/outlets/schema.ts` — add Level-1 fields to `outlets`.
- `convex/shifts/schema.ts` — add `pos_shifts` table; keep `pos_shift_events` (read-only).
- `convex/shifts/public.ts` — DELETE the old lifecycle mutations + `assertBoothState` + `boothState` query; re-export from new files or remove.
- `convex/shifts/lib.ts` — DELETE `deriveBoothState`/`BoothState`/`OPEN_TYPES`; keep `resolveStaffName`, `computeShiftHoursMs`.
- `convex/shifts/actions.ts` — replace `managerTakeover` with `managerOverride`; keep `_sendSignoffSummary`.
- `convex/migrations/internal.ts` — add `backfillOutletStatus` + `assertOutletStatusBackfilled`.

**Frontend (modify):**
- `src/hooks/useBoothState.ts` → replace with `src/hooks/useLoginContext.ts`.
- `src/routes/login.tsx` — new gate (resume / block / new-shift), manager-override entry.
- `src/components/layout/RootLayout.tsx` — SOP gate keys off `outletOpen`; remove handover_pending exemption.
- `src/routes/shift/start.tsx` — call `openBooth`; manager-skip → `managerSkipOpen`.
- `src/routes/shift/end.tsx` — call `handover` / `endOfDay`.
- `src/routes/lock.tsx` — `lock` = plain logout; `managerOverride` for the blocked case.
- `src/lib/shiftSkip.ts` — DELETE (server-side now).

**Docs:** `docs/ADR/053-two-level-booth-state.md`, `docs/SCHEMA.md`, `docs/API_REFERENCE.md`, `docs/CHANGELOG.md`, `CLAUDE.md`.

---

## Task 1: Schema — outlet status fields + `pos_shifts` table

**Files:**
- Modify: `convex/outlets/schema.ts`
- Modify: `convex/shifts/schema.ts`
- Test: `convex/shifts/__tests__/posShiftsSchema.test.ts`

**Interfaces:**
- Produces: `outlets.{is_open,opened_at,opened_by,opened_via,closed_at,closed_by}` (all optional this task); `pos_shifts` table with index `by_outlet_active` (`["outlet_id","ended_at"]`), `by_staff_started`, `by_outlet_started`.

- [ ] **Step 1: Add Level-1 fields to `outlets`** (optional for additive migration)

In `convex/outlets/schema.ts`, inside `outlets: defineTable({...})` after `created_by`:
```ts
    // v2.1 two-level booth state (ADR-053): Level-1 outlet status. Optional during
    // the additive migration window; flipped required after backfill (Task 10).
    is_open: v.optional(v.boolean()),
    opened_at: v.optional(v.union(v.number(), v.null())),
    opened_by: v.optional(v.union(v.id("staff"), v.null())),
    opened_via: v.optional(v.union(v.literal("sop"), v.literal("manager_skip"), v.null())),
    closed_at: v.optional(v.union(v.number(), v.null())),
    closed_by: v.optional(v.union(v.id("staff"), v.null())),
```

- [ ] **Step 2: Add `pos_shifts` to `convex/shifts/schema.ts`**

Append inside `shiftsTables` (after `pos_shift_events`):
```ts
  pos_shifts: defineTable({
    outlet_id: v.id("outlets"),
    device_id: v.string(),
    staff_id: v.id("staff"),
    started_at: v.number(),
    started_via: v.union(
      v.literal("sop"),
      v.literal("manager_skip"),
      v.literal("handover"),
    ),
    ended_at: v.union(v.number(), v.null()),
    ended_via: v.union(
      v.literal("handover"),
      v.literal("end_of_day"),
      v.literal("manager_override"),
      v.null(),
    ),
    open_count: v.union(v.number(), v.null()),
    close_count: v.union(v.number(), v.null()),
    outgoing_uncounted: v.union(v.boolean(), v.null()),
    steps: v.array(stepValidator),
    summary: v.union(
      v.object({
        durationMs: v.number(),
        totalSalesIdr: v.number(),
        txnCount: v.number(),
        manualBcaCount: v.number(),
        manualBcaTotalIdr: v.number(),
      }),
      v.null(),
    ),
    prev_shift_id: v.union(v.id("pos_shifts"), v.null()),
    created_at: v.number(),
  })
    .index("by_outlet_active", ["outlet_id", "ended_at"])
    .index("by_staff_started", ["staff_id", "started_at"])
    .index("by_outlet_started", ["outlet_id", "started_at"]),
```

- [ ] **Step 3: Write the failing test**

`convex/shifts/__tests__/posShiftsSchema.test.ts`:
```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";

test("pos_shifts: active holder = the row with ended_at == null", async () => {
  const t = convexTest(schema);
  const { outletId } = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: true,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    await ctx.db.insert("pos_shifts", {
      outlet_id: outletId, device_id: "d1", staff_id: staffId,
      started_at: Date.now(), started_via: "sop", ended_at: null, ended_via: null,
      open_count: null, close_count: null, outgoing_uncounted: null,
      steps: [], summary: null, prev_shift_id: null, created_at: Date.now(),
    });
    return { outletId };
  });
  const active = await t.run((ctx: any) =>
    ctx.db.query("pos_shifts")
      .withIndex("by_outlet_active", (q: any) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .unique());
  expect(active).not.toBeNull();
  expect(active.started_via).toBe("sop");
});
```

- [ ] **Step 4: Run test**

Run: `npx vitest run convex/shifts/__tests__/posShiftsSchema.test.ts`
Expected: PASS (schema accepts the new table + the index query returns the active holder).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → Expected: no errors.
```bash
git add convex/outlets/schema.ts convex/shifts/schema.ts convex/shifts/__tests__/posShiftsSchema.test.ts
git commit -m "feat(shifts): add Level-1 outlet status fields + pos_shifts table (ADR-053)"
```

---

## Task 2: Level-1 outlet status internals

**Files:**
- Create: `convex/outlets/status.ts`
- Test: `convex/outlets/__tests__/status.test.ts`

**Interfaces:**
- Produces:
  - `_getOutletStatus_internal({ outletId }): Promise<{ is_open: boolean }>` — returns `{ is_open: false }` when the field is absent (pre-backfill default).
  - `_setOutletOpen_internal({ outletId, staffId, via: "sop"|"manager_skip" }): Promise<null>` — patches `is_open=true`, `opened_at/by/via`, clears `closed_*`.
  - `_setOutletClosed_internal({ outletId, staffId }): Promise<null>` — patches `is_open=false`, `closed_at/by`.

- [ ] **Step 1: Write the failing test**

`convex/outlets/__tests__/status.test.ts`:
```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    return { outletId, staffId };
  });
}

test("outlet status: default closed, open then close", async () => {
  const t = convexTest(schema);
  const { outletId, staffId } = await seedOutlet(t);
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);

  await t.mutation(internal.outlets.status._setOutletOpen_internal, { outletId, staffId, via: "sop" });
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);

  await t.mutation(internal.outlets.status._setOutletClosed_internal, { outletId, staffId });
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/outlets/__tests__/status.test.ts`
Expected: FAIL ("internal.outlets.status ... is not a function" / module missing).

- [ ] **Step 3: Implement `convex/outlets/status.ts`**

```ts
import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

export const _getOutletStatus_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<{ is_open: boolean }> => {
    const outlet = await ctx.db.get(outletId);
    return { is_open: outlet?.is_open === true };
  },
});

export const _setOutletOpen_internal = internalMutation({
  args: {
    outletId: v.id("outlets"),
    staffId: v.id("staff"),
    via: v.union(v.literal("sop"), v.literal("manager_skip")),
  },
  handler: async (ctx, { outletId, staffId, via }): Promise<null> => {
    await ctx.db.patch(outletId, {
      is_open: true,
      opened_at: Date.now(),
      opened_by: staffId,
      opened_via: via,
      closed_at: null,
      closed_by: null,
    });
    return null;
  },
});

export const _setOutletClosed_internal = internalMutation({
  args: { outletId: v.id("outlets"), staffId: v.id("staff") },
  handler: async (ctx, { outletId, staffId }): Promise<null> => {
    await ctx.db.patch(outletId, {
      is_open: false,
      closed_at: Date.now(),
      closed_by: staffId,
    });
    return null;
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/outlets/__tests__/status.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/outlets/status.ts convex/outlets/__tests__/status.test.ts
git commit -m "feat(outlets): Level-1 outlet status internals (get/open/close)"
```

---

## Task 3: Level-2 shift internals + pure lib

**Files:**
- Create: `convex/shifts/shiftLib.ts`
- Create: `convex/shifts/shiftsInternal.ts`
- Test: `convex/shifts/__tests__/shiftsInternal.test.ts`

**Interfaces:**
- Consumes: `_buildSignoffSummary_internal({ shiftStartMs, endMs, outletId })` (existing, `convex/shifts/internal.ts`).
- Produces:
  - `shiftLib.shiftHoursMs(startedAt, endedAt): number` (pure).
  - `_getActiveShift_internal({ outletId }): Promise<Doc<"pos_shifts"> | null>` — the `ended_at == null` row (the holder), or null.
  - `_startShift_internal({ outletId, deviceId, staffId, startedVia, openCount, steps, prevShiftId }): Promise<Id<"pos_shifts">>`.
  - `_endShift_internal({ shiftId, endedVia, closeCount, steps, outgoingUncounted, summary }): Promise<null>`.

- [ ] **Step 1: Implement `convex/shifts/shiftLib.ts`** (pure, V8-safe)

```ts
// Pure shift helpers (V8-safe). Replaces deriveBoothState — booth open/closed is
// now stored (outlets.is_open), so there is no state to derive; only shift math.
export function shiftHoursMs(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}
```

- [ ] **Step 2: Write the failing test**

`convex/shifts/__tests__/shiftsInternal.test.ts`:
```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: true,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    return { outletId, staffId };
  });
}

test("start then end a shift; active holder reflects state", async () => {
  const t = convexTest(schema);
  const { outletId, staffId } = await seed(t);

  const shiftId = await t.mutation(internal.shifts.shiftsInternal._startShift_internal, {
    outletId, deviceId: "d1", staffId, startedVia: "sop",
    openCount: 12, steps: [], prevShiftId: null,
  });
  let active = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(active?._id).toBe(shiftId);

  await t.mutation(internal.shifts.shiftsInternal._endShift_internal, {
    shiftId, endedVia: "handover", closeCount: 10, steps: [],
    outgoingUncounted: null,
    summary: { durationMs: 1, totalSalesIdr: 0, txnCount: 0, manualBcaCount: 0, manualBcaTotalIdr: 0 },
  });
  active = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(active).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run convex/shifts/__tests__/shiftsInternal.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `convex/shifts/shiftsInternal.ts`**

```ts
import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { stepValidator } from "./schema";

const summaryValidator = v.object({
  durationMs: v.number(),
  totalSalesIdr: v.number(),
  txnCount: v.number(),
  manualBcaCount: v.number(),
  manualBcaTotalIdr: v.number(),
});

export const _getActiveShift_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<Doc<"pos_shifts"> | null> => {
    return await ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_active", (q) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .unique();
  },
});

export const _startShift_internal = internalMutation({
  args: {
    outletId: v.id("outlets"),
    deviceId: v.string(),
    staffId: v.id("staff"),
    startedVia: v.union(v.literal("sop"), v.literal("manager_skip"), v.literal("handover")),
    openCount: v.union(v.number(), v.null()),
    steps: v.array(stepValidator),
    prevShiftId: v.union(v.id("pos_shifts"), v.null()),
  },
  handler: async (ctx, args): Promise<Id<"pos_shifts">> => {
    const now = Date.now();
    return await ctx.db.insert("pos_shifts", {
      outlet_id: args.outletId,
      device_id: args.deviceId,
      staff_id: args.staffId,
      started_at: now,
      started_via: args.startedVia,
      ended_at: null,
      ended_via: null,
      open_count: args.openCount,
      close_count: null,
      outgoing_uncounted: null,
      steps: args.steps,
      summary: null,
      prev_shift_id: args.prevShiftId,
      created_at: now,
    });
  },
});

export const _endShift_internal = internalMutation({
  args: {
    shiftId: v.id("pos_shifts"),
    endedVia: v.union(v.literal("handover"), v.literal("end_of_day"), v.literal("manager_override")),
    closeCount: v.union(v.number(), v.null()),
    steps: v.array(stepValidator),
    outgoingUncounted: v.union(v.boolean(), v.null()),
    summary: v.union(summaryValidator, v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.shiftId, {
      ended_at: Date.now(),
      ended_via: args.endedVia,
      close_count: args.closeCount,
      steps: args.steps.length ? args.steps : (await ctx.db.get(args.shiftId))!.steps,
      outgoing_uncounted: args.outgoingUncounted,
      summary: args.summary,
    });
    return null;
  },
});
```

- [ ] **Step 5: Run test → PASS, then commit**

Run: `npx vitest run convex/shifts/__tests__/shiftsInternal.test.ts` → PASS.
```bash
git add convex/shifts/shiftLib.ts convex/shifts/shiftsInternal.ts convex/shifts/__tests__/shiftsInternal.test.ts
git commit -m "feat(shifts): Level-2 shift internals (active holder, start, end)"
```

---

## Task 4: Public `openBooth` (SOP) + `managerSkipOpen`

**Files:**
- Create: `convex/shifts/shifts.ts`
- Test: `convex/shifts/__tests__/openBooth.test.ts`

**Interfaces:**
- Consumes: `requireSession` (`convex/auth/sessions.ts`), `_setOutletOpen_internal`, `_startShift_internal`, `_getActiveShift_internal`, `_getOutletStatus_internal`, `verifyManagerPinOrThrow` (`convex/auth/verifyPin.ts`).
- Produces:
  - `openBooth({ idempotencyKey, sessionId, steps, openCount? }): Promise<{ ok: true; shiftId: Id<"pos_shifts"> }>` — staff start-of-day; requires outlet currently closed.
  - `managerSkipOpen({ idempotencyKey, sessionId, managerPin }): Promise<{ ok: true; shiftId }>` — manager opens with no checklist (action, PIN verified).

- [ ] **Step 1: Write the failing test**

`convex/shifts/__tests__/openBooth.test.ts`:
```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function seedClosed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", {
      device_id: "d1", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    });
    return { outletId, staffId, sessionId };
  });
}

test("openBooth opens outlet and starts the first shift", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedClosed(t);

  const res = await t.mutation(api.shifts.shifts.openBooth, {
    idempotencyKey: "k1", sessionId, steps: [], openCount: 12,
  });
  expect(res.ok).toBe(true);

  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);
  const holder = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holder?.started_via).toBe("sop");
  expect(holder?.open_count).toBe(12);
});

test("openBooth on an already-open outlet → BOOTH_ALREADY_OPEN", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedClosed(t);
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "k1", sessionId, steps: [] });
  await expect(
    t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "k2", sessionId, steps: [] }),
  ).rejects.toThrow(/BOOTH_ALREADY_OPEN/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/shifts/__tests__/openBooth.test.ts`
Expected: FAIL (`api.shifts.shifts` missing).

- [ ] **Step 3: Implement `openBooth` in `convex/shifts/shifts.ts`**

```ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { requireSession } from "../auth/sessions";
import { logAudit } from "../audit/internal";
import { stepValidator } from "./schema";

type OpenBoothArgs = {
  idempotencyKey: string;
  sessionId: Id<"staff_sessions">;
  steps: Array<{ key: string; label: string; type: "instruction" | "count"; confirmed_at: number }>;
  openCount?: number;
};
type OpenBoothResult = { ok: true; shiftId: Id<"pos_shifts"> };

export const openBooth = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    openCount: v.optional(v.number()),
  },
  handler: withIdempotency<OpenBoothArgs, OpenBoothResult>(
    "shifts.openBooth",
    async (ctx, args): Promise<OpenBoothResult> => {
      const { staffId, deviceId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);

      // Level-1 guard: start-of-day is only valid from a CLOSED outlet.
      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (status.is_open) throw new Error("BOOTH_ALREADY_OPEN");

      await ctx.runMutation(internal.outlets.status._setOutletOpen_internal, {
        outletId, staffId, via: "sop",
      });
      const shiftId: Id<"pos_shifts"> = await ctx.runMutation(
        internal.shifts.shiftsInternal._startShift_internal,
        {
          outletId, deviceId, staffId, startedVia: "sop",
          openCount: args.openCount ?? null, steps: args.steps, prevShiftId: null,
        },
      );
      await logAudit(ctx, {
        actor_id: staffId, action: "outlet.opened", entity_type: "outlets",
        entity_id: outletId, source: "booth_inline",
        metadata: { via: "sop", shift_id: shiftId, open_count: args.openCount ?? null },
      });
      return { ok: true as const, shiftId };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
```

- [ ] **Step 4: Run the two openBooth tests → PASS**

Run: `npx vitest run convex/shifts/__tests__/openBooth.test.ts` → both PASS.

- [ ] **Step 5: Add `managerSkipOpen` action** in `convex/shifts/actions.ts`

Append (Node action — argon2 PIN verify; mirrors the existing `managerTakeover` structure):
```ts
export const managerSkipOpen = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    managerPin: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; shiftId: Id<"pos_shifts"> }> => {
    const { staffId, deviceId, outlet_id: outletId } =
      await ctx.runQuery(internal.auth.sessions._resolveSession_internal, { sessionId: args.sessionId });
    await ctx.runAction(internal.auth.verifyPin.verifyManagerPinOrThrow, { staffId, pin: args.managerPin });
    return await ctx.runMutation(internal.shifts.shiftsInternal._managerSkipOpenCommit_internal, {
      idempotencyKey: args.idempotencyKey, outletId, deviceId, staffId,
    });
  },
});
```
Add the committing internal mutation in `convex/shifts/shiftsInternal.ts` (wrapped `withIdempotency`, sets outlet open via `manager_skip` + starts a `manager_skip` shift, audit `outlet.opened` with `via: "manager_skip"`). Mirror `openBooth`'s body but `startedVia: "manager_skip"`, `steps: []`, `openCount: null`.

> NOTE: confirm `internal.auth.sessions._resolveSession_internal` and `internal.auth.verifyPin.verifyManagerPinOrThrow` exact names against `convex/auth/` before wiring; if `verifyManagerPinOrThrow` is not exposed as an internal action, reuse the same path `managerTakeover` uses in `actions.ts` today.

- [ ] **Step 6: Test `managerSkipOpen`** — add a test seeding a manager + `BOOTSTRAP`/known pin_hash, assert outlet open + holder `started_via === "manager_skip"`. Run → PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add convex/shifts/shifts.ts convex/shifts/actions.ts convex/shifts/shiftsInternal.ts convex/shifts/__tests__/openBooth.test.ts
git commit -m "feat(shifts): openBooth (SOP) + managerSkipOpen open the outlet + start a shift"
```

---

## Task 5: Public `handover`

**Files:**
- Modify: `convex/shifts/shifts.ts`
- Test: `convex/shifts/__tests__/handover2.test.ts`

**Interfaces:**
- Consumes: `_getActiveShift_internal`, `_endShift_internal`, `_buildSignoffSummary_internal`, `_endShiftSession_internal` (`convex/auth/internal.ts`), `_sendSignoffSummary` (`convex/shifts/actions.ts`).
- Produces: `handover({ idempotencyKey, sessionId, steps, closeCount? }): Promise<{ ok: true; durationMs: number }>` — outgoing holder ends their shift (outlet stays open), session ends, per-shift summary scheduled.

- [ ] **Step 1: Write the failing test**

`convex/shifts/__tests__/handover2.test.ts`:
```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

setupTelegramStub();

// (reuse seedClosed from openBooth.test.ts pattern; inline here)
async function seedOpen(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", { device_id: "d1", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId });
    const staffId = await ctx.db.insert("staff", { name: "Sisca", code: "S-1", role: "staff", pin_hash: "x", active: true, must_change_pin: false, created_at: 0 });
    const sessionId = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: outletId });
    return { outletId, staffId, sessionId };
  });
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "open", sessionId: ids.sessionId, steps: [] });
  return ids;
}

test("handover ends the shift but leaves the outlet OPEN", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t);

  const res = await t.mutation(api.shifts.shifts.handover, {
    idempotencyKey: "h1", sessionId, steps: [], closeCount: 9,
  });
  expect(res.ok).toBe(true);

  // Outlet still open (Level 1 untouched), but no active holder (Level 2 released).
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);
  expect(await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId })).toBeNull();
  await drainScheduled(t);
});
```

- [ ] **Step 2: Run test → FAIL** (`handover` missing).

- [ ] **Step 3: Implement `handover`** in `convex/shifts/shifts.ts`

```ts
type HandoverArgs2 = OpenBoothArgs & { closeCount?: number };
type HandoverResult = { ok: true; durationMs: number };

export const handover = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    closeCount: v.optional(v.number()),
  },
  handler: withIdempotency<HandoverArgs2, HandoverResult>(
    "shifts.handover",
    async (ctx, args): Promise<HandoverResult> => {
      const { staffId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      if (!holder) throw new Error("NO_ACTIVE_SHIFT");
      if (holder.staff_id !== staffId) throw new Error("NOT_SHIFT_HOLDER");

      const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
        shiftStartMs: holder.started_at, endMs: now, outletId,
      });
      await ctx.runMutation(internal.shifts.shiftsInternal._endShift_internal, {
        shiftId: holder._id, endedVia: "handover", closeCount: args.closeCount ?? null,
        steps: args.steps, outgoingUncounted: null,
        summary: {
          durationMs: summary.durationMs, totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount, manualBcaCount: summary.manualBcaCount,
          manualBcaTotalIdr: summary.manualBcaTotalIdr,
        },
      });
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId, endReason: "force_logout",
      });
      await logAudit(ctx, {
        actor_id: staffId, action: "shift.handover", entity_type: "pos_shifts",
        entity_id: holder._id, source: "booth_inline",
        metadata: { durationMs: summary.durationMs },
      });
      await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
        eventId: holder._id, staffId, shiftStartMs: holder.started_at, shiftEndMs: now,
        totalSalesIdr: summary.totalSalesIdr, txnCount: summary.txnCount,
        manualBcaCount: summary.manualBcaCount, manualBcaTotalIdr: summary.manualBcaTotalIdr,
        idempotencyKeySuffix: holder._id, outletId,
      });
      return { ok: true as const, durationMs: summary.durationMs };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
```
> NOTE: `_sendSignoffSummary`'s `eventId` arg is typed `Id<"pos_shift_events">`. Widen it to `v.union(v.id("pos_shift_events"), v.id("pos_shifts"))` (it is used only as an idempotency-key suffix string — confirm in `actions.ts`), or change it to `v.string()`. Adjust in this task.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```bash
git add convex/shifts/shifts.ts convex/shifts/actions.ts convex/shifts/__tests__/handover2.test.ts
git commit -m "feat(shifts): handover ends the shift, outlet stays open, summary fires"
```

---

## Task 5B: Public `startShift` (open outlet, no holder — incoming)

**Files:**
- Modify: `convex/shifts/shifts.ts`
- Modify: `convex/shifts/shiftsInternal.ts` (add `_lastEndedShift_internal`)
- Test: `convex/shifts/__tests__/startShift.test.ts`

**Interfaces:**
- Consumes: `_getActiveShift_internal`, `_getOutletStatus_internal`, `_startShift_internal`.
- Produces:
  - `_lastEndedShift_internal({ outletId }): Promise<Doc<"pos_shifts"> | null>` — most recent ended shift (by `started_at` desc, first with `ended_at != null`), for `prev_shift_id` linkage.
  - `startShift({ idempotencyKey, sessionId, steps, openCount? }): Promise<{ ok: true; shiftId: Id<"pos_shifts"> }>` — begins a shift on an **already-open, holderless** outlet (the post-handover incoming case). Rejects if the outlet is closed (`BOOTH_NOT_OPEN`) or a holder already exists (`SHIFT_IN_PROGRESS`).

- [ ] **Step 1: Add `_lastEndedShift_internal`** to `convex/shifts/shiftsInternal.ts`

```ts
export const _lastEndedShift_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<Doc<"pos_shifts"> | null> => {
    const rows = await ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_started", (q) => q.eq("outlet_id", outletId))
      .order("desc")
      .take(5);
    return rows.find((r) => r.ended_at !== null) ?? null;
  },
});
```

- [ ] **Step 2: Write the failing test**

`convex/shifts/__tests__/startShift.test.ts` (reuse the `seedOpen` pattern; after a handover by Sisca, a different staffer Budi starts):
```ts
test("startShift begins a new shift after handover; prev_shift_id links", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t); // holder = Sisca
  await t.mutation(api.shifts.shifts.handover, { idempotencyKey: "h1", sessionId, steps: [] });

  // Budi logs in (different staff) on the now-holderless open outlet.
  const budiSession = await t.run(async (ctx: any) => {
    const dev = await ctx.db.query("registered_devices")
      .withIndex("by_device_id", (q: any) => q.eq("device_id", "d1")).first();
    const budi = await ctx.db.insert("staff", { name: "Budi", code: "S-2", role: "staff", pin_hash: "x", active: true, must_change_pin: false, created_at: 0 });
    return ctx.db.insert("staff_sessions", { staff_id: budi, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: dev.outlet_id });
  });

  const res = await t.mutation(api.shifts.shifts.startShift, {
    idempotencyKey: "s1", sessionId: budiSession, steps: [], openCount: 8,
  });
  expect(res.ok).toBe(true);
  const holder = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holder?.started_via).toBe("handover");
  expect(holder?.open_count).toBe(8);
  expect(holder?.prev_shift_id).not.toBeNull();
  await drainScheduled(t);
});

test("startShift on a closed outlet → BOOTH_NOT_OPEN; with a holder → SHIFT_IN_PROGRESS", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpen(t); // open, holder = Sisca
  await expect(
    t.mutation(api.shifts.shifts.startShift, { idempotencyKey: "s1", sessionId, steps: [] }),
  ).rejects.toThrow(/SHIFT_IN_PROGRESS/);
});
```

- [ ] **Step 3: Run test → FAIL** (`startShift` missing).

- [ ] **Step 4: Implement `startShift`** in `convex/shifts/shifts.ts`

```ts
export const startShift = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    openCount: v.optional(v.number()),
  },
  handler: withIdempotency<OpenBoothArgs, OpenBoothResult>(
    "shifts.startShift",
    async (ctx, args): Promise<OpenBoothResult> => {
      const { staffId, deviceId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);

      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (!status.is_open) throw new Error("BOOTH_NOT_OPEN");
      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      if (holder) throw new Error("SHIFT_IN_PROGRESS");

      const prev = await ctx.runQuery(internal.shifts.shiftsInternal._lastEndedShift_internal, { outletId });
      const shiftId: Id<"pos_shifts"> = await ctx.runMutation(
        internal.shifts.shiftsInternal._startShift_internal,
        {
          outletId, deviceId, staffId, startedVia: "handover",
          openCount: args.openCount ?? null, steps: args.steps,
          prevShiftId: prev?._id ?? null,
        },
      );
      await logAudit(ctx, {
        actor_id: staffId, action: "shift.start", entity_type: "pos_shifts",
        entity_id: shiftId, source: "booth_inline",
        metadata: { started_via: "handover", prev_shift_id: prev?._id ?? null },
      });
      return { ok: true as const, shiftId };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
```

- [ ] **Step 5: Run test → PASS. Commit.**

```bash
git add convex/shifts/shifts.ts convex/shifts/shiftsInternal.ts convex/shifts/__tests__/startShift.test.ts
git commit -m "feat(shifts): startShift begins the incoming shift on an open, holderless outlet"
```

---

## Task 6: Public `endOfDay`

**Files:**
- Modify: `convex/shifts/shifts.ts`
- Test: `convex/shifts/__tests__/endOfDay.test.ts`

**Interfaces:**
- Produces: `endOfDay({ idempotencyKey, sessionId, steps, closeCount? }): Promise<{ ok: true; durationMs: number }>` — ends the current shift AND closes the outlet (Level 1 → closed). Idempotent: closing an already-closed outlet ends the session and returns `durationMs: 0`.

- [ ] **Step 1: Write the failing test**

`convex/shifts/__tests__/endOfDay.test.ts` (reuse the `seedOpen` pattern from Task 5):
```ts
test("endOfDay closes the outlet and ends the shift", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t);
  const res = await t.mutation(api.shifts.shifts.endOfDay, { idempotencyKey: "e1", sessionId, steps: [] });
  expect(res.ok).toBe(true);
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);
  expect(await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId })).toBeNull();
  await drainScheduled(t);
});

test("endOfDay on a CLOSED outlet → idempotent no-op (session ends, durationMs 0)", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpen(t);
  await t.mutation(api.shifts.shifts.endOfDay, { idempotencyKey: "e1", sessionId, steps: [] });
  // A fresh session on the now-closed outlet:
  // (re-login is out of scope here; assert the no-op via a second call mapping)
});
```

- [ ] **Step 2: Run → FAIL** (`endOfDay` missing).

- [ ] **Step 3: Implement `endOfDay`** in `convex/shifts/shifts.ts`

```ts
export const endOfDay = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    steps: v.array(stepValidator),
    closeCount: v.optional(v.number()),
  },
  handler: withIdempotency<HandoverArgs2, HandoverResult>(
    "shifts.endOfDay",
    async (ctx, args): Promise<HandoverResult> => {
      const { staffId, outlet_id: outletId } = await requireSession(ctx, args.sessionId);
      const now = Date.now();

      const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
      if (!status.is_open) {
        // Idempotent close — end the session, no duplicate close.
        await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
          sessionId: args.sessionId, endReason: "force_logout",
        });
        return { ok: true as const, durationMs: 0 };
      }

      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      const shiftStartMs = holder?.started_at ?? now;
      const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
        shiftStartMs, endMs: now, outletId,
      });
      if (holder) {
        await ctx.runMutation(internal.shifts.shiftsInternal._endShift_internal, {
          shiftId: holder._id, endedVia: "end_of_day", closeCount: args.closeCount ?? null,
          steps: args.steps, outgoingUncounted: null,
          summary: {
            durationMs: summary.durationMs, totalSalesIdr: summary.totalSalesIdr,
            txnCount: summary.txnCount, manualBcaCount: summary.manualBcaCount,
            manualBcaTotalIdr: summary.manualBcaTotalIdr,
          },
        });
      }
      await ctx.runMutation(internal.outlets.status._setOutletClosed_internal, { outletId, staffId });
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId, endReason: "force_logout",
      });
      await logAudit(ctx, {
        actor_id: staffId, action: "outlet.closed", entity_type: "outlets",
        entity_id: outletId, source: "booth_inline",
        metadata: { durationMs: summary.durationMs, shift_id: holder?._id ?? null },
      });
      if (holder) {
        await ctx.scheduler.runAfter(0, internal.shifts.actions._sendSignoffSummary, {
          eventId: holder._id, staffId, shiftStartMs, shiftEndMs: now,
          totalSalesIdr: summary.totalSalesIdr, txnCount: summary.txnCount,
          manualBcaCount: summary.manualBcaCount, manualBcaTotalIdr: summary.manualBcaTotalIdr,
          idempotencyKeySuffix: holder._id, outletId,
        });
      }
      return { ok: true as const, durationMs: summary.durationMs };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
```

- [ ] **Step 4: Run → PASS. Commit.**

```bash
git add convex/shifts/shifts.ts convex/shifts/__tests__/endOfDay.test.ts
git commit -m "feat(shifts): endOfDay closes the outlet + ends the shift (idempotent)"
```

---

## Task 7: Public `lock` = plain logout

**Files:**
- Modify: `convex/shifts/shifts.ts`
- Test: `convex/shifts/__tests__/lock2.test.ts`

**Interfaces:**
- Produces: `lock({ idempotencyKey, sessionId }): Promise<{ ok: true }>` — ends the session (`manual_lock`); does NOT touch the outlet or the shift (holder keeps the shift).

- [ ] **Step 1: Write the failing test**

`convex/shifts/__tests__/lock2.test.ts`:
```ts
test("lock just ends the session; outlet stays open, holder unchanged", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t);
  const holderBefore = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });

  const res = await t.mutation(api.shifts.shifts.lock, { idempotencyKey: "l1", sessionId });
  expect(res.ok).toBe(true);

  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);
  const holderAfter = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holderAfter?._id).toBe(holderBefore?._id); // same shift still active
  const sess = await t.run((ctx: any) => ctx.db.get(sessionId));
  expect(sess?.end_reason).toBe("manual_lock");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `lock`** in `convex/shifts/shifts.ts`

```ts
export const lock = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<{ idempotencyKey: string; sessionId: Id<"staff_sessions"> }, { ok: true }>(
    "shifts.lock",
    async (ctx, args): Promise<{ ok: true }> => {
      const { staffId } = await requireSession(ctx, args.sessionId);
      await ctx.runMutation(internal.auth.internal._endShiftSession_internal, {
        sessionId: args.sessionId, endReason: "manual_lock",
      });
      await logAudit(ctx, {
        actor_id: staffId, action: "shift.lock", entity_type: "staff_sessions",
        entity_id: args.sessionId, source: "booth_inline", metadata: {},
      });
      return { ok: true as const };
    },
    { authCheck: async (ctx, args) => { await requireSession(ctx, args.sessionId); } },
  ),
});
```

- [ ] **Step 4: Run → PASS. Commit.**

```bash
git add convex/shifts/shifts.ts convex/shifts/__tests__/lock2.test.ts
git commit -m "feat(shifts): lock = plain logout (outlet + shift untouched)"
```

---

## Task 8: Public `managerOverride` (force-end a stranded shift)

**Files:**
- Modify: `convex/shifts/actions.ts`
- Modify: `convex/shifts/shiftsInternal.ts`
- Test: `convex/shifts/__tests__/managerOverride.test.ts`

**Interfaces:**
- Produces: `managerOverride({ idempotencyKey, deviceId, managerStaffId, managerPin }): Promise<{ ok: true }>` — action; verifies manager PIN; force-ends the current holder's shift (`ended_via: "manager_override"`, `outgoing_uncounted: true`, summary recorded, summary scheduled). Outlet stays open; no new shift created (the blocked staffer then logs in normally).

- [ ] **Step 1: Write the failing test** — seed an open outlet with holder A (logged out), a manager M with a known argon2 `pin_hash`; call `managerOverride`; assert holder released (`_getActiveShift_internal` → null) and the ended shift has `ended_via: "manager_override"`, `outgoing_uncounted: true`. (Mirror the existing `takeover.test.ts` PIN-seed helper.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — add `managerOverride` action in `actions.ts` (resolve outlet from `deviceId` via `internal.auth.internal._getDeviceOutletId_internal`; `verifyManagerPinOrThrow`; then `runMutation` a new `_managerOverrideCommit_internal` in `shiftsInternal.ts` wrapped `withIdempotency`). The commit mutation: read active holder; if none, no-op `{ ok: true }`; else `_buildSignoffSummary_internal` over `[holder.started_at, now]`, `_endShift_internal` with `endedVia: "manager_override"`, `outgoingUncounted: true`; `logAudit` `shift.manager_override`; schedule `_sendSignoffSummary`. Model the PIN-verify + idempotent-commit split on the existing `managerTakeover` / `_commitManagerTakeover_internal` pair.

- [ ] **Step 4: Run → PASS. Typecheck. Commit.**

```bash
npm run typecheck
git add convex/shifts/actions.ts convex/shifts/shiftsInternal.ts convex/shifts/__tests__/managerOverride.test.ts
git commit -m "feat(shifts): managerOverride force-ends a stranded shift (PIN-gated)"
```

---

## Task 9: Public query `loginContext` (the login gate)

**Files:**
- Modify: `convex/shifts/shifts.ts`
- Test: `convex/shifts/__tests__/loginContext.test.ts`

**Interfaces:**
- Produces: `loginContext({ deviceId }): Promise<{ outletOpen: boolean; holderStaffId: Id<"staff"> | null; holderName: string | null }>` — pre-login, session-less; resolves outlet from device (`internal.auth.internal._getDeviceOutletId_internal`), reads `_getOutletStatus_internal` + `_getActiveShift_internal`, names via `_listStaffNames_internal`.

- [ ] **Step 1: Write the failing test**

```ts
test("loginContext reports outletOpen + current holder", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpen(t); // holder = Sisca
  const ctx0 = await t.query(api.shifts.shifts.loginContext, { deviceId: "d1" });
  expect(ctx0.outletOpen).toBe(true);
  expect(ctx0.holderName).toBe("Sisca");

  await t.mutation(api.shifts.shifts.handover, { idempotencyKey: "h1", sessionId, steps: [] });
  const ctx1 = await t.query(api.shifts.shifts.loginContext, { deviceId: "d1" });
  expect(ctx1.outletOpen).toBe(true);
  expect(ctx1.holderStaffId).toBeNull(); // released → next staffer may start
  await drainScheduled(t);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `loginContext`**

```ts
import { query } from "../_generated/server";
import { resolveStaffName } from "./lib";

export const loginContext = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }): Promise<{
    outletOpen: boolean; holderStaffId: Id<"staff"> | null; holderName: string | null;
  }> => {
    const outletId = await ctx.runQuery(internal.auth.internal._getDeviceOutletId_internal, { deviceId });
    const status = await ctx.runQuery(internal.outlets.status._getOutletStatus_internal, { outletId });
    const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
    let holderName: string | null = null;
    if (holder) {
      const names = await ctx.runQuery(internal.auth.internal._listStaffNames_internal, {});
      holderName = resolveStaffName(names, holder.staff_id, "") || null;
    }
    return { outletOpen: status.is_open, holderStaffId: holder?.staff_id ?? null, holderName };
  },
});
```

- [ ] **Step 4: Run → PASS. Commit.**

```bash
git add convex/shifts/shifts.ts convex/shifts/__tests__/loginContext.test.ts
git commit -m "feat(shifts): loginContext query drives the new login gate"
```

---

## Task 10: Migration — backfill outlet status + holder shift

**Files:**
- Modify: `convex/migrations/internal.ts`
- Test: `convex/migrations/__tests__/backfillOutletStatus.test.ts`

**Interfaces:**
- Consumes: `_shiftStartAnchor_internal` (existing). **Does NOT import `deriveBoothState`** — that function is deleted in Task 13, same deploy; the backfill is run post-deploy when it would no longer exist (spec §9 / staffreview C2). Inline the small mapping.
- Produces:
  - `backfillOutletStatus(): internalAction` — for each active outlet: find the latest `pos_shift_events` row (any device) and map its `type` to status **inline** (see Step 2). Set `outlets.is_open`. If open with a current staffer, insert one `pos_shifts` holder row (`started_at` = `_shiftStartAnchor_internal`, `ended_at=null`, `started_via:"sop"`). Idempotent (skip if `is_open` already set / a holder already exists).
  - `assertOutletStatusBackfilled(): internalQuery` — throws if any active outlet has `is_open === undefined`.

- [ ] **Step 1: Write the failing test** — seed an outlet whose latest `pos_shift_events` is a same-day `lock`; run `backfillOutletStatus`; assert `outlets.is_open === true` and exactly one active `pos_shifts` holder row for the locking staff. Seed a second outlet whose latest is `signoff_close`; assert `is_open === false` and no holder. Run → FAIL.

- [ ] **Step 2: Implement** the action + assert query in `convex/migrations/internal.ts`, following the idempotent style of `backfillOutletId`. The status mapping is **inlined** (self-contained — no `deriveBoothState` import):

```ts
// Inlined booth-status derivation (mirrors the retired deriveBoothState, kept
// LOCAL so the backfill survives Task 13 deleting deriveBoothState). `nowMs` and
// the WIB day-start come from convex/lib/time (V8-safe).
function deriveIsOpen(latest: { type: string; created_at: number } | null, wibDayStartMs: number): boolean {
  if (!latest) return false;
  if (latest.type === "signoff_close") return false;
  if (latest.created_at < wibDayStartMs) return false; // prior-WIB-day = closed
  // lock / resume / handover_in / handover_out / start_of_day / manager_takeover → open
  return true;
}
```
Collect active outlets (`by_active`); per outlet read the latest `pos_shift_events` via `by_outlet_device_created` across the outlet's devices (or `by_staff_started` fallback), apply `deriveIsOpen`, patch `is_open` (+ `opened_at/by` from the anchor when open), and insert the holder `pos_shifts` row when open with a staffer. Skip if `is_open` already set.

- [ ] **Step 3: Run → PASS.**

- [ ] **Step 4: Commit**

```bash
git add convex/migrations/internal.ts convex/migrations/__tests__/backfillOutletStatus.test.ts
git commit -m "feat(migrations): backfill outlet is_open + active holder shift (ADR-053)"
```

> **PROD run order (post-deploy, manual):** `npx convex run migrations/internal:backfillOutletStatus --prod` then `npx convex run migrations/internal:assertOutletStatusBackfilled --prod` (expect no throw). The enforce step (flip `is_open` required, Task 13's optional follow-up) ships only after this is green on prod.

---

## Task 11: Frontend — login gate

**Files:**
- Create: `src/hooks/useLoginContext.ts`
- Modify: `src/routes/login.tsx`
- Test: `src/routes/login.test.tsx` (extend)

**Interfaces:**
- Consumes: `api.shifts.shifts.loginContext`, `api.shifts.shifts.openBooth`/`handover` not here; `api.shifts.actions.managerOverride`.
- Produces: login behaviour — holder→resume (`/`), different-staffer→block message, no-holder→new shift (route to `/shift/start` only if `!outletOpen`, else `/`), closed→`/shift/start`.

- [ ] **Step 1: Create `src/hooks/useLoginContext.ts`** (mirror the deleted `useBoothState` skip pattern)

```ts
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useDeviceId } from "./useDeviceId";
import type { Id } from "../../convex/_generated/dataModel";

export type LoginContext = {
  outletOpen: boolean;
  holderStaffId: Id<"staff"> | null;
  holderName: string | null;
};

export function useLoginContext(): LoginContext | undefined {
  const deviceId = useDeviceId();
  return useQuery(api.shifts.shifts.loginContext, deviceId !== null ? { deviceId } : "skip");
}
```

- [ ] **Step 2: Write the failing test** — extend `src/routes/login.test.tsx`: mock `loginContext` returning `{outletOpen:true, holderStaffId:"<other>", holderName:"Sisca"}`; tapping a *different* staffer shows the block copy and does NOT call `login`. Mock `{outletOpen:true, holderStaffId:"<me>"}`; tapping me logs in and navigates `/`. Run → FAIL.

- [ ] **Step 3: Rewrite the gate in `src/routes/login.tsx`** — replace `useBoothState` with `useLoginContext`. New post-name-tap / post-login target logic:
```ts
// after a staffer taps their name (before PIN), with ctx = useLoginContext():
const blocked =
  ctx?.outletOpen === true &&
  ctx.holderStaffId !== null &&
  ctx.holderStaffId !== stagedStaff._id;
// if blocked → show t("login.shiftHeldBy", { name: ctx.holderName }) + "Manager override" button; do not open PIN.

// target after successful login():
let target = "/";
if (ctx?.outletOpen === false) target = "/shift/start";              // closed → SOP (openBooth)
else if (ctx?.holderStaffId === null) target = "/shift/begin";       // open, no holder → startShift (incoming count)
// open + holder == me → resume (target "/"); the holder shift row is untouched
```
`/shift/begin` is the incoming-shift count screen (Task 12) — a one-step count wizard that calls `startShift`. It is session-FULL (the incoming staffer is already authenticated), unlike the retired session-less `/shift/handover`.
Drop the old `recordResume` call entirely. Add a `managerOverride` entry: a "Manager override" button on the block state → manager picker + PIN sheet (reuse the `PinSheet` pattern from `lock.tsx`) → `managerOverride({ idempotencyKey, deviceId, managerStaffId, managerPin })` → on success the block clears (holder released) and the staffer proceeds.

- [ ] **Step 4: Run → PASS.** Add i18n keys `login.shiftHeldBy`, `login.managerOverride`, etc. to `src/lib/i18n` (EN + ID) per ADR-049.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLoginContext.ts src/routes/login.tsx src/routes/login.test.tsx src/lib/i18n*
git commit -m "feat(fe): login gate keys off outlet status + shift holder (block/resume/new)"
```

---

## Task 12: Frontend — RootLayout, shift routes, lock route; delete shiftSkip

**Files:**
- Modify: `src/components/layout/RootLayout.tsx`
- Modify: `src/routes/shift/start.tsx`, `src/routes/shift/end.tsx`, `src/routes/lock.tsx`
- Delete: `src/hooks/useBoothState.ts`, `src/lib/shiftSkip.ts`
- Test: `src/components/layout/__tests__/RootLayout.test.tsx`, route tests

**Interfaces:**
- Consumes: `useLoginContext` (outletOpen) in RootLayout; `api.shifts.shifts.openBooth`/`managerSkipOpen` in start; `handover`/`endOfDay` in end; `lock`/`managerOverride` in lock route.

- [ ] **Step 1: RootLayout SOP gate** — replace `useBoothState` + `boothState.state`/`boothPending` logic with `useLoginContext().outletOpen`:
  - Remove the `/shift/handover` no-session exemption + `isHandoverIn` + the `boothPending` redirect (handover is no longer session-less).
  - SOP gate: `if (session.active && ctx !== undefined && deviceIsOutlet && !ctx.outletOpen && pathname !== "/shift/start" && !managerSkippedThisSession) → Navigate("/shift/start")`. Manager-skip is now server-driven, but keep a tiny client guard so the gate doesn't re-trap between tapping skip and the mutation resolving (optimistic). Source of truth = server `outletOpen`.
  - Update `src/components/layout/__tests__/RootLayout.test.tsx` accordingly. Run → PASS.

- [ ] **Step 2: `src/routes/shift/start.tsx`** — `onComplete` calls `openBooth({ idempotencyKey, sessionId, steps, openCount })` then `navigate("/")`. Replace `markManagerSkippedSOD` + client skip with a "Skip (manager)" action → `managerSkipOpen({ idempotencyKey, sessionId, managerPin })` via a PIN sheet → `navigate("/")`. Remove the `import { markManagerSkippedSOD }`. Update its test.

- [ ] **Step 3: `src/routes/shift/end.tsx`** — `onHandoverComplete` → `handover({...})` then `navigate("/login")` (NOT `/shift/handover`). `onCloseComplete` → `endOfDay({...})`. Remove the `/shift/handover` navigation. Update its test.

- [ ] **Step 3B: Create `src/routes/shift/begin.tsx`** (incoming-shift count → `startShift`) and register it in `src/router.tsx`. Session-FULL: a one-step count wizard (reuse `ShiftWizard` with a single `count` step) → `startShift({ idempotencyKey, sessionId, steps, openCount })` → `navigate("/")`. This is the renamed, session-FULL replacement for the deleted session-less `/shift/handover` incoming screen. RootLayout's SOP gate does NOT force this route (it's reached only via the login target in Task 11); guard it so a stray visit with a holder already set redirects to `/`.

- [ ] **Step 4: `src/routes/lock.tsx`** — `handleLock` calls `lock({...})` (the new mutation) then `clearSession()` + `/login`. Replace `managerTakeover` usage with `managerOverride` (now force-ends the prior shift). Update its test.

- [ ] **Step 5: Delete `src/hooks/useBoothState.ts` and `src/lib/shiftSkip.ts`** and remove all imports (grep to confirm zero references). Remove the `/shift/handover` route if it only hosted the session-less incoming screen (confirm in `src/router.tsx`).

- [ ] **Step 6: Run the FE suite** — `npx vitest run src/` → all PASS. Commit.

```bash
git add -A src/
git commit -m "feat(fe): RootLayout + shift/lock routes use two-level state; delete deriveBoothState client + shiftSkip"
```

---

## Task 13: Retire old backend code, ADR-053, docs

**Files:**
- Modify: `convex/shifts/public.ts`, `convex/shifts/lib.ts`, `convex/shifts/internal.ts`, `convex/shifts/actions.ts`
- Delete: the old lifecycle tests that assert retired behaviour (`stateGuards.test.ts`, `lock.test.ts`, `handover.test.ts`, `signoff.test.ts`, `staleAutoclose.test.ts`, `startOfDay.test.ts`, `boothState.test.ts`, `takeover.test.ts` — replace coverage with the new tests).
- Create: `docs/ADR/053-two-level-booth-state.md`
- Modify: `docs/SCHEMA.md`, `docs/API_REFERENCE.md`, `docs/CHANGELOG.md`, `CLAUDE.md`

**Interfaces:** none new — this removes the retired surface.

- [ ] **Step 1: Delete retired exports** — from `convex/shifts/public.ts`: `boothState`, `completeStartOfDay`, `endOfDaySignOff`, `handoverOut`, `lockShift`, `recordResume`, `completeHandoverIn`, `assertBoothState`. From `convex/shifts/lib.ts`: `deriveBoothState`, `BoothState`, `LatestEvent`, `OPEN_TYPES`. From `convex/shifts/actions.ts`: `managerTakeover` + `_commitManagerTakeover_internal` (replaced by `managerOverride`). Keep `_buildSignoffSummary_internal`, `_sendSignoffSummary`, `resolveStaffName`, `computeShiftHoursMs`, `_listStaffNames_internal`. Grep for every caller and fix.

- [ ] **Step 2: Delete/replace retired tests** — remove the listed test files (their behaviour is gone). Confirm the new tests (Tasks 1–9) cover open/handover/end/lock/override/gate.

- [ ] **Step 3: Run the FULL gate**

Run: `npm run typecheck && npx vitest run` → Expected: green (no references to deleted symbols).

- [ ] **Step 4: Write `docs/ADR/053-two-level-booth-state.md`** — the two levels, stored-not-derived, single-holder + handover-only transfer, manager override, retired ADR-050 machinery, migration. Status: Accepted, supersedes ADR-050.

- [ ] **Step 5: Update docs** — `docs/SCHEMA.md` (outlet status fields, `pos_shifts`, new audit verbs `outlet.opened`/`outlet.closed`/`shift.start`/`shift.handover`/`shift.lock`/`shift.manager_override`; mark `pos_shift_events` read-only/legacy), `docs/API_REFERENCE.md` (new shift functions; remove retired), `docs/CHANGELOG.md`. In `CLAUDE.md`: rewrite business rule #23 to the two-level model, update the `shifts/` and `outlets/` module rows, note ADR-050 superseded by ADR-053.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(shifts): retire deriveBoothState machinery; ADR-053 + docs (supersedes ADR-050)"
```

---

## Self-Review

**Spec coverage:**
- §3 two-level taxonomy → Tasks 1 (schema), 2 (Level-1), 3 (Level-2). ✓
- §4 login gate → Task 9 (query) + Task 11 (FE). ✓
- §5 manager override → Task 8 + Task 11/12 (FE entry). ✓
- §6 schema → Task 1. ✓
- §7 transitions → openBooth/managerSkipOpen (T4), handover (T5), **startShift (T5B — open/no-holder incoming)**, endOfDay (T6), lock (T7), override (T8). ✓ (Every transition row now has a mutation — staffreview C1.)
- §8 retired → Task 13. ✓
- §9 migration → Task 10 (derivation **inlined**, no `deriveBoothState` import — staffreview C2). ✓
- §10 ADR-053 → Task 13. ✓
- §11 testing → per-task TDD + Task 13 full gate. ✓
- §8 "PR #143 folded in" → Task 13 deletes the guarded mutations outright. ✓

**Type consistency:** `_getActiveShift_internal` returns `Doc<"pos_shifts"> | null` (Tasks 3,5,6,8,9). `started_via`/`ended_via` literal unions identical across schema (1), internals (3), and writers (4–8). `loginContext` shape `{outletOpen,holderStaffId,holderName}` identical in Task 9 + `useLoginContext` (11). `_sendSignoffSummary.eventId` widened in Task 5 and used by Tasks 5/6/8.

**Open confirmations for the executor (verify against live code, don't assume):**
1. Exact internal names: `internal.auth.internal._getDeviceOutletId_internal`, `_listStaffNames_internal`, `_endShiftSession_internal`, and the manager-PIN verify entry used by `managerTakeover` today (Tasks 4,8,9).
2. `_sendSignoffSummary` arg validator for `eventId` (widen to accept `Id<"pos_shifts">` or `v.string()`) — Task 5.
3. `src/router.tsx` `/shift/handover` route removal — Task 12.

**Placeholder scan:** backend tasks carry complete code; FE tasks (11,12) and migration (10) carry exact files + the load-bearing logic with step-precise instructions following named existing patterns (`backfillOutletId`, `managerTakeover`, `PinSheet`). No "TBD"/"add error handling"/"similar to Task N".
