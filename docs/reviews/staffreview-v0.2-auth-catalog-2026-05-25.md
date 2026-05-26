# Staff Review: v0.2 Auth + Catalog

**Date:** 2026-05-25
**Plan:** `docs/superpowers/plans/2026-05-25-v0.2-auth-catalog.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Sections added — see §0

---

## 0. Plan Structure Additions

The plan covers Scope, File Changes, Tasks, and a Self-Review section with very rigorous TDD discipline (every task: failing test → impl → passing test → commit). The following sections were missing and have been silently added to this review for completeness:

| Added Section | Why it was added | What's recommended |
|---|---|---|
| **Implementation Phases — PARALLEL/SEQUENTIAL marks** | Tasks 0–16 are all listed linearly. Some are independent and could parallelize (Tasks 10/11/12 — three hooks; Task 8 catalog query is independent of all auth tasks). | Mark Task 0 → Tasks 1–9 (sequential backend) → Tasks 10/11/12 (parallel hooks) → Tasks 13/14/15 (sequential UI, depends on hooks) → Task 16 (changelog). |
| **Plan-level Success Criteria** | Each task has a "verify it passes" step; no overall acceptance gate. | "All 18 (smoke + 17 task tests) pass; `npm run typecheck` clean; `npm run build` clean; manual smoke (Task 15 step 3) passes; `convex/schema.ts` deploys without validation errors against the personal dev deployment." |
| **Rollback / Deployment notes** | No mention of how to undo a task that fails mid-plan, or which deployment target gets the changes. | (a) Each task is one commit; revert via `git revert <hash>`. (b) v0.2 deploys to a personal Convex dev deployment ONLY, per Task 2 step 2 — explicitly call out that v0.2 does NOT touch the shared `product_master` prod deployment (this is consistent with WORKFLOW.md "Convex production deploys"). (c) Schema changes that reach prod must wait for v1.0 coordination with Frollie Pro maintainer. |

---

## 1. Summary

**Overall Assessment:** **REVISE**

The plan demonstrates exceptional TDD discipline (every task: red → green → commit), thorough ADR coverage, and a clean MVP slice. The Self-Review at the bottom is genuinely useful. **However, the plan ships 6 architectural defects that will fail at deploy or silently violate accepted ADRs.** None of them require redesigning the slice — all are surgical fixes that should land before any code is written. The biggest issues are: (a) PIN verify in a mutation instead of an action, in direct violation of ADR-004; (b) a `"use node"` directive that's incompatible with the file's query/mutation exports; (c) the device-registration gate being silently bypassed because `getActiveStaff` ignores its `deviceId` arg.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|---|---|---|
| C1 | PIN verify runs in a mutation, not an action (ADR-004 violation) | Architecture / Auth | Task 6 step 3 |
| C2 | `"use node"` directive mixes with query/mutation exports in same file (deploy failure) | Convex runtime | Task 5 step 3 |
| C3 | Device registration gate is silently bypassed | Security / Strategic §6 | Task 13 step 5, Task 5 step 3 |
| C4 | `seed.reset` is an open public mutation with no prod guard | Security / Data loss | Task 9 step 1 |
| C5 | PWA service worker is claimed in scope but no task installs/configures it | Scope gap | Plan header §"ADR coverage" |
| C6 | `staff.ts` imports `hashPin` across a Node↔V8 runtime boundary | Convex runtime | Task 7 step 3 |

### C1. PIN verify in a mutation, not an action

**Location:** Task 6 step 3, the `loginWithPin` mutation body — specifically:
```ts
const { argon2Verify } = await import("hash-wasm");
const ok = await argon2Verify({ password: args.pin, hash: staff.pin_hash });
```

**Problem:** ADR-004 is explicit:
> "argon2id verify is ~200ms — runs in a **Convex action, not a mutation**, so it doesn't block the event loop. Login flow: client calls `auth.verifyPinAction` (action) → on success, internal call to `auth.loginWithPin` (mutation) writes the session row."

The plan's note acknowledges the issue but punts: *"Convex mutations cannot call actions, so we inline the argon2Verify here."* That punt is the ADR violation.

A mutation that takes 200ms holding a write transaction blocks the Convex event loop for every other mutation queued behind it. The whole reason argon2id was chosen (memory-hard, slow on purpose) is to make brute-force expensive — but that cost lives in an isolated runtime so it doesn't degrade unrelated operations.

**Recommendation:**
1. Make `loginWithPin` an `action` (not a mutation). It runs argon2Verify, then calls an internal mutation `_loginCommit_internal` via `ctx.runMutation(internal.auth._loginCommit_internal, {...})` to write the session row, update `pos_auth_attempts`, and emit audit logs.
2. The internal mutation accepts the verify result as an arg — it does NOT re-verify. The verify decision happens once in the action.
3. The action accepts `idempotencyKey` and wraps `_loginCommit_internal` with the same idempotency key (the harness applies to the mutation, not the action — actions are not idempotent by design, but the inner mutation is).
4. Update tests: `t.mutation(api.auth.loginWithPin, ...)` → `t.action(api.auth.loginWithPin, ...)`.

### C2. `"use node"` + query/mutation exports = deploy failure

**Location:** Task 5 step 3, top of `convex/auth.ts`:
```ts
"use node";
import { action, query, internalAction } from "./_generated/server";
// ...
export const _getStaffPinHash_internal = query({ ... });
export const getActiveStaff = query({ ... });
// then in Task 6:
export const loginWithPin = mutation({ ... });
export const logout = mutation({ ... });
export const getSession = query({ ... });
```

**Problem:** Convex's `"use node"` directive opts the **entire file** into Node runtime. Node-runtime files can ONLY export `action` and `internalAction`. Exporting any `query` / `mutation` / `internalQuery` / `internalMutation` from a `"use node"` file fails Convex schema validation at deploy. The file as written will not deploy.

The plan's note on this ("If you see 'module not found' errors during dev, double-check this directive") suggests the author hit this and worked around it on the wrong side — the directive needs to go, not be defended.

**Recommendation:**
1. Split into two files:
   - `convex/auth.ts` — **no** `"use node"`. Exports queries (`getActiveStaff`, `getSession`), mutations (`loginWithPin` if it stays a mutation, `logout`), and the V8-side `hashPin` helper. `hash-wasm` is a WASM module and works in Convex's V8 runtime — verify by running a smoke test before committing to a split.
   - `convex/authActions.ts` — `"use node"`. Exports only the action (`loginWithPin` per fix C1, or `verifyPinAction_internal` if you keep the verify-then-commit split internal).
2. If `hash-wasm` turns out to require Node runtime (the WASM init does an async fetch + instantiation that V8's restricted runtime may reject), then ALL argon2 calls — including `hashPin` used by `createStaff` and `seed.reset` — must move to Node-runtime actions, and those callers must `ctx.runAction(...)` instead of importing `hashPin` directly. This couples to C6.

### C3. Device registration gate is silently bypassed

**Location:** Task 13 step 5 (RootLayout):
```tsx
const staffForDevice = useQuery(api.auth.getActiveStaff, { deviceId });
// ...
// "treat empty staff-for-device as 'device needs activation' only when the
// device is genuinely unregistered."
```

Combined with Task 5 step 3 (`getActiveStaff` handler):
```ts
export const getActiveStaff = query({
  args: { deviceId: v.string() },
  handler: async (ctx, _args) => {  // <-- deviceId is unused
    const rows = await ctx.db
      .query("staff")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return rows.map(...);
  },
});
```

**Problem:** `getActiveStaff` accepts `deviceId` but the handler ignores it. So `staffForDevice` returns the SAME staff list for every device, registered or not. The RootLayout gate that uses this query as a proxy for "is the device registered?" passes for any device as long as at least one active staff record exists. The seed creates 4 staff + 1 manager unconditionally — so the gate is effectively bypassed in every dev environment.

This silently breaks strategic foundations §6 ("Device registration before login"), which CLAUDE.md flags as a security control: *"Even if a PIN leaks, the attacker also needs physical access to a registered device."*

The plan's own inline comment in Task 13 admits this ("A registered device with no active staff list is a different problem... Until staff.isDeviceRegistered exists, accept any device id...") — but ships anyway.

**Recommendation:**
1. Add a dedicated `staff.isDeviceRegistered({ deviceId })` query that returns `boolean` based on a lookup in `registered_devices` by `device_id` with `active = true`. This is ~10 lines and one new task between Task 7 and Task 13.
2. RootLayout reads this query, not `getActiveStaff`. On `false`, redirect to `/activate`.
3. `getActiveStaff` either (a) drops the unused `deviceId` arg, or (b) actually filters — but the plan's design intent (per the LoginA wireframe) is to show the same staff list regardless of device, so (a) is correct.
4. Add a test in `convex/staff.test.ts`: device-with-no-row → `isDeviceRegistered` returns false; device-with-active-row → true; device-with-deactivated-row → false.

### C4. `seed.reset` is an open public mutation

**Location:** Task 9 step 1:
```ts
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    // Crude prod guard: production deployment URLs contain a long stable
    // ID; dev URLs contain "dev-".
    // Tighten when you wire CI.
    // if (!process.env.CONVEX_CLOUD_URL?.includes("dev-")) {
    //   throw new ConvexError("seed:reset is dev-only");
    // }
    // ... wipes 10 tables and reseeds
  },
});
```

**Problem:** `seed.reset` is exported as a public `mutation` callable by any client with the deployment URL. The prod guard is commented out. This is one `npx convex run seed:reset --prod` (or one curl to the right endpoint) away from wiping all data, including the shared `product_master` deployment when it reaches v1.0 prod.

**Recommendation:**
1. Make it an `internalMutation`. Invoke from CLI with `npx convex run seed:reset` (CLI bypasses public/internal distinction).
2. Add an explicit prod guard that throws unless `process.env.CONVEX_CLOUD_URL` clearly identifies a dev deployment, OR (cleaner) check that the staff table is empty before reseeding so re-seed of a prod environment is impossible.
3. Add a test that the mutation cannot be called from a non-CLI surface (or document that internalMutation already enforces this).
4. Add an `audit_log` row on reset documenting the wipe (with `actor_id: "system"`) — currently the reset leaves no trace.

### C5. PWA service worker setup is missing

**Location:** Plan header §"Architecture" — *"Catalog payload (`products` + `inventory_skus` + `components` + `stock_levels` + `vouchers`) is cached via `vite-plugin-pwa`'s service worker with `stale-while-revalidate`."* — and §"ADR coverage in this phase" lists ADR-025.

**Problem:** `vite-plugin-pwa` is already in `devDependencies` (package.json line 58), but no task in the plan:
- Configures it in `vite.config.ts`
- Adds the `public/manifest.webmanifest`
- Defines the workbox cache strategies for catalog / auth / shell (per ADR-025's table)
- Verifies the service worker registers correctly in dev/prod builds
- Tests the cache behavior

The plan's claim that ADR-025 is covered is false. The service worker is a no-op. Catalog will work online only — exactly what ADR-025 was meant to prevent.

**Recommendation:**
Two options:
1. **Drop the ADR-025 claim from the v0.2 scope.** Move PWA/SW to v0.3 (where it pairs naturally with the offline draft-queue work). Update the plan header and CHANGELOG draft.
2. **Add a Task 8.5 between Task 8 (catalog query) and Task 9 (seed):** "PWA service worker — configure vite-plugin-pwa, set cache strategies per ADR-025 table, add manifest, smoke test offline catalog load." This is ~2 hours of work but is the right place for it (Task 8 ships the catalog query; SW caches the query).

Pick one. Don't leave the claim with no implementation.

### C6. `staff.ts` imports `hashPin` across the runtime boundary

**Location:** Task 7 step 3:
```ts
// In convex/staff.ts:
import { hashPin } from "./auth";  // auth.ts has "use node" at the top
// ...
export const createStaff = mutation({ ... handler: ... await hashPin(args.pin) ... });
```

**Problem:** Convex's `"use node"` runtime is isolated. A V8-runtime file (`staff.ts`) cannot import a function from a Node-runtime file (`auth.ts`) and use it inside a mutation. Even if you split per C2, `hashPin` ends up on the V8 side (because mutations call it) but argon2 may need the Node side. The plan needs a clean architectural answer.

**Recommendation:**
1. After resolving C1 + C2: if `hash-wasm` works in V8 runtime, keep `hashPin` in `convex/auth.ts` (V8) and import freely from mutations. Verify this with a smoke test BEFORE writing any of the dependent code.
2. If `hash-wasm` does NOT work in V8 runtime: make `hashPin` an internal action in `authActions.ts`, and refactor `createStaff` + `seed.reset` to be actions that call `_createStaffCommit_internal` and `_seedCommit_internal` (internal mutations). This is the same shape as the fix for C1.
3. Either way: add a Convex runtime smoke test as Task 0.5 or expand Task 0 to include "verify hash-wasm runs in V8 runtime" before committing to a directory layout.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|---|---|---|
| I1 | `withIdempotency` doesn't cache errors — document choice, add explicit test | M | L |
| I2 | `useIdempotency` doesn't survive page reload — flag as known v0.3 work | M | L |
| I3 | `useDeviceId` localStorage-only — strategic §6 says localStorage + IndexedDB | M | M |
| I4 | `generateDeviceSetupCode` uses `Math.random()` for a security credential | M | L |
| I5 | `generateDeviceSetupCode` bloats `registered_devices` with placeholder rows | M | M |
| I6 | Tests call `api.auth.verifyPinAction_internal` — internals live under `internal.*` not `api.*` | H | L |
| I7 | `__test_echo` is a public mutation in production code | M | L |
| I8 | `activateDevice` trusts client-supplied `deviceId` | M | M |
| I9 | `device.setup_code_issued` action is logged but not in SCHEMA.md audit enum | L | L |
| I10 | `ConnDot` polls 500ms — battery cost; use Convex `onStateChange` | L | L |
| I11 | `pos_idempotency.staff_id` schema mismatch between plan + SCHEMA.md | M | L |
| I12 | No test for `getSession` query | M | L |
| I13 | No test for `withIdempotency` error path | L | L |
| I14 | No test that public routes (`/approve/*`, `/r/*`) still bypass new RootLayout gate | M | L |
| I15 | `vitest.config.ts` uses jsdom for ALL tests — Convex backend tests should run in Node | M | L |

### Improvement 1 (I1). `withIdempotency` doesn't cache errors

The harness only inserts to `pos_idempotency` AFTER `handler()` returns successfully. If the handler throws (lockout, invalid PIN, schema validation failure), no row is written — so a retry with the same key re-executes. This is defensible (you usually WANT the user to be able to retry after a failure) but it's a design choice that ADR-013 doesn't explicitly call out. For v0.2 (login + catalog) this is fine. For v0.3 (payments), a successful-but-throws-on-return scenario could double-charge.

**Recommendation:** Add a test that documents current behavior (errors NOT cached), add a one-line comment in `withIdempotency` explaining the choice, and add a `# v0.3 followup` to the plan's CHANGELOG draft noting this needs revisiting before payments.

### Improvement 2 (I2). `useIdempotency` doesn't survive page reload

`useMemo(() => `${intent}:${crypto.randomUUID()}`, [intent])` lives in React state. Page reload = new UUID = server treats next attempt as a new mutation. For v0.2 (no money flows) this is acceptable. For v0.3 it's not.

**Recommendation:** Add a `// v0.3 followup: persist keys to IDB so reload during mutation doesn't double-execute` comment, and add a `pre-v0.3` checkbox in WORKFLOW.md under "Idempotency hygiene".

### Improvement 3 (I3). `useDeviceId` localStorage-only

Strategic foundations §6 specifies: *"Device id: `crypto.randomUUID()`, persisted in `localStorage` (faster than IndexedDB for this single value) **and IndexedDB (backup)**."* Plan ships localStorage-only with a TODO for v0.6. If localStorage gets cleared (Android Chrome "Clear browsing data", site data deletion, OS storage pressure), the device generates a new UUID and is no longer registered. The security control silently degrades.

**Recommendation:** Add IDB backup write-through inside `useDeviceId` in v0.2, since the API is trivial (single key/value with `idb`, already a dependency). 10-line change. On startup, read from localStorage first; if miss, fall back to IDB; if both miss, generate fresh and write both.

### Improvement 4 (I4). `Math.random()` for a security credential

`String(Math.floor(100000 + Math.random() * 900000))` — `Math.random()` is not cryptographically secure. For a device-registration credential, this matters.

**Recommendation:**
```ts
const buf = new Uint32Array(1);
crypto.getRandomValues(buf);
const code = String(100000 + (buf[0] % 900000)).padStart(6, "0");
```
Add a collision check: re-roll if a row with the same `pending_setup_code` exists.

### Improvement 5 (I5). `generateDeviceSetupCode` schema pollution

The plan parks pending invites on the `registered_devices` table with `device_id: "__pending__" + code` and `active: false`. This pollutes the table — every `staff.isDeviceRegistered` query (per fix C3) has to filter out `__pending__*` rows. It also leaks the code into `device_id`, which is queryable.

**Recommendation:** Either (a) add a separate `pending_device_setups` table (~5 columns), or (b) store the pending code on a placeholder row but with `device_id: null` and a strict not-null filter on `by_device_id` queries. Option (a) is cleaner; do it.

### Improvement 6 (I6). Tests call `api.auth.verifyPinAction_internal`

Internal actions live under `internal.*`, not `api.*`. The test in Task 5 step 1:
```ts
const result = await t.action(api.auth.verifyPinAction_internal, { staffId, pin: "1234" });
```
will fail to resolve at TypeScript compile time. The codegen produces `internal.auth.verifyPinAction_internal`, not `api.auth.verifyPinAction_internal`.

**Recommendation:** Use `t.action(internal.auth.verifyPinAction_internal, ...)`. Or — better — once C1 is applied, the public `loginWithPin` action replaces the test surface and `verifyPinAction_internal` may not need to exist at all (the action does verify + commit inline).

### Improvement 7 (I7). `__test_echo` is a public mutation

`convex/idempotency.ts` exports `__test_echo` as `mutation()` (public). Any client can hit it. Should be `internalMutation`.

**Recommendation:** Change to `internalMutation`. Update the test to `t.mutation(internal.idempotency.__test_echo, ...)` or factor the test to call `withIdempotency` directly via a `t.run` wrapper.

### Improvement 8 (I8). `activateDevice` trusts client-supplied `deviceId`

The activation flow accepts any `deviceId` the client supplies. Combined with `Math.random()` (I4), a leaked setup code lets an attacker register a deviceId of their choice. For v0.2 (booth-only, manager-issued codes) the threat surface is limited, but the code-then-deviceId binding has no second factor.

**Recommendation:** v0.2 acceptable as-is given the low threat model, but document this in the audit log entry's `metadata`. Add a `note` flag to the device row when the activator's IP differs from the manager's session IP (Convex can read request headers via `ctx.requestHeaders` in actions). Followup task in v0.5.

### Improvement 9 (I9). Audit action `device.setup_code_issued` not in SCHEMA.md

Plan's `generateDeviceSetupCode` logs `action: "device.setup_code_issued"` — but the canonical audit action enum at `docs/SCHEMA.md:495-540` doesn't include it. WORKFLOW.md: *"Add the new action string to the enum in `convex/audit.ts` and `docs/SCHEMA.md`."* Plan does neither.

**Recommendation:** Add a step to Task 7 (or a final docs-update task) that appends `device.setup_code_issued` to SCHEMA.md's audit enum. While you're there, add `device.deactivated` (already in SCHEMA.md but not exercised) and any other new actions.

### Improvement 10 (I10). ConnDot 500ms polling

```ts
const id = setInterval(() => { ... }, 500);
```
120 wakeups per minute for a UI dot. On Android this matters — service workers + JS timers compete for the background-throttle budget.

**Recommendation:** Convex's reactive client exposes `convex.connectionState()` and (newer versions) `convex.onStateChange(callback)`. Subscribe once at mount; no polling. If the subscription API is unavailable in 1.31.7, bump the interval to 5000ms — the dot doesn't need 500ms precision.

### Improvement 11 (I11). `pos_idempotency.staff_id` schema mismatch

SCHEMA.md (line 411): `staff_id | Id<"staff">` — non-optional.
Plan's `convex/schema.ts`: `staff_id: v.optional(v.id("staff"))` — optional.
Plan's `withIdempotency` harness: never sets `staff_id` at all.

The plan's intent (per the comment) is "optional for pre-auth mutations (activateDevice)" — which is a real concern. But SCHEMA.md says non-optional, and the harness silently drops it for ALL mutations including post-auth ones where it's clearly available.

**Recommendation:**
1. Resolve the schema-doc discrepancy: SCHEMA.md gets updated to `staff_id?` for the same reason.
2. `withIdempotency` extracts `staff_id` from the session when the args carry a `sessionId`, and stores it. For pre-auth mutations (`activateDevice`), leaves it `undefined`.

### Improvement 12 (I12). No test for `getSession`

`getSession` is the query that backs `useSession` — the foundation of the entire session model. There's no test for: (a) returns null for `ended_at != null` sessions; (b) returns null when the staff row is `active: false`; (c) returns the expected shape for an active session.

**Recommendation:** Add 3-test block to `convex/auth.test.ts` covering the above. ~30 lines.

### Improvement 13 (I13). No test for `withIdempotency` error path

Related to I1. Add: "handler that throws → no row inserted → retry re-executes." Documents current behavior in code.

### Improvement 14 (I14). No router test for public routes

Plan modifies RootLayout to add a session gate. The router has `/approve/:token`, `/approve/:token/pin`, `/r/:receiptNumber` as public routes OUTSIDE RootLayout. If a future RootLayout change accidentally wraps these, they'd start requiring auth — breaking the WA approval flow and the customer-facing receipt page silently.

**Recommendation:** Add a quick router test (Vitest + MemoryRouter) that asserts `/approve/abc123` and `/r/R-2026-0001` render their target components without crashing under a fresh (no session) localStorage state.

### Improvement 15 (I15). vitest config uses jsdom for backend tests

```ts
test: {
  environment: "jsdom",
  include: ["src/**/*.{test,spec}.{ts,tsx}", "convex/**/*.test.ts"],
}
```

Convex backend tests should run in Node, not jsdom. jsdom adds startup time, exposes browser globals to backend code that shouldn't see them, and `convex-test` is designed for Node.

**Recommendation:** Use vitest's `environmentMatchGlobs`:
```ts
test: {
  environmentMatchGlobs: [
    ["src/**", "jsdom"],
    ["convex/**", "node"],
  ],
  ...
}
```
Or split into vitest projects (the plan's `test:convex` script implies projects but `defineConfig` doesn't actually set them up).

---

## 4. Refinements (Optional)

- **R1.** Plan header says "5 staff + 1 manager"; seed creates 4 staff (Bayu, Citra, Dewi, Eka) + 1 manager (Lucas) = 5 people total. Either add a 5th staff or correct the header.
- **R2.** `__smoke__.test.ts` naming — the double-underscore-prefix-and-suffix convention is unusual. Convention is just `smoke.test.ts`.
- **R3.** CHANGELOG draft (Task 16) has `YYYY-MM-DD` placeholder. Hardcode `2026-05-25` when committing.
- **R4.** Emoji `🔒` in `home.tsx`'s lock tile — minor; consistent with the existing wireframe convention but worth a one-line `docs/CODE_STYLE.md` note about when emoji are acceptable.
- **R5.** `tsconfig.json` should be checked for matching `@/*` paths config (the plan adds the alias to `vitest.config.ts` but tsc and IDE need it in `tsconfig.json` too).
- **R6.** `useSession.test.tsx` — the comment "we never reach the `useQuery` path" is wrong for the second test (which sets a stored id and DOES reach useQuery; the test passes only because useQuery throws a specific error swallowed by waitFor). Either fix the test to use a real ConvexProvider with a mocked query, or rewrite the comment.

---

## 5. Duplication Analysis

### Existing code to leverage

| Existing code | Location | How to use |
|---|---|---|
| `NumericKeypad` | `src/components/pos/NumericKeypad.tsx` | Already imported by `PinEntry`. Verify its button `aria-label`s match the test regex `/digit 1/i` — if labels are just `"1"` not `"Digit 1"`, the PinEntry test will fail. Quick visual check before Task 14. |
| `Stub` | `src/components/layout/Stub.tsx` | Currently the placeholder for `Login` and `Home`. Plan replaces both — confirm no other route still imports it. |
| `cn()` utility | `src/lib/utils.ts` | Already used by all shadcn primitives. Plan's components use it correctly. |
| `Sonner` toast | `src/components/ui/sonner.tsx` | Plan imports `toast` from `"sonner"` (the package) — verify the existing Sonner setup is mounted in `main.tsx` so toasts actually render. If not, add a `<Toaster />` mount task. |
| Existing shadcn primitives | `src/components/ui/*` | All used by the plan are present (button, card, input, label, badge). No missing primitives. |

### Potential duplication risks

- **`hashPin` + `argon2id` direct call in `convex/auth.test.ts`** — The test's `seedStaff` helper builds an argon2 hash manually instead of calling `hashPin`. Once C1+C2 are resolved, route the test through `hashPin` to keep one place that knows how to hash.
- **Date.now() repeated inline** — Task 6/7/8/9 sprinkle `Date.now()` literals. Per ADR-031 this is right (server time wins) but factor a tiny `const now = Date.now()` at the top of each handler to make snapshotting + auditing consistent within one operation.

---

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|---|---|---|
| Task 0 (test tooling) | ✅ Good | Right place to start. Add hash-wasm runtime smoke test per C6. |
| Task 1 (formatters) | ✅ Good | Pure functions, well-tested. No deps. |
| Task 2 (schema) | ⚠️ Needs adjustment | Fix `pos_idempotency.staff_id` per I11. |
| Task 3 (idempotency harness) | ⚠️ Needs adjustment | Fix I7 (internalMutation) + I1 + I11. |
| Task 4 (audit) | ✅ Good | Append-only via insert-only API. Solid. |
| Task 5 (verify action) | ❌ Major adjustment | Fix C1 + C2. May collapse into Task 6. |
| Task 6 (loginWithPin) | ❌ Major adjustment | Fix C1 (action, not mutation). |
| Task 7 (staff CRUD + device) | ⚠️ Needs adjustment | Fix C6, I4, I5, I8, I9. Add `isDeviceRegistered` per C3. |
| Task 8 (catalog query) | ✅ Good | Clean. |
| Task 8.5 (PWA SW) | ➕ Missing | Add per C5 or drop ADR-025 claim. |
| Task 9 (seed) | ⚠️ Needs adjustment | Fix C4 (internalMutation + guard). |
| Task 10 (useDeviceId) | ⚠️ Needs adjustment | Add IDB backup per I3. |
| Task 11 (useIdempotency) | ✅ Good | Document I2 followup. |
| Task 12 (useSession) | ⚠️ Needs adjustment | Fix R6 (test comment); add I12 test. |
| Task 13 (ConnDot + RootLayout) | ⚠️ Needs adjustment | Fix C3 (use `isDeviceRegistered`), I10 (polling), I14 (router test). |
| Task 14 (login) | ✅ Good | Verify NumericKeypad aria-labels first. |
| Task 15 (home) | ✅ Good | |
| Task 16 (changelog) | ✅ Good | Add I9 (audit enum update). |

**Ordering issues:** Tasks 5 + 6 may collapse to a single Task 5 once the action-based design is adopted. Task 8.5 (PWA SW) belongs between Task 8 (catalog query) and Task 13 (RootLayout uses catalog).

**Missing phases:** Task 8.5 (PWA SW per C5). Task 7.5 (`staff.isDeviceRegistered` per C3). Possibly a Task 0.5 (hash-wasm V8 smoke test) before committing to the file split.

---

## 7. Specialist Agent Recommendations

The plan instructs use of `superpowers:subagent-driven-development` or `superpowers:executing-plans` at the top. Both are appropriate. Additionally:

| Phase | Recommended Agent | Rationale |
|---|---|---|
| Tasks 2, 3, 4, 5, 6, 7, 8, 9 (Convex backend) | `convex-expert` | Specializes in Convex schema, idempotency wrappers, action↔mutation patterns. Exactly the agent needed to resolve C1/C2/C6. |
| Tasks 13, 14, 15 (frontend) | `frontend-integrator` | React + Convex wiring, hook composition, toast notifications — matches the plan's intent. |
| Task 14, 15 component pieces (PinEntry, StaffListItem, HomeNav tiles) | `ui-component-builder` | shadcn/Tailwind component author. |
| Post-execution review | `code-reviewer` (from agent roster) or re-run `/staffreview` on the diff | Catches whatever the plan didn't anticipate. |
| Pre-execution validation: confirm hash-wasm works in V8 runtime | `convex-expert` standalone spike | 30-min spike before committing to architecture. |

(These are real agents in the global roster — verified.)

---

## 8. Git Workflow Assessment

### Branch & merge strategy
| Check | Status |
|---|---|
| Feature branch specified | ❌ Not in plan |
| Branch naming follows convention | ⚠️ Not specified |
| Merge strategy documented | ❌ Not in plan |

The plan should specify a branch (e.g. `feat/v0.2-auth-catalog`) at the top, and a merge target (`main`).

### Commit checkpoints

The plan commits at the end of every task — **17 commits total**, one per task. This is excellent atomic-commit hygiene. Every task has a clearly-typed commit message (`feat(convex/auth):`, `chore(test):`, `docs(changelog):`). Each commit is independently revertable. This is the right shape.

### Pre-push verification
- [✅] `npm run typecheck` called in Task 13 step 6, Task 15 step 2
- [⚠️] `npm run build` not explicitly called anywhere — add to final verification before `git push`
- [✅] Tests run per task

**Recommendation:** Add `npm run build` to Task 16 step 2 (just before push).

### CI/CD & rollback
| Concern | Status |
|---|---|
| Rollback strategy | ❌ Missing (added in §0) |
| Deployment order | ⚠️ Implicit — backend deploys via `npx convex dev` watcher; frontend deploys via Vercel; no explicit ordering. |
| Data backup needed | No (dev deployment only; seed.reset is destructive but called manually) |
| Migration safety | ✅ Schema-only additions; no destructive migrations |

### Git workflow issues found
- No branch creation step at the start
- No `npm run build` verification before push
- No mention of deployment target (Vercel vs Convex dev vs Convex prod) — should clarify v0.2 is dev-only

---

## 9. Documentation Checkpoints

| Phase | Docs to update |
|---|---|
| Task 7 | `docs/SCHEMA.md` — add `device.setup_code_issued` to audit enum (I9) |
| Task 13 | `docs/CODE_STYLE.md` — if not present, add a section on session-gate patterns |
| Task 16 | `docs/CHANGELOG.md` — already in plan ✅ |
| Task 16 | `docs/SCHEMA.md` — confirm `pos_idempotency.staff_id` nullability matches schema.ts |
| (followup) | `CLAUDE.md` — once C5 resolves, either add v0.2 PWA notes or mark v0.3 as the SW landing |

### CHANGELOG draft (revised)

The plan's draft is solid. Suggested additions:
```markdown
## [0.2.0] — 2026-05-25

### Added
- ... (as in plan)

### Architecture notes
- `loginWithPin` is a Convex action (not a mutation) per ADR-004.
- `convex/auth.ts` (V8 runtime, queries+mutations) and `convex/authActions.ts` (Node runtime, actions) are kept separate per Convex runtime constraints.
- `staff.isDeviceRegistered({ deviceId })` enforces the strategic-§6 device-registration gate.

### Deferred to v0.3
- Idempotency-key persistence across page reload (`useIdempotency` IDB backing).
- `withIdempotency` error caching (currently errors retry).
- PWA service worker per ADR-025 (deferred from v0.2; tooling installed only).  ← only if you go option-1 on C5

### Notes
- ... (as in plan)
```

---

## 10. Testing Plan Assessment

**Verdict:** **Adequate-leaning-strong** — the plan's TDD discipline is genuinely exceptional. Every task: failing test → minimal impl → passing test → commit. Tests cover happy + error + edge cases for the auth flows. Gaps below are surgical, not systemic.

### Planned tests
| Layer | What | Test type | Status |
|---|---|---|---|
| Backend | `withIdempotency` replay + distinct keys | `convex-test` | ✅ Planned |
| Backend | `logAudit` appends + visible via list | `convex-test` | ✅ Planned |
| Backend | `getActiveStaff` filters active, no pin_hash leak | `convex-test` | ✅ Planned |
| Backend | `verifyPinAction` correct/incorrect PIN | `convex-test` | ✅ Planned (will need refactor per C1+I6) |
| Backend | `loginWithPin` happy + wrong PIN + lockout + logout | `convex-test` | ✅ Planned |
| Backend | `generateDeviceSetupCode` + `activateDevice` valid/expired | `convex-test` | ✅ Planned |
| Backend | `createStaff` manager-only | `convex-test` | ✅ Planned |
| Backend | `products.catalog` shape + inactive filtering | `convex-test` | ✅ Planned |
| Backend | `getSession` null/active/deactivated | `convex-test` | ❌ Missing (I12) |
| Backend | `withIdempotency` error path | `convex-test` | ❌ Missing (I13) |
| Backend | `staff.isDeviceRegistered` various states | `convex-test` | ❌ Missing (C3 dependency) |
| Backend | `seed.reset` is internal / guarded | `convex-test` | ❌ Missing (C4) |
| Frontend | `useDeviceId` persistence | Vitest+RTL | ✅ Planned |
| Frontend | `useIdempotency` stable per intent | Vitest+RTL | ✅ Planned |
| Frontend | `useSession` localStorage layer | Vitest+RTL | ✅ Planned (R6 test comment fix) |
| Frontend | `PinEntry` submit on 4th + clear | Vitest+RTL | ✅ Planned |
| Frontend | Login route smoke (renders heading) | Vitest+RTL | ✅ Planned |
| Frontend | Router public routes still public after RootLayout gate | Vitest+RTL | ❌ Missing (I14) |
| Manual | End-to-end PIN login → HomeNav | Manual (Task 15 step 3) | ✅ Planned |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|---|---|---|
| 1 | `getSession` returns null for ended session | Core to session security; useSession depends on it | `convex-test`, seed session with `ended_at: Date.now()`, assert query returns null |
| 2 | `getSession` returns null for deactivated staff | Same | Set staff.active=false after session created, assert null |
| 3 | `staff.isDeviceRegistered` for registered/unregistered/deactivated devices | The gate added per C3 must be tested | 3 simple `convex-test` cases |
| 4 | `withIdempotency` handler throws → no row → retry re-executes | Documents the choice per I1 | mock handler to throw, then succeed; assert second call executes |
| 5 | `seed.reset` cannot be called from public client | Per C4, after switching to internalMutation | Confirm `api.seed.reset` is undefined; only `internal.seed.reset` exists |
| 6 | Router: `/approve/:token`, `/r/:receiptNumber` render without auth | Per I14 | MemoryRouter test |
| 7 | PWA service worker registers + caches catalog | Only if C5 option-2 (ship SW in v0.2) | Smoke via `vite-plugin-pwa`'s dev SW |

### Test execution checkpoints

1. **After Task 0:** `npm test` → 1 passing (smoke)
2. **After Task 4:** `npm test -- convex/` → 5–7 passing (smoke + format + idempotency + audit + initial auth slice)
3. **After Task 9:** `npm test -- convex/` → all backend passing
4. **After Task 12:** `npm test` → backend + hooks all passing
5. **Before merge:** `npm test && npm run typecheck && npm run build` → all green

The plan does this implicitly per task; making it explicit in §5 (Success Criteria) hardens it.

### Regression risk

- **Low for backend** (greenfield — no existing Convex code to break).
- **Low for frontend** (RootLayout is a stub; Login + Home are stubs; replacing stubs can't regress anything).
- **Watch:** `src/router.tsx` modifications — the existing public routes (`/approve/*`, `/r/*`) and the lazy-loaded routes must still resolve. Cover via I14.

---

## 11. Edge Cases to Address

- [ ] Login flow when there are zero active staff (seed not yet run) — `getActiveStaff` returns `[]`; Login screen shows the empty-state message (plan already handles this in Task 14 step 6).
- [ ] Concurrent login attempts from two tabs with the same staffId — second tab's mutation should hit lockout counter race; idempotencyKey is different per tab so both attempts execute. Document.
- [ ] Device clock skew — server uses `Date.now()` for timestamps (ADR-031 ✅) but `useDeviceId` test fixtures and tests use the runner's clock. No real issue but worth noting if tests flake.
- [ ] localStorage quota exceeded on the staff device — `storeSession`, `useDeviceId` write small values, but in pathological browsers (e.g. private browsing) the writes throw. Wrap in try/catch.
- [ ] Page reload mid-PIN-entry — buffer is lost. Acceptable; staff just re-enters.
- [ ] Cross-tab logout while another tab is mid-mutation — `useSession`'s storage listener flips status to `none`, RootLayout redirects, but the in-flight mutation may still complete server-side. The session row gets ended_at; subsequent reads return null. OK.
- [ ] `pos_idempotency` TTL expiry — a key reused after 24h returns no cache hit and re-executes. For login that's fine. For payments (v0.3) this is a feature.
- [ ] `__pending__` device rows accumulating if codes are issued but never activated — no reaper in v0.2. Add reaper task to v0.3 backlog.
- [ ] Setup-code-issued-during-an-active-mgr-session vs no-active-session — `requireManagerSession` correctly enforces auth on `generateDeviceSetupCode`, so this is fine.
- [ ] Two managers issue codes simultaneously and the random codes collide (per I4) — handled by retry-on-collision recommendation.

---

## 12. Approval Conditions

**To approve, address:**

1. **C1** — Refactor `loginWithPin` to an action with internal-mutation commit per ADR-004.
2. **C2** — Split `convex/auth.ts` into V8 + Node files (or drop `"use node"` if hash-wasm works in V8 — verify first).
3. **C3** — Add `staff.isDeviceRegistered` query and rewire RootLayout to use it. Drop the proxy heuristic.
4. **C4** — `seed.reset` becomes `internalMutation` with an active prod guard.
5. **C5** — Decide: implement PWA SW as Task 8.5, or drop ADR-025 from the v0.2 scope claim.
6. **C6** — After C1/C2, confirm `hashPin` import path works across the chosen runtime split. May require an additional internal action.

**Recommended before implementation:**

1. I6 — Fix `api.*` vs `internal.*` in tests (will catch at compile time anyway but worth pre-empting).
2. I3 — Add IDB backup to `useDeviceId` (10 lines, real security hardening).
3. I4 — `crypto.getRandomValues()` for setup codes (3 lines).
4. I11 — Resolve `pos_idempotency.staff_id` nullability between schema.ts + SCHEMA.md.
5. I15 — Split vitest environment matchers for jsdom (frontend) vs node (backend).

**Recommended during implementation (no blocker, but track):**

- I1, I2, I7, I8, I9, I10, I12, I13, I14
- All R-items

---

*Generated by /staffreview*
*Staff Developer Review + Principal Developer Review*
