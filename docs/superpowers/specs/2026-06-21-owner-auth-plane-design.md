# Owner auth plane — Telegram-OTP cockpit login distinct from booth PIN auth

**Date:** 2026-06-21
**Phase:** v2.0 (multi-outlet — Phase 1.5: owner cockpit)
**Branch (target):** feat/v2.0-owner-auth-plane
**Decomposition rationale:** multi-tenancy brainstorm 2026-06-21 (4-spec program)
**Status:** Brainstorm — DRAFT for /spec-plan-pipeline review

## Identity

This slice ships the **owner authentication plane**: the credential and session machinery that lets a business OWNER log in to the cockpit (Spec 3) without touching booth PIN auth. It delivers:

- A `/cockpit/login` surface (account identifier → Telegram-OTP → durable cockpit session) — **distinct** from the booth staff-picker.
- A one-time Telegram **`/start <token>` binding** that verifies the owner's Telegram account, writes `staff.telegram_user_id`, and opens the DM channel for future OTPs.
- A **6-digit OTP** delivered to the owner's **private** Telegram DM (never the group), with TTL, rate-limiting, and per-challenge fail-cap.
- A durable **cockpit session** (`staff_sessions.kind: "cockpit"`, idle timeout + explicit logout) + an optional **remembered-device quick-PIN** for return visits.
- The new **`owner` role** (outlet-unscoped, bypasses `staff_outlet_access`).

This slice ships ONLY auth — it mints/validates/revokes cockpit sessions. It does **not** build the cockpit screens (Spec 3) or outlet scoping (Spec 1); it depends on both.

