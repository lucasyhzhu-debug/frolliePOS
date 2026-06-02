# Dev device pre-registration — design

**Date:** 2026-06-02
**Status:** Approved, ready for planning
**Scope:** Dev-only tooling. No production behavior change.

## Problem

Every fresh dev / Chrome-MCP page load lands on the `/activate` device-registration
screen, blocking automated UI runs. The screen demands a 6-digit setup code that
must exist as a live `pending_device_setups` row — and minting one normally needs
a manager session, which itself needs a registered device (chicken-and-egg).

### Root cause

- **The device gate is frontend-only.** `loginWithPin` (`convex/auth/actions.ts`)
  never checks device registration — it binds the session to whatever `deviceId`
  string it receives. The *only* thing forcing `/activate` is `RootLayout.tsx:43`
  redirecting when `isDeviceRegistered(deviceId)` returns `false`.
- **The device id is unstable.** `useDeviceId` (`src/hooks/useDeviceId.ts`)
  generates a random `crypto.randomUUID()` per browser installation and persists
  it in IndexedDB + localStorage. A fresh MCP profile (or incognito) gets a brand-new
  UUID → no matching `registered_devices` row → bounced to `/activate` every time.
- **The seed half-solves it.** `seed:reset` (`convex/seed/`) creates Lucas
  (manager, PIN `9999`) + Bayu/Citra/Dewi/Eka (staff, PIN `0000`), but seeds **no**
  `registered_devices` row — and even if it did, it could not match the client's
  random UUID.

## Goal

After one `npx convex run seed:reset`, every dev / Chrome-MCP load lands directly
on `/login` (pick staff → enter PIN). Production behavior is completely unchanged
and the production gate logic stays exercised in dev.

## Approach

**Stable dev device id + seed a matching registered device.** In DEV mode the
client deterministically presents a fixed device id; `seed:reset` pre-registers
that exact id. The production gate is untouched — dev just deterministically
passes it.

Rejected alternative (**B: bypass the gate in DEV**): `RootLayout` skips the
device check when `import.meta.env.DEV`. Simpler, but the gate logic would diverge
dev↔prod and the activate flow would never be exercised in dev. Rejected in favor
of a faithful, deterministic path.

## Changes

Three small, isolated changes.

### 1. Shared dev device-id constant

A single literal `"dev-booth-device"` referenced by both runtimes:

- **Frontend:** export `DEV_DEVICE_ID = "dev-booth-device"` from
  `src/lib/storage-keys.ts` (the hook already imports `DEVICE_ID_KEY` from there).
  Add a one-line comment marking it as a *dev-only fixed device-id value* — that
  file otherwise holds localStorage *key* names, and this is a value.
- **Backend:** redeclare the same literal in `convex/seed/internal.ts` with a
  comment cross-referencing `src/lib/storage-keys.ts`. The frontend (`src/`) and
  Convex (`convex/`) cannot share a module, so the literal is duplicated by
  necessity. A divergence simply re-triggers the activate gate — loud and obvious,
  not silent.

### 2. `useDeviceId` — dev-server short-circuit

When `import.meta.env.MODE === "development"`, return `DEV_DEVICE_ID` immediately and
skip the IDB/localStorage reconcile entirely. This guarantees the dev client always
presents the same id the seed registered — even in a fresh incognito/MCP profile
with empty IndexedDB.

**Gate on `MODE === "development"`, NOT `import.meta.env.DEV`.** `DEV` is `true` under
vitest (empirically probed: `{"DEV":true,"PROD":false,"MODE":"test"}`), so a `DEV`
gate would fire *inside the test runner* and break the existing `useDeviceId.test.ts`
suite (which asserts UUID / null-first / IDB persistence). `MODE` cleanly separates the
three contexts:

| Context | `MODE` | Short-circuit |
|---|---|---|
| `npm run dev` (vite) | `"development"` | **ON** (intended) |
| `vitest` | `"test"` | off — existing tests stay green |
| `vite build` (prod) | `"production"` | off — prod UUID logic untouched |

(Verify during implementation that `package.json`'s `dev` script has no `--mode`
override; the Vite default for `vite dev` is `"development"`.)

