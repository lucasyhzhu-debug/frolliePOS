# Dev Device Pre-registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After one `npx convex run seed:reset`, every dev / Chrome-MCP page load lands directly on `/login` — no activate-device gate — with production behavior completely unchanged.

**Architecture:** Two coordinated edits + docs. (1) Under the Vite **dev server only**, `useDeviceId` returns a fixed device id `"dev-booth-device"` instead of a random per-install UUID. (2) `seed:reset` pre-registers that exact id as an active `registered_devices` row. The frontend-only `RootLayout` gate then passes deterministically. The whole production code path (UUID generation, `/activate`, `pending_device_setups`) is untouched.

**Tech Stack:** React 19 + Vite (`import.meta.env.MODE`), Convex (`internalMutation`, convex-test), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-dev-device-seed-design.md`
**Staffreview:** `docs/reviews/staffreview-dev-device-seed-2026-06-02.md`

---

## Key facts grounded in the codebase

- The device gate is **frontend-only**: `RootLayout.tsx:43` redirects to `/activate` when `isDeviceRegistered(deviceId)` is false. `loginWithPin` (`convex/auth/actions.ts`) never checks device registration.
- `import.meta.env.DEV` is `true` under vitest (probed: `{"DEV":true,"PROD":false,"MODE":"test"}`). The gate MUST use `import.meta.env.MODE === "development"` so it fires only under `vite dev` (`"development"`), not vitest (`"test"`) or prod build (`"production"`).
- `registered_devices` schema (`convex/auth/schema.ts:43`): `{ device_id: string, label: string, activated_by: v.id("staff"), activated_at: number, last_seen_at?: number, active: boolean }`, indexes `by_device_id`, `by_active`. `activated_by` is **required**.
- `registered_devices` is already in the `_reset_internal` wipe list (`convex/seed/internal.ts:28`), so re-running reset replaces the row cleanly.
- `_reset_internal` currently **discards** the manager insert's return id (`convex/seed/internal.ts:55`). We must capture it for `activated_by`.
- Only `bootstrap.test.ts` exists in `convex/seed/__tests__/`; there is **no** reset test and **no** `inserted`-count assertion to update.

## File Structure

- **Modify** `src/lib/storage-keys.ts` — add the `DEV_DEVICE_ID` constant (single source of truth for the frontend literal).
- **Modify** `src/hooks/useDeviceId.ts` — dev-server short-circuit.
- **Modify** `src/hooks/useDeviceId.test.ts` — pin the literal (cross-check that the frontend constant matches the value the seed registers).
- **Create** `convex/seed/__tests__/reset.test.ts` — assert `_reset_internal` seeds the dev device row.
- **Modify** `convex/seed/internal.ts` — capture `lucasId`; insert the `registered_devices` row.
- **Modify** `docs/CHANGELOG.md` — dev-tooling entry.
- **Modify** `CLAUDE.md` — one line in the Auth section.

---

## Task 1: Dev-server short-circuit in `useDeviceId`

**Files:**
- Modify: `src/lib/storage-keys.ts`
- Modify: `src/hooks/useDeviceId.ts`
- Modify: `src/hooks/useDeviceId.test.ts`

- [ ] **Step 1: Write the failing test (pin the shared literal)**

Add this block to the end of `src/hooks/useDeviceId.test.ts` (inside the top-level `describe("useDeviceId", ...)` or as a sibling — place it as a sibling `it` inside the existing `describe`). Also add the import at the top of the file next to the existing `DEVICE_ID_KEY` import:

```ts
// at top, extend the existing storage-keys import:
import { DEVICE_ID_KEY, DEV_DEVICE_ID } from "@/lib/storage-keys";
```

```ts
  // The seed (convex/seed/internal.ts) registers this exact literal as the dev
  // device. If the two ever diverge, the dev RootLayout gate would bounce to
  // /activate. Pin it here so a frontend-side typo fails the suite.
  it("exposes the fixed dev device id literal", () => {
    expect(DEV_DEVICE_ID).toBe("dev-booth-device");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useDeviceId.test.ts`
Expected: FAIL — `DEV_DEVICE_ID` is not exported from `@/lib/storage-keys` (TS/transform error or `undefined`).

- [ ] **Step 3: Add the constant to `src/lib/storage-keys.ts`**

Append to `src/lib/storage-keys.ts`:

```ts
/**
 * Dev-only fixed device-id VALUE (not a localStorage key). Under the Vite dev
 * server, `useDeviceId` returns this instead of a random per-install UUID so the
 * id matches the `registered_devices` row pre-seeded by `seed:reset`, letting
 * dev / Chrome-MCP loads skip the /activate gate. Keep in sync with the literal
 * in convex/seed/internal.ts (the two runtimes cannot share a module).
 */
export const DEV_DEVICE_ID = "dev-booth-device";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useDeviceId.test.ts`
Expected: PASS — all existing tests plus the new literal-pin test pass.

- [ ] **Step 5: Implement the dev-server short-circuit in `useDeviceId.ts`**

Edit `src/hooks/useDeviceId.ts`. Extend the storage-keys import and add a module-level constant near the other module constants (after the `IDB_KEY` line):

```ts
import { DEVICE_ID_KEY, DEV_DEVICE_ID } from "@/lib/storage-keys";
```

```ts
// True only under `vite dev` (MODE==="development"). Vitest is "test" and the
// prod build is "production", so this is false in both — the existing UUID
// reconcile (and its test suite) is untouched. Captured at module load: a fixed
// dev device id lets seed:reset pre-register the device and skip /activate.
const DEV_SERVER = import.meta.env.MODE === "development";
```

Change the state initializer so the dev server starts with the constant, and guard the effect so it does no IDB/localStorage work in dev:

```ts
export function useDeviceId(): string | null {
  // Start null in prod/test — no synchronous UUID generation. Under the dev
  // server, start with the fixed id so the very first render already presents it.
  const [id, setId] = useState<string | null>(DEV_SERVER ? DEV_DEVICE_ID : null);

  useEffect(() => {
    if (DEV_SERVER) return; // dev uses the pre-seeded fixed device id; skip IDB
    let cancelled = false;
    (async () => {
      // ... existing effect body unchanged ...
    })();
    return () => { cancelled = true; };
  }, []);

  return id;
}
```

Leave the entire existing effect body (the `try { ... } catch { ... }` IDB/localStorage reconcile) exactly as-is — only add the `if (DEV_SERVER) return;` as the first line inside the effect and change the `useState` initializer. The `[]` dep array stays (`DEV_SERVER` is a module constant, not a render value).

- [ ] **Step 6: Run the full hook suite to verify nothing regressed**

Run: `npx vitest run src/hooks/useDeviceId.test.ts`
Expected: PASS — under vitest `MODE==="test"`, so `DEV_SERVER` is false; the UUID/null-first/IDB-recovery tests behave exactly as before, plus the literal-pin test passes.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/storage-keys.ts src/hooks/useDeviceId.ts src/hooks/useDeviceId.test.ts
git commit -m "feat(dev): fixed device id under vite dev server

useDeviceId returns DEV_DEVICE_ID when MODE===development so the id
matches the seeded registered_devices row. Gated on MODE (not DEV,
which is true under vitest); prod/test UUID path untouched."
```

---

## Task 2: Pre-register the dev device in `seed:reset`

**Files:**
- Create: `convex/seed/__tests__/reset.test.ts`
- Modify: `convex/seed/internal.ts`

- [ ] **Step 1: Write the failing test**

Create `convex/seed/__tests__/reset.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("seed/_reset_internal — dev device pre-registration", () => {
  it("seeds exactly one active registered_devices row for dev-booth-device", async () => {
    const t = convexTest(schema);

    // Drive the V8 mutation directly with dummy hashes (no argon2 action needed).
    await t.mutation(internal.seed.internal._reset_internal, {
      staffPinHash: "dummy-staff-hash",
      mgrPinHash: "dummy-mgr-hash",
      staffNames: ["Bayu", "Citra", "Dewi", "Eka"],
    });

    const devices = await t.run((ctx) =>
      ctx.db
        .query("registered_devices")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect(),
    );

    expect(devices.length).toBe(1);
    expect(devices[0].device_id).toBe("dev-booth-device");
    expect(devices[0].label).toBe("Dev Booth Device");

    // activated_by must reference the seeded manager (Lucas).
    const manager = await t.run((ctx) => ctx.db.get(devices[0].activated_by));
    expect(manager?.role).toBe("manager");
    expect(manager?.name).toBe("Lucas");
  });

  it("re-running reset leaves exactly one device row (no duplicates)", async () => {
    const t = convexTest(schema);
    const args = {
      staffPinHash: "h1",
      mgrPinHash: "h2",
      staffNames: ["Bayu", "Citra", "Dewi", "Eka"],
    };
    await t.mutation(internal.seed.internal._reset_internal, args);
    await t.mutation(internal.seed.internal._reset_internal, args);

    const devices = await t.run((ctx) =>
      ctx.db.query("registered_devices").collect(),
    );
    expect(devices.length).toBe(1);
    expect(devices[0].device_id).toBe("dev-booth-device");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/seed/__tests__/reset.test.ts`
Expected: FAIL — `devices.length` is `0` (no `registered_devices` row is seeded yet).

- [ ] **Step 3: Capture the manager id + insert the device row in `convex/seed/internal.ts`**

In `_reset_internal`, change the manager insert (currently `convex/seed/internal.ts:54-59`) from:

```ts
    const mgrCode = `S-${String(staffCounter).padStart(4, "0")}`;
    await ctx.db.insert("staff", {
      name: "Lucas", code: mgrCode, pin_hash: args.mgrPinHash, role: "manager",
      active: true, created_at: now,
    });
    inserted++;
```

to capture the id and immediately register the dev device:

```ts
    const mgrCode = `S-${String(staffCounter).padStart(4, "0")}`;
    const lucasId = await ctx.db.insert("staff", {
      name: "Lucas", code: mgrCode, pin_hash: args.mgrPinHash, role: "manager",
      active: true, created_at: now,
    });
    inserted++;

    // DEV-ONLY: pre-register a fixed device so dev / Chrome-MCP loads skip the
    // /activate gate. The id matches DEV_DEVICE_ID in src/lib/storage-keys.ts
    // (the two runtimes cannot share a module — keep them in sync). registered_devices
    // is wiped above, so re-running reset replaces this row. Never seeded by
    // `bootstrap` (the prod path), and `reset` is prod-guarded by deployment slug.
    await ctx.db.insert("registered_devices", {
      device_id: "dev-booth-device",
      label: "Dev Booth Device",
      activated_by: lucasId,
      activated_at: now,
      last_seen_at: now,
      active: true,
    });
    inserted++;
```

(`now` is defined at the top of the handler; `lucasId` is now in scope for the insert.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/seed/__tests__/reset.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the whole seed suite (no regression in bootstrap)**

Run: `npx vitest run convex/seed`
Expected: PASS — `bootstrap.test.ts` (3 tests) + `reset.test.ts` (2 tests) all pass.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/seed/internal.ts convex/seed/__tests__/reset.test.ts
git commit -m "feat(dev): seed:reset pre-registers dev-booth-device

_reset_internal captures the manager id and inserts an active
registered_devices row for the fixed dev device id, so dev skips
/activate. registered_devices already in the wipe list -> no dupes.
bootstrap/prod paths untouched."
```

---

## Task 3: Documentation

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`, insert this new section directly **after** the title block (after line 3, `All notable changes...`, and before the `## v0.5.3b` heading):

```markdown
## Dev tooling (unreleased)

- `seed:reset` now pre-registers a fixed dev device (`dev-booth-device`), and `useDeviceId` returns that id under the Vite dev server, so local / Chrome-MCP loads skip the `/activate` device-registration gate. No production impact — gated on `import.meta.env.MODE === "development"`, so the prod build and the test runner keep the random per-install UUID path. Dev credentials after seed: Lucas (manager, PIN 9999), Bayu/Citra/Dewi/Eka (staff, PIN 0000).
```

- [ ] **Step 2: Add the CLAUDE.md note**

In `CLAUDE.md`, append one sentence to the end of the Auth-section paragraph at line 150 (right after "...one-time 6-digit setup code ([foundations §6](...))."):

```markdown
 In dev, `seed:reset` pre-registers a fixed device (`dev-booth-device`) and `useDeviceId` returns it under `vite dev` (`MODE==="development"`), so local / Chrome-MCP loads skip `/activate` (prod/test keep the random UUID path).
```

- [ ] **Step 3: Verify docs render (no broken markdown)**

Run: `git diff docs/CHANGELOG.md CLAUDE.md`
Expected: clean additions, no stray characters; the CHANGELOG section sits above `## v0.5.3b`.

- [ ] **Step 4: Commit**

```bash
git add docs/CHANGELOG.md CLAUDE.md
git commit -m "docs: note dev device pre-registration (seed:reset + useDeviceId)"
```

---

## Success Criteria

- [ ] `npm run typecheck` passes.
- [ ] `npx vitest run convex/seed src/hooks/useDeviceId.test.ts` passes (bootstrap 3, reset 2, useDeviceId existing + literal-pin).
- [ ] Behavioral (manual, post-merge in a dev session): with `npx convex dev` + `npm run dev` running, `npx convex run seed:reset`, then load the app in a fresh browser profile → lands on `/login` (no `/activate`); pick Lucas → PIN `9999` → home.
- [ ] Production untouched: `useDeviceId` UUID path unchanged for prod build (`MODE==="production"`); `bootstrap`, `activateDevice`, `isDeviceRegistered`, `RootLayout` gate, `pending_device_setups` all unmodified.

## Rollback / Deployment

- **Frontend:** dev-only behavior gated on `MODE==="development"`; the Vercel prod build (`vite build`, `MODE==="production"`) is unaffected. No deploy ordering concern.
- **Backend:** `seed:reset` is `internalAction`, prod-guarded by the `savory-zebra-800` slug check in `convex/seed/actions.ts` and never invoked in prod. The new insert only ever runs on dev deployments.
- **Revert:** all three commits are independent and docs/dev-only; `git revert` any or all with no data-migration concern. No schema change (reuses `registered_devices`).

## Notes on a deliberately untested branch

The `DEV_SERVER` branch of `useDeviceId` (the dev-server return of the constant) is **not** unit-tested directly: `DEV_SERVER` is captured at module load, so `vi.stubEnv("MODE", ...)` after import cannot flip it, and adding per-render env reads to production code for a dev-only branch is not worth the complexity. The regression guard is twofold: (1) the existing `useDeviceId` suite proves the prod/test path is unchanged (it runs with `MODE==="test"`), and (2) the literal-pin test + `reset.test.ts` together pin both sides of the `"dev-booth-device"` contract.