**Out of scope (v1 of this plane):**
- Cockpit pages/financials/wizard — [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md) (Spec 3).
- `outlet_id` threading, `staff_outlet_access`, owner bypass mechanics — [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md) (Spec 1) *(this spec consumes them)*.
- Per-outlet Telegram routing — [`2026-06-21-per-outlet-telegram-routing-design.md`](./2026-06-21-per-outlet-telegram-routing-design.md) (Spec 4) *(this spec adds the `/start <token>` handler that Spec 4's webhook composes)*.
- Mandatory passphrase / WebAuthn passkeys (ROADMAP); email/SMS OTP (ROADMAP).
- Control-plane / platform console (deferred future multi-business roadmap; ADR-051 *Future roadmap*).

Reference ADR: [`../ADR/052-owner-auth-telegram-otp.md`](../ADR/052-owner-auth-telegram-otp.md) ("OTP authorises MANAGE", extends ADR-029).

## Architecture overview

| # | Stream | Owner module(s) | Risk |
|---|---|---|---|
| 1 | Schema: `owner` role, `staff.telegram_user_id`, session `kind`/`last_active_at`, `owner_auth_otp`, `owner_auth_bindings` | `auth/` | Med — touches the most-depended-on table (`staff_sessions`) |
| 2 | Telegram `/start <token>` binding handler + token issuance | `telegram/`, `auth/` | Med — bot-cannot-DM-first constraint; deep-link UX |
| 3 | OTP request / verify actions + throttle + private-DM send | `auth/`, `telegram/` | High — security-critical; constant-time compare, rate limit, audit isolation |
| 4 | Cockpit session helpers (`requireCockpitSession`, idle timeout, `kind` discrimination) | `auth/` | Med — must not let booth/cockpit sessions cross planes |
| 5 | Remembered-device quick-PIN (optional return-visit path) | `auth/` | Low-Med — second device-bound factor |
| 6 | FE: `/cockpit/login` route + RootLayout cockpit gate | `src/routes/cockpit/`, `src/hooks/` | Med — new session-context branch |

---

## Workstream 1 — Schema

**Goal:** add the owner role, the DM binding target, the session-plane discriminator, and the two new auth tables — all additive/optional (no destructive migration).

### `staff` (auth/schema.ts) — amended

```ts
role: v.union(v.literal("staff"), v.literal("manager"), v.literal("owner")), // + "owner"
telegram_user_id: v.optional(v.number()), // private DM target; written by /start <token> binding (ADR-052 D-C)
```
- New index: `.index("by_telegram_user_id", ["telegram_user_id"])` — resolve a `/start` sender's `from.id` back to a staff row during binding redemption, and guard one-account-per-staff.
- `by_role` index already exists → owner lookups are free.

### `staff_sessions` (auth/schema.ts) — amended

```ts
kind: v.optional(v.union(v.literal("booth"), v.literal("cockpit"))), // absent ⇒ booth (backward-compat)
last_active_at: v.optional(v.number()),  // cockpit idle-timeout anchor (sliding); absent for booth
outlet_id: v.optional(v.string()),       // FROM SPEC 1: booth carries it, cockpit leaves it ABSENT (owner is outlet-unscoped)
```
- No new index needed; `by_device_active` / `by_staff_active` unchanged. Cockpit sessions still index fine (device_id is the owner's personal-device id — see WS6).

### `owner_auth_otp` (NEW — auth/schema.ts)

```ts
owner_auth_otp: defineTable({
  staff_id: v.id("staff"),
  code_hash: v.string(),          // argon2id of the 6-digit code (ADR-004: hash in an action)
  expires_at: v.number(),         // now + 5 min (server time)
  fail_count: v.number(),         // per-challenge wrong-code counter; cap 5 → invalidate
  consumed_at: v.union(v.number(), v.null()),
  created_at: v.number(),
  device_id: v.string(),          // device that requested it (binds verify to same browser)
})
  .index("by_staff_active", ["staff_id", "consumed_at"])
  .index("by_expires", ["expires_at"]),   // TTL purge cron
```

### `owner_auth_bindings` (NEW — auth/schema.ts)

Single-use `/start` binding tokens AND remembered-device tokens, discriminated by `kind`:

```ts
owner_auth_bindings: defineTable({
  kind: v.union(v.literal("telegram_bind"), v.literal("remember_device")),
  staff_id: v.id("staff"),
  token_hash: v.string(),         // sha256 of the raw token (mintUrlSafeToken, 32 bytes)
  expires_at: v.number(),         // bind: now + 60 min; remember: now + 30 d
  redeemed_at: v.union(v.number(), v.null()),
  created_at: v.number(),
  // remember_device only:
  device_id: v.optional(v.string()),
  quick_pin_hash: v.optional(v.string()),  // argon2id of the cockpit quick-PIN, bound to device
})
  .index("by_token_hash", ["token_hash"])
  .index("by_staff_kind", ["staff_id", "kind"])
  .index("by_expires", ["expires_at"]),
```

### Migration / backfill

| Step | Action |
|---|---|
| 1 | Add `staff.telegram_user_id?` + `staff_sessions.kind?`/`last_active_at?` (optional → free, Convex backward-compat). Existing sessions read as `kind` absent ⇒ booth. |
| 2 | Add `owner` to the `staff.role` union. No existing row needs rewriting (no row is owner yet). |
| 3 | Designate the first owner: a seed/bootstrap path (or a manager→owner promotion in the cockpit, manager-PIN gated, audited `staff.setRole`) sets `role: "owner"`. Reuses the existing `setStaffRole` PIN-gated funnel (`staff/actions.ts`), extended to accept `"owner"`. |
| 4 | Create `owner_auth_otp` + `owner_auth_bindings` tables; add a TTL-purge cron entry (`owner-auth-housekeeping`, daily) deleting expired/consumed OTP rows + redeemed/expired bind tokens (mirror `api-housekeeping`). |
| 5 | ESLint OWNERSHIP map: add `owner_auth_otp` + `owner_auth_bindings` → `"auth"`. |
| 6 | `docs/SCHEMA.md` first (house rule), then schema fragments. |

**Tests:** schema compiles; `kind` absent reads as booth; owner role accepted by validators; both new tables insert+index round-trip.

---

## Workstream 2 — Telegram `/start <token>` binding

**Goal:** bootstrap the owner↔Telegram link so the bot can DM OTPs (bot-cannot-DM-first constraint, ADR-052 §Decision B).

### Token issuance — `auth/ownerBinding.ts` (or `staff/actions.ts`)

`issueOwnerTelegramBindLink` action (manager-PIN or existing-owner gated; idempotencyKey + withIdempotency + authCheck):
- Mint raw token via `mintUrlSafeToken(32)` (convex/lib/tokens.ts).
- Insert `owner_auth_bindings { kind: "telegram_bind", staff_id, token_hash: sha256(raw), expires_at: now+60m, redeemed_at: null }`.
- Return the deep-link: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${raw}` (new env var `TELEGRAM_BOT_USERNAME`).
- `logAudit` verb `owner.bind_link_issued`.

### Webhook handler — `convex/telegram/startBinding.ts` (NEW)

Extends the `/start` command (today `replyStartHelp` in `telegram/registryCommands.ts`). New command registration parses `/start <token>`:
- **No token** → existing `replyStartHelp` (self-registration intro). Unchanged.
- **With token** → schedule `internal.telegram.startBinding.handleStartWithToken { chatId, fromId, token }`.

`handleStartWithToken` internalAction:
1. `_lookupBinding_internal` by `sha256(token)` (via `by_token_hash`); reject (reply "❌ Link expired or already used.") if missing / `redeemed_at != null` / expired / `kind != "telegram_bind"`.
2. **One-account guard:** if another staff already has this `telegram_user_id` (`by_telegram_user_id`), reject — prevents two staff binding the same Telegram account.
3. `_redeemBinding_internal` mutation (server-time, idempotent): set `redeemed_at = now`; patch `staff.telegram_user_id = fromId`; `logAudit` `owner.telegram_bound` (source `system`).
4. Reply in the DM: "✅ Cockpit DM linked. You can now request login codes." — and because this `/start` opened the private chat, the bot can DM thereafter.

**Crucial:** the binding must come from a **private** chat (`chatType === "private"`); reject group `/start <token>` (an OTP must never land in a group). Assert on `msg.chatType`.

### http.ts wiring (composes with Spec 4)

`buildStartBindingCommand(scheduler)` is added to the webhook command list **before** the registry `/start` (token branch first, bare `/start` falls through to help). Spec 4 owns the final command-list assembly; this spec contributes the handler.

**Tests:** token redeem happy-path (writes `telegram_user_id`, marks redeemed); expired/consumed/wrong-kind rejected; group-chat `/start <token>` rejected; duplicate `telegram_user_id` rejected; bare `/start` still replies help.

---

## Workstream 3 — OTP request / verify (security-critical)

**Goal:** deliver a 6-digit OTP to the owner's private DM, verify it constant-time, mint a cockpit session — with rate-limiting and audit isolation from booth lockout.

### `requestOwnerOtp` action — `auth/ownerActions.ts` (NEW, `"use node"` for argon2)

Args: `{ idempotencyKey, identifier: string, deviceId: string }`. (`identifier` = the owner's `staff.code`, e.g. `S-0001`; see Open Questions on alternatives.)
1. Resolve owner by `identifier` → `_getOwnerByIdentifier_internal`. **Leak-free:** on missing / non-owner / no `telegram_user_id`, return a generic `{ ok: true }` (do NOT reveal whether the account exists/is bound). Always behave as if a code was sent.
2. **Rate limit** (reuse the lockout pattern, ADR-002 shape): a per-owner request counter (new `owner_auth_otp`-adjacent check or a `pos_auth_attempts`-style row keyed by `staff_id`): max 3 requests / 15 min → throw `OTP_COOLDOWN:Ns`. Prevents OTP-request DM flooding.
3. Mint 6-digit numeric code (`crypto.getRandomValues`, zero-padded). argon2id-hash it (ADR-004 — hashing in an action).
4. `_createOtpChallenge_internal` mutation: invalidate any prior active challenge for this staff (consume them), insert the new `owner_auth_otp` row (`expires_at = now + 5min`, `device_id`). `logAudit` `owner.otp_requested` (source `system`).
5. DM the code via a new `telegram/send.ts` template kind **`owner_otp`** → routed to the owner's **private** chat by `telegram_user_id` (NOT a role→group lookup). Send `disableNotification: false`. Message: code + 5-min expiry + "ignore if you didn't request this."

### `verifyOwnerOtp` action — `auth/ownerActions.ts`

Args: `{ idempotencyKey, identifier, code, deviceId }`.
1. Resolve owner; load the active (`consumed_at == null`, unexpired) challenge for `staff_id` via `by_staff_active`. Missing/expired → `OTP_INVALID` (generic).
2. **Constant-time compare** entered `code` against `code_hash` (argon2 verify). On miss: `_recordOtpFailure_internal` increments `fail_count`; at cap 5 → consume the challenge (force re-request); throw `OTP_INVALID`. **Audited (`owner.otp_failed`) but does NOT touch `pos_auth_attempts` / booth lockout** — SEC-07 isolation (a cockpit attacker must not DoS-lock booth logins).
3. On success: consume the challenge (`consumed_at = now`), then `_cockpitLoginCommit_internal` (withIdempotency) → insert `staff_sessions { kind: "cockpit", staff_id, device_id, started_at: now, last_active_at: now, ended_at: null, end_reason: null }` (no `outlet_id`). `logAudit` `owner.login` (source `system`, entity_type `staff_session`). Return `{ sessionId, role: "owner" }`.

### `telegram/send.ts` — `owner_otp` kind

Add `v.literal("owner_otp")` to the `kind` union + a `renderOwnerOtp` template in `convex/lib/telegramHtml.ts` (plain HTML, no URL button — it's informational/secret, not an approval). **Routing exception:** unlike every other kind which resolves a role→group chatId, `owner_otp` is sent with `chatIdOverride = String(telegram_user_id)` (private DM). Document this as the one kind that bypasses role-routing.

**Tests:** happy path (request→verify→cockpit session minted, no outlet_id); wrong code increments fail_count, no booth-lockout touch; 5 misses consume challenge; expired challenge rejected; rate-limit after 3 requests; unknown/non-owner/unbound identifier returns generic ok (no leak); OTP delivered to private chatId, never a group.

---

## Workstream 4 — Cockpit session helpers

**Goal:** a `requireCockpitSession` that enforces `kind: "cockpit"` + owner role + idle timeout, and keep booth helpers rejecting cockpit sessions (cross-plane safety).

### `auth/sessions.ts` — new helpers

```ts
// Idle timeout for cockpit (ms). 30 min sliding.
export const COCKPIT_IDLE_MS = 30 * 60 * 1000;

export async function requireCockpitSession(
  ctx: QueryCtx | MutationCtx, sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string }> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.ended_at != null) throw new Error("NO_SESSION");
  if ((s.kind ?? "booth") !== "cockpit") throw new Error("NOT_COCKPIT_SESSION");
  const staff = await ctx.db.get(s.staff_id);
  if (!staff || !staff.active || staff.role !== "owner") throw new Error("NO_SESSION");
  // Idle timeout (server-time-wins). NB: queries can't patch; the sliding
  // refresh happens in a dedicated touchCockpitSession mutation (below).
  if (s.last_active_at != null && Date.now() - s.last_active_at > COCKPIT_IDLE_MS) {
    throw new Error("SESSION_IDLE_TIMEOUT");
  }
  return { staffId: s.staff_id, deviceId: s.device_id };
}
```

- **`requireSession` / `requireManagerSession` cross-plane guard:** add `if ((s.kind ?? "booth") !== "booth") throw new Error("NOT_BOOTH_SESSION");` so a cockpit session id cannot be replayed against booth mutations. (Owner role itself is NOT a booth manager — owner manages via the cockpit plane only.)
- **`touchCockpitSession` mutation** (public, idempotencyKey + authCheck): patches `last_active_at = now` on cockpit-route reads/writes (sliding refresh). FE calls it on cockpit navigation / a heartbeat. Server-time-wins.
- **`logoutCockpit`**: ends the cockpit session (`ended_at = now`, `end_reason: "manual_lock"`), audited `owner.logout`.

**Tests:** cockpit helper rejects booth session + idle-timed-out session + non-owner; booth helpers reject cockpit session; `touchCockpitSession` slides `last_active_at`; logout ends session.

---

## Workstream 5 — Remembered-device quick-PIN (optional return path)

**Goal:** on a remembered device, skip full OTP and unlock with a device-bound quick-PIN (second factor "something you set").

- During (or just after) a successful OTP login, FE offers "Remember this device (30 days)". If accepted, owner sets a 4-6 digit **cockpit quick-PIN**.
- `registerRememberedDevice` action: argon2-hash the quick-PIN; insert `owner_auth_bindings { kind: "remember_device", staff_id, device_id, quick_pin_hash, token_hash, expires_at: now+30d, redeemed_at: null }`. Return a raw remembered-device token persisted in the FE (localStorage, namespaced via `storage-keys.ts`). Audited `owner.device_remembered`.
- `quickPinLogin` action: args `{ identifier, deviceId, rememberToken, quickPin }`. Look up the `remember_device` binding by `token_hash` + `device_id`; verify not expired; argon2-verify the quick-PIN (booth-style lockout: 3 misses → 60s, keyed per binding, isolated from booth counter). On success mint a `kind: "cockpit"` session (same `_cockpitLoginCommit_internal`). Audited `owner.login` (sub-reason `quick_pin`).
- **First login on any device is always full OTP.** The remembered-device path is strictly a return-visit convenience. Clearing it: logout-all or expiry purges the binding.

**Tests:** remember enrolls a binding; quick-PIN login on remembered device mints cockpit session; wrong quick-PIN locks after 3 (isolated counter); expired/foreign-device token rejected → fall back to OTP.

---

## Workstream 6 — FE `/cockpit/login` + session context

**Goal:** the cockpit login surface (separate from the booth staff-picker) and a session-context branch that knows it's a cockpit session.

### Route — `src/routes/cockpit/login.tsx` (NEW)

State machine (route owns the phases, mirrors the v1.2 login PIN-feedback pattern — presentational entry + route-owned phase machine):
1. **Identifier** → enter owner `staff.code`. On submit, call `requestOwnerOtp`.
2. **OTP** → 6-digit `NumericKeypad` (reuse `components/pos/NumericKeypad`); "Code sent to your Telegram." Inline `FieldMessage` (ADR-048) for errors — generic on bad code, cooldown countdown on rate-limit. On submit, `verifyOwnerOtp` → `storeSession`.
3. **Remember device?** (optional) → set quick-PIN (WS5).
- Quick-PIN return path: if a remembered-device token exists for this device, show the quick-PIN keypad first with "Use a login code instead" escape to the OTP flow.
- No staff-picker, no device-activation gate. The cockpit is reachable from any device (the OTP-to-DM IS the device-independent factor).

### Session context — `src/hooks/useSession.ts`

- Extend `getSession` (auth/public.ts) projection to include `kind` and (for cockpit) `role: "owner"`. Add `kind: "booth" | "cockpit"` to the active `SessionState`.
- RootLayout: a **cockpit branch** — `/cockpit/*` routes require `status: "active"` + `kind === "cockpit"`; booth routes require `kind === "booth"`. A booth session hitting `/cockpit/*` (or vice-versa) → redirect to the correct login. (Interplay with Spec 3's cockpit route tree.)
- `storeSession`/`clearSession` reused; cockpit logout calls `logoutCockpit` then `clearSession`.

**Tests (e2e, deferred to Spec 3 harness):** identifier→OTP→cockpit dashboard; cockpit session blocked from booth routes; idle-timeout bounces to `/cockpit/login`. Unit: phase machine transitions; generic-error rendering.

---

## Implementation notes

- **Server time wins everywhere** (ADR-031): all `expires_at`, `*_at`, OTP TTL, idle-timeout from `Date.now()` inside handlers. The OTP code itself is server-minted; client never supplies it.
- **Idempotency:** `requestOwnerOtp`, `verifyOwnerOtp`, `issueOwnerTelegramBindLink`, `registerRememberedDevice`, `touchCockpitSession`, `logoutCockpit` are public mutations/actions → `idempotencyKey` + `withIdempotency` + `authCheck`. **Distinct keys per intent** (request ≠ verify) — the action→mutation chain idempotency-key-collision trap (MEMORY: idempotency shared-key collision) means `verifyOwnerOtp`'s action key and its `_cockpitLoginCommit_internal` mutation key must differ (e.g. derive a `:commit` suffix), exactly like `loginWithPin`.
- **argon2 in actions, never mutations** (ADR-004): OTP-hash, quick-PIN-hash, and all verifies live in `"use node"` actions. The commit mutations only store/compare pre-hashed strings via internal calls.
- **Audit isolation (SEC-07):** OTP/quick-PIN misses are audited (`owner.otp_failed`) but use their OWN counters (`owner_auth_otp.fail_count`, remembered-device binding lockout) — they NEVER write `pos_auth_attempts`. A cockpit attacker cannot DoS-lock a booth manager login. This mirrors the `countTowardLockout: false` principle in `_recordFailedAttempt_internal`.
- **Leak-free responses:** unknown identifier, non-owner, and unbound-Telegram all return the same generic "code sent" shape from `requestOwnerOtp`, and the same `OTP_INVALID` from `verifyOwnerOtp`. No oracle for "is this a real owner / is their Telegram bound."
- **New audit verbs** (document in `docs/SCHEMA.md`): `owner.bind_link_issued`, `owner.telegram_bound`, `owner.otp_requested`, `owner.otp_failed`, `owner.login`, `owner.logout`, `owner.device_remembered`. `audit_log.source` for these is `system` (bot-mediated) — NOT `telegram_approval` (reserved for PIN approval flows, per MEMORY: telegram_approval reserved for PIN flows; use `system` for no-PIN bot mints).
- **Env vars:** `TELEGRAM_BOT_USERNAME` (for the deep-link), set on dev + prod. Existing `TELEGRAM_BOT_TOKEN` reused for DM send.
- **Rollback:** all additive/optional. To back out: stop minting `kind: "cockpit"` sessions, drop the `/cockpit` route tree + `owner_otp` template; `owner` role + `telegram_user_id` + the two tables are inert if unused. No destructive migration.
- **Prod ops:** the first owner must be promoted (manager→owner, PIN-gated) AND bind their Telegram via a one-time deep-link before they can ever log in — sequence this in the cutover runbook (owner promotion → issue bind link → owner taps `/start` in DM → owner requests first OTP).
- **`no-cross-module-db-access`:** the `owner_otp` Telegram template reads `staff.telegram_user_id` — resolve it via an `auth/internal` query (`_getOwnerTelegramTarget_internal`) passed to `telegram/send.ts`, not a direct cross-module `ctx.db` read.

## Cross-references

- Fulfils [`../ADR/052-owner-auth-telegram-otp.md`](../ADR/052-owner-auth-telegram-otp.md) (OTP authorises MANAGE; owner-vs-booth plane separation).
- Extends [ADR-029](../ADR/029-token-authorizes-view-pin-authorizes-act.md) (VIEW/ACT → +MANAGE).
- Reuses [ADR-001](../ADR/001-pin-only-authentication.md)/[ADR-002](../ADR/002-lockout-policy.md)/[ADR-004](../ADR/004-pin-hashing-server-side.md) (quick-PIN), [ADR-013](../ADR/013-idempotency-keys.md), [ADR-031](../ADR/031-convex-server-time-wins.md), [ADR-035](../ADR/035-telegram-as-internal-comms.md).
- **Spec 1** — [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md): provides `staff.role = "owner"` bypass of `staff_outlet_access`, `staff_sessions.outlet_id` (cockpit leaves it absent).
- **Spec 3** — [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md): the cockpit surface this auth plane gates (consumes `requireCockpitSession`).
- **Spec 4** — [`2026-06-21-per-outlet-telegram-routing-design.md`](./2026-06-21-per-outlet-telegram-routing-design.md): composes the `/start <token>` handler this spec adds; per-outlet vs business-wide routing.

## Open questions (review at /spec-plan-pipeline)

**Q1 — Owner identifier at `/cockpit/login`: `staff.code` vs a friendlier handle?**
Recommendation: use `staff.code` (e.g. `S-0001`) for v1 — it already exists, is unique, and avoids a new field/index. Add a friendly handle/email-less username only if owners find codes awkward.
Why: minimizes new surface; `staff.code` is already the external-stable id (API uses it). A username is a roadmap nicety, not a v1 need.

**Q2 — Owner Telegram-account loss = lockout. What is the recovery path?**
Recommendation: an admin-issued re-bind — another owner/manager (PIN-gated) issues a fresh `telegram_bind` deep-link to the locked-out owner's NEW Telegram account, which overwrites `telegram_user_id`. For a single-owner business, document the remembered-device quick-PIN as the same-device fallback and a break-glass "contact Frollie vendor" path (a future multi-business control plane could re-seed).
Why: full account-recovery infra is overkill for a tiny owner cohort; an admin re-bind covers the multi-manager case; true self-serve recovery belongs to the deferred multi-business roadmap.

**Q3 — Does the `owner` role also grant booth (manager) capabilities at a booth device?**
Recommendation: NO for v1 — owner is a cockpit-plane role only; booth manager actions still require a `kind: "booth"` manager session. If an owner also staffs the booth, give them a separate `manager` staff record (or treat owner as manager-at-booth via a follow-up). Keep the planes clean in v1.
Why: blurring the planes reintroduces the cross-plane replay risk WS4 is built to prevent. Cleaner to keep owner = cockpit-only until a concrete booth need appears.

**Q4 — OTP length / TTL: 6-digit / 5-min — right balance?**
Recommendation: 6-digit numeric, 5-min TTL, 5-attempt cap, 3-requests/15-min rate limit (as specced). Revisit only if booth telemetry shows owners routinely time out.
Why: 6 digits + 5 attempts + short TTL gives ~1e6/5 brute-force resistance per challenge with negligible UX cost; matches common OTP norms.

**Q5 — Should cockpit sessions appear in the booth's `staff_sessions` device-active queries / shift state?**
Recommendation: NO — `boothState`/`by_device_active` consumers must filter `kind === "booth"` (or absent). A cockpit session on the owner's personal device must never derive booth/shift state. Add the filter where `by_device_active` is read.
Why: a cockpit session shares the table but is a different plane; leaking it into shift derivation would corrupt booth state (cf. MEMORY: handover no-session deadlock — session-plane confusion is a real prod hazard).
