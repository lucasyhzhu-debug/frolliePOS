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
  `src/lib/storage-keys.ts` (existing home for device/storage keys).
- **Backend:** redeclare the same literal in `convex/seed/internal.ts` with a
  comment cross-referencing `src/lib/storage-keys.ts`. The frontend (`src/`) and
  Convex (`convex/`) cannot share a module, so the literal is duplicated by
  necessity. A divergence simply re-triggers the activate gate — loud and obvious,
  not silent.

### 2. `useDeviceId` — DEV short-circuit

When `import.meta.env.DEV` is `true`, return `DEV_DEVICE_ID` immediately and skip
the IDB/localStorage reconcile entirely. This guarantees the dev client always
presents the same id the seed registered — even in a fresh incognito/MCP profile
with empty IndexedDB.

When `import.meta.env.DEV` is `false` (prod build), the existing UUID
reconcile logic is **untouched**.

Implementation note: the hook still returns `string | null`. In DEV it can return
the constant synchronously on first render (no async resolve needed), but to keep
the return contract and avoid a same-render state churn, set it via the existing
state path. Either is acceptable as long as DEV never falls through to UUID
generation.

### 3. `seed:reset` — insert an active `registered_devices` row

In `_reset_internal` (`convex/seed/internal.ts`), after seeding staff, insert one
row:

```ts
await ctx.db.insert("registered_devices", {
  device_id: DEV_DEVICE_ID,           // "dev-booth-device"
  label: "Dev Booth Device",
  activated_by: lucasId,              // the manager id created just above
  activated_at: now,
  last_seen_at: now,
  active: true,
});
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

Dev-only tooling — no tests strictly required. But the seed change touches a tested
module (`convex/seed/__tests__/`):

- Keep the existing seed suite green (the `inserted` count assertion, if any, must
  account for the new row).
- Add a one-line assertion that `_reset_internal` creates an active
  `registered_devices` row with `device_id === "dev-booth-device"`.

## Out of scope

- No change to `bootstrap` or any prod path.
- No env-var configurability (the hardcoded DEV constant is intentionally
  zero-config for single-dev local work).
- No change to the `/activate` UI or backend activation logic.