Implementation note: the hook still returns `string | null`. In the dev-server branch
it can return the constant synchronously on first render (no async resolve needed), but
to keep the return contract and avoid a same-render state churn, set it via the existing
state path. Either is acceptable as long as the dev-server branch never falls through to
UUID generation.

### 3. `seed:reset` — insert an active `registered_devices` row

In `_reset_internal` (`convex/seed/internal.ts`), after seeding staff, insert one
row. **First capture the manager's id** — the existing manager insert at
`internal.ts:55` discards its return value, but `registered_devices.activated_by`
is a required `v.id("staff")`:

```ts
// change the existing manager insert to capture its id:
const lucasId = await ctx.db.insert("staff", { name: "Lucas", code: mgrCode, /* ... */ });
inserted++;

// ...then, after the manager insert, register the dev device:
await ctx.db.insert("registered_devices", {
  device_id: DEV_DEVICE_ID,           // "dev-booth-device"
  label: "Dev Booth Device",
  activated_by: lucasId,
  activated_at: now,
  last_seen_at: now,
  active: true,
});
inserted++;
```

- `registered_devices` is **already** in the wipe list (`internal.ts:28`), so
  re-running `reset` replaces the row cleanly.
- Only `reset` gets this. `bootstrap` (the prod-safe path that creates only Lucas)
  does **not** — production is never seeded a fake device.
- `reset` is already prod-guarded in `convex/seed/actions.ts` by the
  `savory-zebra-800` slug check, so this row can never be written to prod.
- Count the new insert in the `inserted` tally returned by `_reset_internal`.

## What stays the same

- `loginWithPin`, `activateDevice`, `isDeviceRegistered`, the `RootLayout` gate,
  and the entire `pending_device_setups` flow — all untouched.
- `_devMintSetupCode_internal` remains the escape hatch for exercising the *real*
  activation flow or registering a second device.

## Testing the real activate flow again (if ever needed)

Delete the seeded `registered_devices` row (or run `reset`, then delete it) → the
gate returns. Mint a code via `npx convex run seed/internal:_devMintSetupCode_internal`
and proceed through `/activate` normally.

## Dev credentials (post-seed)

| Account | Role | PIN |
|---|---|---|
| Lucas | manager | `9999` |
| Bayu / Citra / Dewi / Eka | staff | `0000` |

Device: `dev-booth-device` (pre-registered, label "Dev Booth Device").

## Tests

- **Create `convex/seed/__tests__/reset.test.ts`** (no reset test exists today — the
  only seed test is `bootstrap.test.ts`, so this is a new file, not an extension).
  Drive `_reset_internal` directly with dummy hashes (lighter than the `reset` action,
  which would run two real argon2 hashes) and assert exactly one **active**
  `registered_devices` row exists with `device_id === "dev-booth-device"` and a valid
  `activated_by`. There is no existing `inserted`-count assertion to update.
- **`useDeviceId.test.ts` must stay green** — the `MODE === "development"` gate (not
  `DEV`) ensures the short-circuit does not fire under vitest (`MODE === "test"`). This
  is the live regression guarded by Change #2.
- *Optional:* add a `useDeviceId` test for the dev-server branch using
  `vi.stubEnv("MODE", "development")` before `renderHook`, asserting the hook returns
  `"dev-booth-device"`. Restore with `vi.unstubAllEnvs()` in `afterEach`. Dev-only
  branch, so optional.

### Pre-merge verification

- `npm run typecheck`
- `npx vitest run convex/seed src/hooks/useDeviceId.test.ts`

## Documentation

- `docs/CHANGELOG.md` — add a dev-tooling entry (per CLAUDE.md "How to add a feature" #9).
- CLAUDE.md (Auth / seed notes) — one line that `seed:reset` now pre-registers
  `dev-booth-device`, so dev skips the `/activate` gate. Helps the next agent.
- No `docs/SCHEMA.md` change — reuses the existing `registered_devices` table.

## Out of scope

- No change to `bootstrap` or any prod path.
- No env-var configurability (the hardcoded DEV constant is intentionally
  zero-config for single-dev local work).
- No change to the `/activate` UI or backend activation logic.
