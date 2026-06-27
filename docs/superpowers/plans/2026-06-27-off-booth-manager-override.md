# Off-booth Manager Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager release a stranded/blocked booth remotely from Telegram by approving a `shift_override` with their staff code + PIN, choosing to close the booth or release it open — while keeping the booth-inline override as the present-manager fast path.

**Architecture:** Add `"shift_override"` as a new approval KIND (CLAUDE.md rule #19 / "How to add a feature" #8) reusing the entire off-booth approval envelope (`pos_approval_requests`, single-use hashed token, `/approve/:token`, per-outlet Telegram routing, argon2 code+PIN verify). The booth-side request is **session-less** (the blocked staffer has no session) — keyed on `deviceId`. Both the off-booth approve and the existing booth-inline `managerOverride` funnel through one shared commit that ends the stranded `pos_shifts` hold and optionally closes the outlet.

**Tech Stack:** Convex 1.31.7 (V8 mutations + `"use node"` actions), React 19 + TS + Vite, convex-test + vitest, Tailwind 4 / shadcn, i18n typed dictionaries (ADR-049).

## Global Constraints

- **Money = integer rupiah** (ADR-015); format via `src/lib/format.ts`. No floats.
- **Server time wins** (ADR-031): every `_at` via `Date.now()` inside the function.
- **Public mutations**: not applicable here — the new public surfaces are **actions** (idempotency via action-level `_lookup_internal`/`_writeCache_internal`, ADR-013), matching `approveSpoilage`.
- **Token authorises VIEW, PIN authorises ACT** (ADR-029): token single-use, 60-min TTL, SHA-256 hashed at rest, raw token only in the URL.
- **Off-booth PIN miss must NOT touch booth lockout** (SEC-07): `_recordFailedAttempt_internal({ countTowardLockout:false, deviceId:"approve-route", source:"telegram_approval" })` + per-token cap `_recordTokenPinFailure_internal`.
- **Per-outlet routing** (Spec 4): outlet resolved from the booth **device** (session-less), never a client `outlet_id` arg (ADR-051); card routes via `resolveOutletChatId(ctx,"managers",outletId)`.
- **i18n** (ADR-049): all new copy goes in `src/lib/i18n/dictionaries/{en,id}.ts`; brand names as JSX expressions; no literal toast args in fenced files.
- **Audit** `audit_log.action` is a free `v.string()` — no enum to edit; document new verbs in SCHEMA.md.

---

## Task List

| ID | Title | Files touched | Wave | Depends-on |
|----|-------|---------------|------|------------|
| T1 | `shift_override` kind plumbing + context validator | `convex/approvals/kinds.ts`, `convex/approvals/schema.ts`, `convex/approvals/internal.ts`, `convex/approvals/__tests__/kinds.test.ts` | 1 | — |
| T2 | Shared commit: `closeOutlet`+`source`; inline `managerOverride` gains `resultingState` | `convex/shifts/shiftsInternal.ts`, `convex/shifts/actions.ts`, `convex/shifts/__tests__/*` | 1 | — |
| T3 | Telegram template `shift_override` | `convex/lib/telegramHtml.ts`, `convex/telegram/send.ts`, `convex/lib/__tests__/telegramHtml.test.ts` | 1 | — |
| T4 | `requestShiftOverride` action (session-less) | `convex/approvals/actions.ts`, `convex/approvals/__tests__/shiftOverride.test.ts` | 2 | T1, T2, T3 |
| T5 | `approveShiftOverride` action | `convex/approvals/actions.ts`, `convex/approvals/__tests__/shiftOverride.test.ts` | 2 | T1, T2, T4 |
| T6 | `/approve` `ShiftOverride` component | `src/routes/approve/index.tsx`, `src/lib/i18n/dictionaries/{en,id}.ts`, `src/routes/approve/__tests__/*` | 3 | T5 |
| T7 | `login.tsx` two-path override (inline + Request via Telegram) | `src/routes/login.tsx`, `src/lib/i18n/dictionaries/{en,id}.ts`, `src/routes/__tests__/login*.test.tsx` | 3 | T4 |
| T8 | Docs + close-out | `docs/SCHEMA.md`, `docs/API_REFERENCE.md`, `CLAUDE.md`, `docs/CHANGELOG.md`, `docs/ROADMAP.md` | 4 | T1–T7 |

---

## Execution Strategy — multi-agent, wave-gated

**Wave dispatch map**
- **Wave 1 (3-wide parallel):** T1 ∥ T2 ∥ T3 — disjoint modules (approvals / shifts / telegram), no shared files. **Gate:** all three merged + `npx convex codegen` run once on the merged tree (T2 changes `managerOverride`'s arg type; T1/T3 add validators) + `npm run typecheck` green.
- **Wave 2 (SERIAL):** T4 → T5 — **both edit `convex/approvals/actions.ts`**, so they run sequentially in one worktree (T4 first, then T5 on T4's tree). **Gate:** `npx convex codegen` (T4/T5 add public actions) + typecheck + `npx vitest run convex/approvals` green.
- **Wave 3 (SERIAL on i18n):** T6 → T7 — different route files (`approve/index.tsx` vs `login.tsx`) but **both append to `src/lib/i18n/dictionaries/{en,id}.ts`**; run sequentially to avoid dict collisions. **Gate:** typecheck + `npx vitest run src/routes` green.
- **Wave 4 (main session):** T8 docs + the QA close-out.

**Shared-file / generated-file serialization**
- `convex/approvals/actions.ts` — T4 + T5 → **serial** (Wave 2 is one worktree, two commits).
- `convex/approvals/internal.ts` + `convex/approvals/schema.ts` — only T1 writes them (the kind union appears in 3 spots: schema, `_createRequest_internal`, `_listPendingByKind_internal` — all in T1).
- `src/lib/i18n/dictionaries/{en,id}.ts` — T6 + T7 → **serial** (Wave 3 sequential).
- `convex/_generated/api.d.ts` — **never hand-edit**; run `npx convex codegen` once per wave on the merged tree, not per task.

**Critical path (sequential spine):** T1 → T4 → T5 → T7 → T8. T2/T3 are off-path (land in Wave 1 alongside T1); T6 parallels T7's start but shares the i18n gate. Minimum wall-clock ≈ Wave1 + (T4+T5) + (T6/T7) + T8.

**What can't be done headless**
- Live Telegram delivery of the `shift_override` card + tapping the real `/approve/:token` link (needs a bound `managers` chat + bot). Backend logic is fully covered by `convex-test`; the live round-trip is **persona-UAT, flagged `pending: needs live env`** if the executor can't stand up `npx convex dev` + a Telegram chat.
- `/persona-uat` of the booth login two-path + `/approve` `ShiftOverride` screen — needs `npm run dev` + `npx convex dev` + `npx convex run seed/actions:reset`. If unavailable headless → flag pending, don't claim done.

**Close-out (main session, NOT a background agent):** after T8 — `/triple-review` (address every Critical + Improvement) → `/simplify xhigh` → `/persona-uat` (FE journeys impacted: login override + `/approve`). Re-run typecheck + full vitest after fixes.

---

## File Structure

- `convex/approvals/kinds.ts` — add the kind to the union + `ShiftOverrideContext` type + `validateContext` case + `KIND_AUDIT` + `KIND_TEMPLATE` entries. (One responsibility: the kind registry.)
- `convex/approvals/schema.ts` + `convex/approvals/internal.ts` — add `v.literal("shift_override")` to the three kind unions (schema column, `_createRequest_internal`, `_listPendingByKind_internal`).
- `convex/approvals/actions.ts` — add `requestShiftOverride` (session-less request) + `approveShiftOverride` (copy of `approveSpoilage` envelope).
- `convex/shifts/shiftsInternal.ts` — `_managerOverrideCommit_internal` gains `closeOutlet` + `source`.
- `convex/shifts/actions.ts` — `managerOverride` gains `resultingState`, threads `closeOutlet` + `source:"booth_inline"`.
- `convex/lib/telegramHtml.ts` + `convex/telegram/send.ts` — `renderShiftOverride` + kind/payload union.
- `src/routes/approve/index.tsx` — `ShiftOverride` component (context card + Close/Release + code+PIN).
- `src/routes/login.tsx` — two-path override (inline `PinSheet` + Close/Release toggle; "Request via Telegram" button).
- `src/lib/i18n/dictionaries/{en,id}.ts` — new `approve.*` + `login.*` copy.

---

## Task Details

### Task 1: `shift_override` kind plumbing + context validator

**Files:**
- Modify: `convex/approvals/kinds.ts`
- Modify: `convex/approvals/schema.ts:7-12` (kind column union)
- Modify: `convex/approvals/internal.ts:22-27` and `:314-319` (the two kind unions)
- Test: `convex/approvals/__tests__/kinds.test.ts` (create or extend)

**Interfaces:**
- Produces: `ApprovalKind` now includes `"shift_override"`; `ShiftOverrideContext` type; `validateContext("shift_override", raw)` returns a normalized bag; `KIND_AUDIT["shift_override"]` = `{requested:"shift_override.requested", resolved:"shift_override.approval_resolved", denied:"shift_override.denied"}`; `KIND_TEMPLATE["shift_override"]="shift_override"`.

- [ ] **Step 1: Write the failing test** — `convex/approvals/__tests__/kinds.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { validateContext, KIND_AUDIT, KIND_TEMPLATE } from "../kinds";

describe("shift_override kind", () => {
  const good = {
    shift_id: "shift123", device_id: "dev-1", outlet_label: "Block M",
    stranded_staff_name: "Sasi", shift_started_at: 1782526962094,
    sales_so_far_idr: 385000, txn_count: 5,
  };
  it("accepts a valid context", () => {
    expect(validateContext("shift_override", good)).toMatchObject({
      shift_id: "shift123", device_id: "dev-1", sales_so_far_idr: 385000, txn_count: 5,
    });
  });
  it("rejects empty shift_id", () => {
    expect(() => validateContext("shift_override", { ...good, shift_id: "" })).toThrow(/CONTEXT_INVALID/);
  });
  it("rejects non-integer sales", () => {
    expect(() => validateContext("shift_override", { ...good, sales_so_far_idr: 1.5 })).toThrow(/CONTEXT_INVALID/);
  });
  it("registers audit + template maps", () => {
    expect(KIND_AUDIT.shift_override.requested).toBe("shift_override.requested");
    expect(KIND_TEMPLATE.shift_override).toBe("shift_override");
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `npx vitest run convex/approvals/__tests__/kinds.test.ts`
Expected: FAIL — `validateContext` has no `shift_override` case / type error on union.

- [ ] **Step 3: Implement in `convex/approvals/kinds.ts`**

Add to the union:
```ts
export type ApprovalKind = "staff_pin_reset" | "manual_payment_override" | "refund" | "spoilage" | "shift_override";
```
Add the context type (near the other context types):
```ts
// v1.3.1: off-booth manager override of a stranded shift hold. Snapshotted at
// request time so the approver previews who/how-much before entering PIN.
export type ShiftOverrideContext = {
  shift_id: string;            // Id<"pos_shifts"> serialised — the active hold
  device_id: string;           // booth device; commit resolves outlet from it
  outlet_label: string;
  stranded_staff_name: string;
  shift_started_at: number;
  sales_so_far_idr: number;    // integer rupiah (ADR-015)
  txn_count: number;
};
```
Add the `validateContext` case (inside the `switch`):
```ts
    case "shift_override": {
      const c = (raw ?? {}) as Partial<ShiftOverrideContext>;
      if (typeof c.shift_id !== "string" || c.shift_id === "") throw new Error("CONTEXT_INVALID: shift_id");
      if (typeof c.device_id !== "string" || c.device_id === "") throw new Error("CONTEXT_INVALID: device_id");
      if (typeof c.outlet_label !== "string") throw new Error("CONTEXT_INVALID: outlet_label");
      if (typeof c.stranded_staff_name !== "string") throw new Error("CONTEXT_INVALID: stranded_staff_name");
      if (!Number.isInteger(c.shift_started_at)) throw new Error("CONTEXT_INVALID: shift_started_at");
      if (!Number.isInteger(c.sales_so_far_idr)) throw new Error("CONTEXT_INVALID: sales_so_far_idr");
      if (!Number.isInteger(c.txn_count)) throw new Error("CONTEXT_INVALID: txn_count");
      return {
        shift_id: c.shift_id, device_id: c.device_id, outlet_label: c.outlet_label,
        stranded_staff_name: c.stranded_staff_name, shift_started_at: c.shift_started_at,
        sales_so_far_idr: c.sales_so_far_idr, txn_count: c.txn_count,
      };
    }
```
Add to `KIND_AUDIT`:
```ts
  shift_override:          { requested: "shift_override.requested",          resolved: "shift_override.approval_resolved", denied: "shift_override.denied" },
```
Add to `KIND_TEMPLATE` (and widen its value union to include `"shift_override"`):
```ts
  shift_override: "shift_override",
```

- [ ] **Step 4: Add `v.literal("shift_override")` to the three kind unions**

In `convex/approvals/schema.ts:7-12`, `convex/approvals/internal.ts:22-27` (`_createRequest_internal`), and `convex/approvals/internal.ts:314-319` (`_listPendingByKind_internal`), add:
```ts
      v.literal("shift_override"), // v1.3.1: off-booth shift override
```
(Adding a literal to a union is additive/safe — no prod schema block; old rows are unaffected.)

- [ ] **Step 5: Run tests + typecheck — verify PASS**

Run: `npx vitest run convex/approvals/__tests__/kinds.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (the `KIND_AUDIT`/`KIND_TEMPLATE` `Record<ApprovalKind,…>` now requires the new key — added above).

- [ ] **Step 6: Commit**

```bash
git add convex/approvals/kinds.ts convex/approvals/schema.ts convex/approvals/internal.ts convex/approvals/__tests__/kinds.test.ts
git commit -m "feat(approvals): add shift_override kind + context validator"
```

---

### Task 2: Shared commit — `closeOutlet` + `source`; inline `managerOverride` gains `resultingState`

**Files:**
- Modify: `convex/shifts/shiftsInternal.ts:147-196` (`_managerOverrideCommit_internal`)
- Modify: `convex/shifts/actions.ts:92-130` (`managerOverride`)
- Test: `convex/shifts/__tests__/stateGuards.test.ts` (or a new `managerOverride.test.ts`)

**Interfaces:**
- Produces: `_managerOverrideCommit_internal({ idempotencyKey, deviceId, managerStaffId, closeOutlet, source })` → `{ ok: true }`. `shifts.managerOverride({ idempotencyKey, deviceId, managerStaffId, managerPin, resultingState: "close"|"release" })`.
- Consumes: `internal.outlets.status._setOutletClosed_internal({ outletId, staffId })`.

- [ ] **Step 1: Write the failing test**

```ts
// convex/shifts/__tests__/managerOverride.test.ts
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { seedOutletAndOpenShift } from "./_helpers"; // existing helper pattern — see stateGuards.test.ts

describe("_managerOverrideCommit_internal closeOutlet", () => {
  it("closeOutlet:true ends hold AND closes the outlet", async () => {
    const t = convexTest(schema);
    const { outletId, deviceId, managerId } = await seedOutletAndOpenShift(t);
    await t.mutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
      idempotencyKey: "k1", deviceId, managerStaffId: managerId, closeOutlet: true, source: "telegram_approval",
    });
    const status = await t.query(internal.outlets.status._getOutletStatus_internal, { outletId });
    expect(status.is_open).toBe(false);
    const hold = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
    expect(hold).toBeNull();
  });
  it("closeOutlet:false ends hold but leaves outlet open", async () => {
    const t = convexTest(schema);
    const { outletId, deviceId, managerId } = await seedOutletAndOpenShift(t);
    await t.mutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
      idempotencyKey: "k2", deviceId, managerStaffId: managerId, closeOutlet: false, source: "telegram_approval",
    });
    const status = await t.query(internal.outlets.status._getOutletStatus_internal, { outletId });
    expect(status.is_open).toBe(true);
    const hold = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
    expect(hold).toBeNull();
  });
});
```
> If `seedOutletAndOpenShift` does not exist, build it in `_helpers.ts` from the existing seed pattern in `stateGuards.test.ts` (insert outlet, registered_device bound to it, a staff manager, and an open `pos_shifts` via `_startShift_internal`). Folded into this task.

- [ ] **Step 2: Run — verify FAIL**

Run: `npx vitest run convex/shifts/__tests__/managerOverride.test.ts`
Expected: FAIL — commit doesn't accept `closeOutlet`/`source`.

- [ ] **Step 3: Implement the commit change** in `convex/shifts/shiftsInternal.ts`

Add to the `args` of `_managerOverrideCommit_internal`:
```ts
    closeOutlet: v.boolean(),
    source: v.union(v.literal("booth_inline"), v.literal("telegram_approval")),
```
Thread `source` into the `logAudit` call (replace the hardcoded `source: "booth_inline"`):
```ts
        source: args.source,
        metadata: { durationMs: summary.durationMs, displaced_staff_id: holder.staff_id,
          resulting_state: args.closeOutlet ? "closed" : "released" },
```
After the `_endShift_internal` call (and still inside the `if (holder)` branch, before the audit or after — either is fine since it's the same txn), add the close:
```ts
      if (args.closeOutlet) {
        await ctx.runMutation(internal.outlets.status._setOutletClosed_internal, {
          outletId, staffId: args.managerStaffId,
        });
      }
```
**Edge case (review §11):** when there is no active hold, the function currently early-returns `{ ok: true }`. For `closeOutlet:true` we still want to guarantee closed. Move the close to run **regardless of holder**:
```ts
      // ... after resolving outletId, before/independent of the holder branch:
      if (args.closeOutlet) {
        await ctx.runMutation(internal.outlets.status._setOutletClosed_internal, {
          outletId, staffId: args.managerStaffId,
        });
      }
      const holder = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
      if (!holder) return { ok: true as const };
      // ... existing end-shift + audit + telegram ...
```

- [ ] **Step 4: Update the inline action** in `convex/shifts/actions.ts:92`

Add `resultingState: v.union(v.literal("close"), v.literal("release"))` to `managerOverride`'s args; in the body's `runMutation` to `_managerOverrideCommit_internal`, pass:
```ts
        return ctx.runMutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
          idempotencyKey: `${args.idempotencyKey}:commit`,
          deviceId: args.deviceId,
          managerStaffId: args.managerStaffId,
          closeOutlet: args.resultingState === "close",
          source: "booth_inline",
        });
```

- [ ] **Step 5: Run tests + typecheck — verify PASS**

Run: `npx vitest run convex/shifts && npm run typecheck`
Expected: PASS. (Existing `managerOverride` callers — only `login.tsx` — will be updated in T7; the action arg is now required, so T7 must pass `resultingState`. Note this dependency.)

- [ ] **Step 6: Commit**

```bash
git add convex/shifts/shiftsInternal.ts convex/shifts/actions.ts convex/shifts/__tests__/
git commit -m "feat(shifts): shared override commit gains closeOutlet + source; inline managerOverride takes resultingState"
```

---

### Task 3: Telegram template `shift_override`

**Files:**
- Modify: `convex/lib/telegramHtml.ts` (add `renderShiftOverride`)
- Modify: `convex/telegram/send.ts:45-58` (kind union) + the per-kind `payload` validator + the dispatch switch
- Test: `convex/lib/__tests__/telegramHtml.test.ts`

**Interfaces:**
- Produces: `renderShiftOverride({ outlet_label, stranded_staff_name, shift_started_at, sales_so_far_idr, txn_count, approve_url })` → HTML string with a URL button; `sendTemplate` accepts `kind:"shift_override"` with that payload.

- [ ] **Step 1: Write the failing test**

```ts
// convex/lib/__tests__/telegramHtml.test.ts (extend)
import { renderShiftOverride } from "../telegramHtml";
it("renders shift_override card with approve URL button", () => {
  const html = renderShiftOverride({
    outlet_label: "Block M", stranded_staff_name: "Sasi",
    shift_started_at: 1782526962094, sales_so_far_idr: 385000, txn_count: 5,
    approve_url: "https://pos.example/approve/RAW",
  });
  expect(html).toContain("Block M");
  expect(html).toContain("Sasi");
  expect(html).toContain("https://pos.example/approve/RAW");
});
```

- [ ] **Step 2: Run — verify FAIL** — `npx vitest run convex/lib/__tests__/telegramHtml.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement `renderShiftOverride`** in `convex/lib/telegramHtml.ts`

Mirror an existing informational+button renderer (e.g. `renderManualPaymentOverride`). Use the shared HTML/number helpers already in the file (`escapeHtml`, the IDR formatter, and the inline-keyboard URL-button helper):
```ts
export function renderShiftOverride(p: {
  outlet_label: string; stranded_staff_name: string; shift_started_at: number;
  sales_so_far_idr: number; txn_count: number; approve_url: string;
}): { text: string; reply_markup: object } {
  const text =
    `<b>🔓 Manager override requested</b>\n` +
    `Outlet: <b>${escapeHtml(p.outlet_label)}</b>\n` +
    `Booth held by: <b>${escapeHtml(p.stranded_staff_name)}</b>\n` +
    `Sales so far: <b>${formatIdr(p.sales_so_far_idr)}</b> (${p.txn_count} txn)\n` +
    `Tap to review and release the booth.`;
  return { text, reply_markup: urlButton("Review & override", p.approve_url) };
}
```
> Match the EXACT return shape the other `render*` button functions use (some return a string, some `{text, reply_markup}`). Copy the shape of `renderManualPaymentOverride` verbatim so `sendTemplate`'s dispatch consumes it identically.

- [ ] **Step 4: Wire into `sendTemplate`** (`convex/telegram/send.ts`)

Add `v.literal("shift_override")` to the kind union (line ~58); add a `shift_override` branch to the `payload` validator + the dispatch `switch` that calls `renderShiftOverride(payload)` and routes via the existing `managers` outlet-scoped path (it already requires `outletId` for outlet-scoped roles — `shift_override` is a `managers` send, so it inherits `OUTLET_REQUIRED_FOR_ROLE`).

- [ ] **Step 5: Run tests + typecheck — verify PASS** — `npx vitest run convex/lib convex/telegram && npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/telegramHtml.ts convex/telegram/send.ts convex/lib/__tests__/telegramHtml.test.ts
git commit -m "feat(telegram): shift_override approval card template"
```

---

### Task 4: `requestShiftOverride` action (session-less)

**Files:**
- Modify: `convex/approvals/actions.ts` (add export)
- Test: `convex/approvals/__tests__/shiftOverride.test.ts`

**Interfaces:**
- Produces: `approvals.requestShiftOverride({ deviceId, idempotencyKey })` → `{ requestId } | { noHold: true }`.
- Consumes: `_getDeviceOutletId_internal`, `_getActiveShift_internal`, `_buildSignoffSummary_internal`, `_listStaffNames_internal` (for stranded staff name), `_listPendingByKind_internal`, `_createRequest_internal`, `sendTemplate`, `_markNotified_internal`.

- [ ] **Step 1: Write the failing test**

```ts
// convex/approvals/__tests__/shiftOverride.test.ts
import { convexTest } from "convex-test";
import { describe, it, expect, vi } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedOutletAndOpenShift } from "../../shifts/__tests__/_helpers";

describe("requestShiftOverride", () => {
  it("creates a pending shift_override and dedups on repeat", async () => {
    const t = convexTest(schema);
    const { outletId, deviceId } = await seedOutletAndOpenShift(t);
    // stub Telegram send (env-less): the action calls api.telegram.send.sendTemplate
    const r1 = await t.action(api.approvals.requestShiftOverride, { deviceId, idempotencyKey: "r1" });
    const r2 = await t.action(api.approvals.requestShiftOverride, { deviceId, idempotencyKey: "r2" });
    expect(r1.requestId).toBeDefined();
    expect(r2.requestId).toBe(r1.requestId); // dedup: same pending request
  });
  it("no-ops with noHold when the booth has no active hold", async () => {
    const t = convexTest(schema);
    const { deviceId } = await seedOutletClosedNoShift(t); // helper variant
    const r = await t.action(api.approvals.requestShiftOverride, { deviceId, idempotencyKey: "r3" });
    expect(r).toMatchObject({ noHold: true });
  });
});
```
> Telegram: set `POS_BASE_URL` in the test env (vitest.setup) and let `sendTemplate` no-op/throw-catch in the convex-test harness exactly as the existing `requestManualPaymentApproval` tests do; copy their Telegram-stub approach.

- [ ] **Step 2: Run — verify FAIL** — `npx vitest run convex/approvals/__tests__/shiftOverride.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement `requestShiftOverride`** in `convex/approvals/actions.ts`

Model on `requestManualPaymentApproval` but **session-less**:
```ts
export const requestShiftOverride = action({
  args: { deviceId: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args): Promise<{ requestId: Id<"pos_approval_requests"> } | { noHold: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, { key: args.idempotencyKey });
    if (cached) return JSON.parse(cached);

    const outletId = await ctx.runQuery(internal.auth.internal._getDeviceOutletId_internal, { deviceId: args.deviceId });
    const hold = await ctx.runQuery(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
    if (!hold) {
      const out = { noHold: true as const };
      await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
        key: args.idempotencyKey, mutationName: "approvals.requestShiftOverride", response: JSON.stringify(out) });
      return out;
    }

    // dedup: one pending override per shift
    const existing = await ctx.runQuery(internal.approvals.internal._listPendingByKind_internal, {
      kind: "shift_override", entityId: hold._id as unknown as string, outletId });
    if (existing.length > 0) {
      const out = { requestId: existing[0]._id };
      await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
        key: args.idempotencyKey, mutationName: "approvals.requestShiftOverride", response: JSON.stringify(out) });
      return out;
    }

    const now = Date.now();
    const summary = await ctx.runQuery(internal.shifts.internal._buildSignoffSummary_internal, {
      shiftStartMs: hold.started_at, endMs: now, outletId });
    const staffNames = await ctx.runQuery(internal.auth.internal._listStaffNames_internal, {});
    const strandedName = staffNames.find((s: { _id: string }) => s._id === hold.staff_id)?.name ?? "Staff";
    const outlet = await ctx.runQuery(internal.outlets.internal._getOutletById_internal, { outletId }); // see note
    const outletLabel = outlet?.name ?? "Booth";

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);

    const { requestId } = await ctx.runMutation(internal.approvals.internal._createRequest_internal, {
      kind: "shift_override",
      entity_type: "pos_shifts",
      entity_id: hold._id as unknown as string,
      context: {
        shift_id: hold._id as unknown as string, device_id: args.deviceId, outlet_label: outletLabel,
        stranded_staff_name: strandedName, shift_started_at: hold.started_at,
        sales_so_far_idr: summary.totalSalesIdr, txn_count: summary.txnCount,
      },
      triggered_by_event: "shift_override_request",
      triggered_at: now, token_hash: tokenHash, token_expires_at: now + TOKEN_TTL_MS, outletId,
    });

    try {
      await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "managers", kind: "shift_override",
        payload: { outlet_label: outletLabel, stranded_staff_name: strandedName,
          shift_started_at: hold.started_at, sales_so_far_idr: summary.totalSalesIdr,
          txn_count: summary.txnCount, approve_url: `${baseUrl}/approve/${rawToken}` },
        idempotencyKey: `${args.idempotencyKey}:send`, outletId,
      });
    } catch (err) {
      await ctx.runMutation(internal.approvals.internal._deleteRequest_internal, { requestId });
      throw err;
    }
    await ctx.runMutation(internal.approvals.internal._markNotified_internal, { requestId });

    const out = { requestId };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey, mutationName: "approvals.requestShiftOverride", response: JSON.stringify(out) });
    return out;
  },
});
```
> **Verify-first:** `_listStaffNames_internal`'s return shape (it may return `{name, code}` keyed differently — confirm against `convex/auth/internal.ts`; if it doesn't expose `_id`, use `_getStaffNameCode_internal({ staffId: hold.staff_id })` instead, which is the per-staff lookup `requestManualPaymentApproval` uses). **`_getOutletById_internal`:** confirm an internal outlet-by-id reader exists in `convex/outlets/internal.ts`; if not, read the label via the existing `_getDefaultOutlet_internal` shape or add a tiny `_getOutletById_internal` (one `ctx.db.get`) in this task.

- [ ] **Step 4: Run tests + typecheck — verify PASS** — `npx vitest run convex/approvals && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add convex/approvals/actions.ts convex/approvals/__tests__/shiftOverride.test.ts
git commit -m "feat(approvals): session-less requestShiftOverride action"
```

---

### Task 5: `approveShiftOverride` action

**Files:**
- Modify: `convex/approvals/actions.ts`
- Test: `convex/approvals/__tests__/shiftOverride.test.ts` (extend)

**Interfaces:**
- Produces: `approvals.approveShiftOverride({ token, managerStaffCode, managerPin, resultingState, idempotencyKey })` → `{ resolved: true }`.

- [ ] **Step 1: Write the failing test**

```ts
it("approveShiftOverride: manager code+PIN closes booth and resolves request", async () => {
  const t = convexTest(schema);
  const { outletId, deviceId, managerCode, managerPin } = await seedOutletAndOpenShift(t);
  const { rawToken } = await requestOverrideAndCaptureToken(t, deviceId); // helper inspects the pending row + re-mints? see note
  await t.action(api.approvals.approveShiftOverride, {
    token: rawToken, managerStaffCode: managerCode, managerPin, resultingState: "close", idempotencyKey: "a1" });
  const status = await t.query(internal.outlets.status._getOutletStatus_internal, { outletId });
  expect(status.is_open).toBe(false);
});
it("rejects a non-manager code with NOT_MANAGER", async () => { /* … expect rejects */ });
it("wrong PIN bumps the per-token cap, not pos_auth_attempts", async () => { /* … */ });
```
> **Token capture in tests:** the raw token is only in the URL. For the test, follow the existing `approveManualPayment` test pattern — they mint the request, then read the pending row and reconstruct the approve call by stubbing `sendTemplate` to capture the `approve_url` (or expose the rawToken via the stub). Reuse that exact helper.

- [ ] **Step 2: Run — verify FAIL** → no export.

- [ ] **Step 3: Implement `approveShiftOverride`** — **copy `approveSpoilage` verbatim** (`convex/approvals/actions.ts:983-1109`) and change only:
  - args: drop nothing; add `resultingState: v.union(v.literal("close"), v.literal("release"))`.
  - Step 3 guard: `if (req.kind !== "shift_override") throw new Error("WRONG_KIND");`
  - context narrowing: `{ shift_id?, device_id? }` — assert both present.
  - Step 8 commit: replace the `_recordSpoilage_internal` call with:
    ```ts
    await ctx.runMutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
      idempotencyKey: `${args.idempotencyKey}:commit`,
      deviceId: ctxBag.device_id,
      managerStaffId: manager._id,
      closeOutlet: args.resultingState === "close",
      source: "telegram_approval",
    });
    ```
  - return `{ resolved: true }`; Step 9 `_markResolved_internal` with the **top-level** `idempotencyKey` (the commit is no-value `{ok:true}`, so the resolve's `{resolved:true}` matches the action return — use the `approveManualPayment` single-key pattern, NOT the derived-key refund pattern). Cache write in `_markResolved_internal` (I6).
  - Keep token-auth-before-cache (Steps 1-3 of `approveSpoilage`), the `_getByCode_internal` + `argon2Verify` + `_recordFailedAttempt_internal(countTowardLockout:false)` + `_recordTokenPinFailure_internal` miss path verbatim.

- [ ] **Step 4: Run tests + typecheck — verify PASS** — `npx vitest run convex/approvals && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add convex/approvals/actions.ts convex/approvals/__tests__/shiftOverride.test.ts
git commit -m "feat(approvals): approveShiftOverride — code+PIN off-booth override"
```

---

### Task 6: `/approve` `ShiftOverride` component

**Files:**
- Modify: `src/routes/approve/index.tsx` (add `ShiftOverride` component + route the `kind` discriminator + extend the `approve.err*` map)
- Modify: `src/lib/i18n/dictionaries/en.ts`, `src/lib/i18n/dictionaries/id.ts`
- Test: `src/routes/approve/__tests__/shiftOverride.test.tsx` (create)

**Interfaces:**
- Consumes: `useAction(api.approvals.approveShiftOverride)`, `useAction(api.approvals.denyRequest)`, `useIdempotency`.

- [ ] **Step 1: Write the failing test** — render the component with a mocked `shift_override` request (context card shows stranded staff + sales), assert both outcome buttons ("Close booth" / "Release") render and that submitting with a staff code + PIN calls `approveShiftOverride` with the chosen `resultingState`. Mirror `src/routes/approve/index.test.tsx`'s existing manual-payment test setup (Convex provider mock + `t()` shim).

- [ ] **Step 2: Run — verify FAIL**.

- [ ] **Step 3: Implement** — add a `ShiftOverride` function component beside the existing per-kind components in `approve/index.tsx`. Copy the `ManualPaymentOverride` component's structure (its `staffCode`/PIN `useState`, error mapping, idempotency key, submit) and:
  - render the context card from `request.context` (outlet_label, stranded_staff_name, formatted `sales_so_far_idr` via `format.ts`, duration from `shift_started_at`);
  - add two outcome buttons that set a local `resultingState` state (default `"close"`), visually selected;
  - submit calls `approveShiftOverride({ token, managerStaffCode: staffCode.trim(), managerPin, resultingState, idempotencyKey })`;
  - wire it into the `kind` switch that picks which component to render.
  - Add i18n keys: `approve.shiftOverrideTitle`, `approve.shiftOverrideHeldBy`, `approve.shiftOverrideSalesSoFar`, `approve.outcomeClose`, `approve.outcomeRelease` (EN + ID).

- [ ] **Step 4: Run tests + typecheck — verify PASS** — `npx vitest run src/routes/approve && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/approve/index.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/id.ts src/routes/approve/__tests__/shiftOverride.test.tsx
git commit -m "feat(approve): shift_override review screen with close/release"
```

---

### Task 7: `login.tsx` two-path override

**Files:**
- Modify: `src/routes/login.tsx` (extend the existing override `PinSheet`: add Close/Release toggle + pass `resultingState` to `managerOverride`; add a "Request via Telegram" button → `requestShiftOverride`)
- Modify: `src/lib/i18n/dictionaries/en.ts`, `src/lib/i18n/dictionaries/id.ts`
- Test: `src/routes/login.test.tsx` (extend)

**Interfaces:**
- Consumes: `useAction(api.shifts.actions.managerOverride)` (now requires `resultingState`), `useAction(api.approvals.requestShiftOverride)`, `useDeviceId`, `useIdempotency`.

- [ ] **Step 1: Write the failing test** — extend `login.test.tsx`: when `boothState` is held-by-other, the override UI shows a Close/Release choice AND a "Request via Telegram" button; tapping inline override calls `managerOverride` with `resultingState`; tapping "Request via Telegram" calls `requestShiftOverride({ deviceId, idempotencyKey })`.

- [ ] **Step 2: Run — verify FAIL** (the existing `managerOverride` call lacks `resultingState`; the request button doesn't exist).

- [ ] **Step 3: Implement** in `src/routes/login.tsx`:
  - Add `const requestOverride = useAction(api.approvals.requestShiftOverride);` and a second idempotency key `shift:override:request:<device>`.
  - In the override `PinSheet` (around line 391), add a Close/Release segmented control bound to a `resultingState` state (default `"close"`); pass it into the existing `managerOverride({ … , resultingState })` call (line ~254).
  - Below the held-by-other block (line ~352), add a secondary button `t("login.requestOverrideViaTelegram")` that calls `requestOverride({ deviceId, idempotencyKey: requestKey })`, shows a "requested — waiting for a manager" inline state on success (reactive `boothState` clears it when resolved).
  - Add i18n keys `login.requestOverrideViaTelegram`, `login.overrideRequested`, `login.outcomeClose`, `login.outcomeRelease` (EN + ID).

- [ ] **Step 4: Run tests + typecheck — verify PASS** — `npx vitest run src/routes && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/login.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/id.ts src/routes/login.test.tsx
git commit -m "feat(login): two-path manager override — inline close/release + request via Telegram"
```

---

### Task 8: Docs + close-out

**Files:** `docs/SCHEMA.md`, `docs/API_REFERENCE.md`, `CLAUDE.md`, `docs/CHANGELOG.md`, `docs/ROADMAP.md`

- [ ] **Step 1:** `docs/SCHEMA.md` — add audit verbs `shift_override.requested` / `.approval_resolved` / `.denied`; note `shift.manager_override` now carries `metadata.resulting_state` + `source` of `booth_inline|telegram_approval`; note `shift_override` added to `pos_approval_requests.kind`.
- [ ] **Step 2:** `docs/API_REFERENCE.md` — add `approvals.requestShiftOverride`, `approvals.approveShiftOverride`; update `shifts.managerOverride` (now takes `resultingState`) + `_managerOverrideCommit_internal` (now takes `closeOutlet`, `source`).
- [ ] **Step 3:** `CLAUDE.md` rule #19 — add `shift_override` to the APPROVAL_KINDS list; Telegram template-kinds section — add `shift_override` (managers role, URL button).
- [ ] **Step 4:** `docs/CHANGELOG.md` — add the v1.3.1 entry (below).
- [ ] **Step 5:** `docs/ROADMAP.md` — this slice was added to the backlog; remove it once shipped (at merge time).
- [ ] **Step 6: Commit** — `git commit -m "docs: off-booth manager override (v1.3.1)"`.

**CHANGELOG draft:**
~~~markdown
## 2026-06-DD — v1.3.1: off-booth manager override (shift_override)
- New `shift_override` approval kind: a blocked booth can request a manager override via Telegram;
  the manager approves remotely with their staff code + PIN and chooses to **close** the booth or
  **release** it open. Booth-inline override retained (now also offers close/release).
- Session-less `requestShiftOverride({deviceId})` (the blocked staffer has no session) → per-outlet
  `managers` card → `/approve` → `approveShiftOverride` (argon2 code+PIN, token-before-cache, SEC-07
  lockout isolation). Shared commit `_managerOverrideCommit_internal` gains `closeOutlet` + `source`.
- Audit verbs `shift_override.requested|approval_resolved|denied`; `shift.manager_override` now
  records `resulting_state` + real `source`.
~~~

---

## Testing Summary

- **Backend (convex-test + vitest):** kind validation (T1); commit close/release branches + no-hold close (T2); session-less request + dedup + no-hold (T4); approve happy path + NOT_MANAGER + wrong-PIN cap isolation + token reuse (T5); telegram render (T3).
- **Frontend (vitest + RTL):** `/approve` ShiftOverride renders context + both outcomes + submits chosen state (T6); login two-path inline + request button (T7).
- **Full gate before merge:** `npm run typecheck` + `npx vitest run` (all green) + `npm run lint`.
- **Headless-impossible → persona-UAT (flag `pending` if no live env):** real Telegram card delivery + `/approve/:token` round-trip; booth login override journey end-to-end.

## Success Criteria

- Typecheck + full vitest + lint green.
- A blocked booth (open + held) can be released remotely: request from login → managers Telegram card → manager approves with code+PIN → choosing "Close" sets `is_open=false` + ends the hold; "Release" ends the hold only. Verified by T2/T4/T5 tests; live path is persona-UAT.
- Booth-inline override still works and now offers close/release.

## Rollback / Deployment

- Backend + frontend ship atomically via the single Vercel production build (CLAUDE.md "Convex deployment"). The `managerOverride` arg change (`resultingState` now required) is a **mutation-arg** change, not a function-type change — but FE (T7) and BE (T2) must ship together so an old FE never calls the new required arg; the single build guarantees this.
- Adding `shift_override` to the kind unions is additive (no prod schema block; no migration). Revert = revert the squash commit; no data migration to undo (pending `shift_override` rows, if any, simply stop being created; existing ones are inert `pending` and expire by TTL).
