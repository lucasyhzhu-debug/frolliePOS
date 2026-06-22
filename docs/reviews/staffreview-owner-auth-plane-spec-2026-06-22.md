# Staff Review: Owner auth plane (Spec 2) — Telegram-OTP cockpit login

**Date:** 2026-06-22
**Plan:** `docs/superpowers/specs/2026-06-21-owner-auth-plane-design.md` (+ `docs/ADR/052-owner-auth-telegram-otp.md`)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (design spec — workstream goals, schema, tests-per-stream, rollback, open questions all present)
**Depends on:** Spec 1 (multi-outlet data plane) — PLANNED + LANDED in docs, **NOT executed in code**. Every owner-auth artifact that consumes a Spec-1 symbol (`owner` role, `staff_outlet_access` bypass, `staff_sessions.outlet_id`, `requireSession` outlet return) is **blocked on Spec-1 execution**.

---

## 1. Summary

**Overall Assessment: Revise** (5 Critical, all addressable inline; the architecture is sound).

The spec is strong: it reuses the right primitives (`mintUrlSafeToken`, argon2-in-action, `chatIdOverride` for DM routing, server-time-wins, idempotency dual-call), states the OTP/MANAGE third-verb model cleanly, and isolates the cockpit plane from booth lockout. But five issues are grounded in **code-truth that contradicts the spec as written**, and three of those are cross-spec collisions with the un-executed Spec-1 plan that must be sequenced explicitly:

1. **The Telegram command matcher physically cannot match `/start <token>`** — it is strict-mode and tested to reject trailing args. WS2's entire binding flow is dead on arrival without a matcher change.
2. **`staff_sessions.outlet_id` is flipped to *required* by Spec-1 Task 12**, but cockpit sessions are outlet-less by design — a guaranteed schema-violation on every cockpit login unless Spec-1's enforce step is amended.
3. **The OTP code leaks in cleartext into `telegram_log`** via `sendTemplate`'s existing `logOutbound` path.
4. **WS3's rate-limit counter contradicts its own SEC-07 isolation note** (says reuse `pos_auth_attempts`; the isolation rule forbids touching it).
5. **The `requireSession` cross-plane `kind` guard and Spec-1's `outlet_id` rewrite edit the same hot helper** and have an order-dependent interaction (NOT_BOOTH_SESSION must fire before SESSION_NO_OUTLET).

All five are fixed inline in this pass. The 5 open questions (Q1–Q5) are surfaced with recommended resolutions in §12 for the user to confirm.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | Strict command matcher rejects `/start <token>` — binding flow never dispatches | Logic / Integration | WS2 |
| C2 | Spec-1 flips `staff_sessions.outlet_id` to required; cockpit sessions are outlet-less ⇒ insert fails | Schema / Cross-spec | WS1 + Spec-1 T12 |
| C3 | OTP code persisted in cleartext to `telegram_log` via `logOutbound` | Security | WS3 / send.ts |
| C4 | OTP-request rate-limit reuses `pos_auth_attempts`, violating its own SEC-07 isolation | Security / Logic | WS3 step 2 |
| C5 | `kind` cross-plane guard + Spec-1 `outlet_id` rewrite collide in `requireSession`; throw-order matters | Architecture / Cross-spec | WS4 + Spec-1 T3/T12 |

### Issue C1: The strict command matcher cannot match `/start <token>`

WS2 says: *"New command registration parses `/start <token>` … bare `/start` falls through to help."* This is impossible with the current matcher.

`buildCommandMatcher` (`convex/telegram/commands.ts:63`) compiles every command to:
```ts
new RegExp(`^\\/${escapeRegex(c.name)}(@[A-Za-z0-9_]+)?$`)
```
The trailing `$` means **no arguments are allowed**. This is a *tested, load-bearing invariant*:
- `convex/telegram/__tests__/commands.test.ts:26` — `expect(matcher("/ping now")).toBeNull();`
- `convex/telegram/__tests__/activatePos.test.ts:138` — `expect(matcher("/activatepos 123")).toBeNull();`

A Telegram deep-link `https://t.me/<bot>?start=<token>` sends the literal message **`/start <token>`**. Under the current matcher that returns `null` → the webhook (`webhook.ts:105`) dispatches nothing → the owner taps the link and gets **silence**. The binding never happens. The spec's contributed handler is unreachable.

The webhook *does* hand the full raw text to dispatch (`MessageContext.text`, `commands.ts:19`), so once a `/start …` message *matches*, the handler can re-parse the token. The problem is purely at the match layer.

**Recommendation:** Add an **arg-aware match path scoped to `/start` only** — do not globally loosen the matcher (that would make `/activatepos 123` match and break the tested strict contract for every other command). Two clean options:
- (a) A `CommandRegistration.acceptsArgs?: boolean` flag; when set, the compiled regex becomes head-only `^\/${name}(@[A-Za-z0-9_]+)?(\s+\S.*)?$` and dispatch reads the tail from `text`. Only `start` opts in.
- (b) A dedicated `buildStartBindingCommand` whose matcher entry is the head-only variant, concatenated **before** `buildRegistryCommands` so a tokened `/start` matches the binding handler and a bare `/start` falls through to `replyStartHelp` (the bare-form regex still needs to match — see below).

Either way the **bare `/start` must still route to `replyStartHelp`** and `/start <token>` to the binding handler. Since one `name: "start"` registration can only compile one regex, the cleanest shape is a **single `start` handler that branches on whether `text` contains a token** (parse the tail; empty ⇒ help, non-empty ⇒ binding), registered once with the head-only regex. Add matcher tests: `/start` (help), `/start <token>` (binding), `/start@FrolliePOS_Bot <token>` (binding), and assert other commands stay strict.

### Issue C2: Spec-1 makes `staff_sessions.outlet_id` *required* — cockpit sessions have none

WS1 declares `staff_sessions.outlet_id: v.optional(...)` with *"cockpit leaves it ABSENT (owner is outlet-unscoped)."* That is correct intent — but it **directly contradicts the Spec-1 plan it sits on top of**.

Spec-1 plan Task 12 (`docs/superpowers/plans/2026-06-21-v2.0-multi-outlet-foundation.md`, Step 2): *"Flip every `outlet_id` to required `v.id("outlets")` (drop `v.optional`)"* — and `staff_sessions` is in the OUTLET_SCOPED set (Spec-1 plan Task 2). Once that enforce ships, **a row inserted into `staff_sessions` without `outlet_id` is a schema-validation failure**. `_cockpitLoginCommit_internal` inserts exactly such a row on every cockpit login → **owner login is impossible** after Spec-1 enforce.

This is the single most important cross-spec catch: owner-auth cannot just "leave the field absent" against a column Spec-1 has made mandatory.

**Recommendation (amends the Spec-1 plan):** `staff_sessions.outlet_id` must **stay `v.optional(v.id("outlets"))`** — it is the one OUTLET_SCOPED table whose rows legitimately split by `kind` (booth ⇒ has outlet, cockpit ⇒ none). Move the "booth sessions must carry an outlet" invariant from the *schema validator* to *runtime* in `requireSession`: `kind` booth/absent ⇒ require `outlet_id` (throw `SESSION_NO_OUTLET`), `kind` cockpit ⇒ assert `outlet_id` absent. Two concrete obligations for the plan:
- Mark this as a **required edit to Spec-1 Task 12** ("exclude `staff_sessions.outlet_id` from the required-flip; keep optional"). Because Spec-1 is not yet executed, this is a clean amendment — flag it as **blocked-on-Spec-1** and land it as part of Spec-1 execution OR as the first owner-auth schema task that *re-relaxes* the field if Spec-1 already enforced it.
- The owner-auth schema task must NOT assume it can write an outlet-less row against an enforced-required column; it owns keeping the field optional.

### Issue C3: The OTP code leaks in cleartext into `telegram_log`

WS3 sends the OTP via a new `owner_otp` kind through `sendTemplate`. But `sendTemplate` step 6 (`convex/telegram/send.ts:302`) unconditionally calls:
```ts
await ctx.runMutation(internal.telegram.internal.logOutbound, {
  template_kind: args.kind,
  payload_json: JSON.stringify({ request: body, response: responseJson }),
  ...
});
```
`body.text` is the **fully-rendered message** — i.e. the 6-digit OTP in plaintext — and `responseJson` echoes the sent text back. So every OTP send writes the secret code into the `telegram_log` table (and the debug trail). This breaks the spec's own "never log PIN/secret values" principle (Implementation notes; mirrors verifyPin.ts "Never logs PIN values").

**Recommendation:** For `kind === "owner_otp"`, **redact the code from the logged payload** — either skip `logOutbound` entirely for that kind, or log a redacted body (`text: "[redacted owner_otp]"`) and strip `result.text` from the echoed response. Add a test asserting no 6-digit code appears in the `telegram_log` row for an `owner_otp` send. (Also confirm `_auditSendFailed_internal` and the audit row carry no code — they currently log `status`/`chat_id` only, which is fine.)

### Issue C4: OTP-request throttle must not reuse `pos_auth_attempts` (self-contradiction)

WS3 step 2 says the per-owner OTP-request rate limit is *"a `pos_auth_attempts`-style row keyed by `staff_id`."* But the Implementation-notes SEC-07 block says OTP activity *"NEVER write[s] `pos_auth_attempts` … a cockpit attacker cannot DoS-lock a booth manager login."* These contradict: if OTP-request counting lands in `pos_auth_attempts`, an attacker spamming `requestOwnerOtp` bumps the exact counter `_getLockState_internal` reads for booth login (`verifyPin.ts:35`), re-opening the cross-plane DoS SEC-07 closes.

**Recommendation:** Use a **dedicated counter that never touches `pos_auth_attempts`** — either a small `owner_auth_attempts` table (`staff_id`, `request_count`, `window_start_at`, `locked_until`) or a request-throttle field set on the active `owner_auth_otp` challenge. Reword WS3 step 2: *"`pos_auth_attempts`-style"* means the **shape/pattern**, not the table. The quick-PIN lockout (WS5) has the same requirement — its "isolated counter" must likewise be its own row (per-`remember_device` binding), never `pos_auth_attempts`.

### Issue C5: `kind` cross-plane guard collides with Spec-1's `requireSession` rewrite

WS4 adds to `requireSession`/`requireManagerSession`: `if ((s.kind ?? "booth") !== "booth") throw "NOT_BOOTH_SESSION"`. Spec-1 Task 3 **already rewrites the same two helpers** to resolve and return `outlet_id` (with a migration-window fallback, later a `SESSION_NO_OUTLET` throw at enforce). Two specs, one hot helper, edited independently.

The interaction is **order-dependent**: a cockpit session is *legitimately* outlet-less. If Spec-1's `SESSION_NO_OUTLET` check runs first, a replayed cockpit session id throws the *wrong* error (`SESSION_NO_OUTLET` instead of `NOT_BOOTH_SESSION`) — confusing, and it couples the cockpit-rejection path to the outlet-enforce path. The `NOT_BOOTH_SESSION` guard must run **before** the outlet resolution/throw.

**Recommendation:** Mark this **blocked-on-Spec-1**; the owner-auth edit lands *on top of* Spec-1's version of `sessions.ts`. Specify the final ordering inside `requireSession`: (1) load session, reject ended/missing; (2) load staff, reject inactive; (3) **`kind` guard — reject non-booth here**; (4) resolve `outlet_id` / `SESSION_NO_OUTLET`. Cockpit sessions never reach step 4. Add a test: a `kind:"cockpit"` session id throws `NOT_BOOTH_SESSION` (not `SESSION_NO_OUTLET`) from `requireSession`.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | "existing-owner gated" bind-link can't use `verifyManagerPinOrThrow` (rejects non-managers) | H | L |
| I2 | New owner tables must be excluded from Spec-1's `index-leads-with-outlet_id` OUTLET_SCOPED fence | H | L |
| I3 | `owner_otp` still needs a `role` arg for audit even with `chatIdOverride` | M | L |
| I4 | `getSession` is triple-edited across two specs (outlet + kind) + read by `verifyManagerPinOrThrow` | M | L |
| I5 | `owner-auth-housekeeping` cron slot collides with existing pre-dawn jobs | L | L |

### Improvement I1: Owner-gated bind-link issuance can't use the manager-PIN funnel

WS2 says `issueOwnerTelegramBindLink` is *"manager-PIN or existing-owner gated."* But `verifyManagerPinOrThrow` (`convex/auth/verifyPin.ts:113`) hard-rejects any non-manager: `if (!manager || !manager.active || manager.role !== "manager") throw "NOT_MANAGER"`. An `owner` is role `"owner"`, not `"manager"`, and **owner has no PIN plane at all** (they auth via OTP). So "existing-owner gated" cannot route through the manager-PIN funnel.

**Recommendation:** Split the two issuance authorities explicitly: first-owner bootstrap = seed path or a **manager-PIN** (`verifyManagerPinOrThrow`); an existing owner re-issuing for another owner/device = an **owner cockpit session** gate (`requireCockpitSession`), not a PIN. Name the helper for each path in the plan. (This also resolves Q2's admin re-bind recovery — a manager-PIN re-bind is the multi-manager recovery path.)

### Improvement I2: Owner tables must be excluded from the Spec-1 outlet-scoping fence

Spec-1 adds an `index-leads-with-outlet_id` ESLint fence over an `OUTLET_SCOPED` set; any `by_outlet_*` query that doesn't lead with `.eq("outlet_id", …)` fails CI. `owner_auth_otp` and `owner_auth_bindings` are **business-level / outlet-unscoped** (owner has no outlet). Their indexes (`by_staff_active`, `by_token_hash`, `by_expires`, `by_staff_kind`) must be treated like the other business-level tables (`staff`, `audit_log`, `api_*`) — **not** in OUTLET_SCOPED, so the fence doesn't demand an `outlet_id` lead they can't have.

**Recommendation:** Add a plan task (blocked-on-Spec-1): register `owner_auth_otp` + `owner_auth_bindings` in the **business-level exclusion list** of the Spec-1 fence config (`eslint.config.js`), alongside the OWNERSHIP-map addition (`→ "auth"`) the spec already calls for. Same for `owner_auth_attempts` if C4 adds it.

### Improvement I3: `owner_otp` send still needs a `role` for the audit row

WS3 says `owner_otp` *"bypasses role-routing"* via `chatIdOverride`. Correct — but `sendTemplate` (`send.ts:166`) still **requires** `role` (*"`role` is still required for audit logging even when this is set"*) and `_auditSendFailed_internal` logs it. The plan must pass a `role` string for audit attribution even though `getChatIdByRole` is skipped.

**Recommendation:** Pass a stable label (e.g. `role: "owner"`, or reuse `"managers"`) purely for the audit trail; document `owner_otp` as the one kind where `role` is audit-only, not routing. Combine with C3 (redact the code) so the audit/log path carries attribution but not the secret.

### Improvement I4: `getSession` is edited by both specs and read by the PIN funnel

`getSession` (`convex/auth/public.ts:23`) is consumed by `verifyManagerPinOrThrow` (`verifyPin.ts:106`) and the whole booth FE. Spec-1 Task 3 adds `outlet_id`/`outlet_label` to its projection; owner-auth WS6 adds `kind` + owner role. That's a triple-edit on one projection across two specs.

Verify the consumers survive owner/cockpit rows: `verifyManagerPinOrThrow` reads `session.staff._id` then re-checks `role !== "manager"` → safely throws `NOT_MANAGER` for an owner (good, no leak). The booth `RootLayout`/`useSession` gate must reject a `kind:"cockpit"` session on booth routes (WS6 covers this).

**Recommendation:** Plan task enumerates **every `getSession` consumer** and the `SessionState` union change (`kind: "booth" | "cockpit"`), and sequences the projection edit on top of Spec-1's. Keep the existing return shape additive (don't reorder/rename `staff`, `deviceId`, `startedAt`).

### Improvement I5: pick a free cron slot for `owner-auth-housekeeping`

WS1 step 4 adds a daily TTL-purge cron "mirror `api-housekeeping`." The current pre-dawn UTC slots are taken: 19:00 (`stock-recon` + `api-housekeeping`), 20:00/20:05 (telegram purges), 20:30 (`settlement-sync`) — see `convex/crons.ts`.

**Recommendation:** Schedule `owner-auth-housekeeping` at a free minute (e.g. 20:10 UTC / 03:10 WIB). Purge expired/consumed `owner_auth_otp` (`by_expires`) + redeemed/expired `owner_auth_bindings` (`by_expires`). Minor, but name the slot in the plan so it's not discovered at deploy.

---

## 4. Refinements (Optional)

- **Q5 is partially auto-resolved by Spec-1.** Spec-1 drops `by_device_active` and replaces it with `by_outlet_device_active` (leads with `outlet_id`). A cockpit session has no `outlet_id`, so it can't appear in that scoped scan at all — boothState derivation is structurally blind to cockpit rows. The residual risk is the retained `by_staff_active` index; since owner is a distinct staff record (Q3), there's no staff overlap. Still, document the `kind === "booth"` filter on any `by_staff_active`/device-active reader that derives shift state (cheap defense).
- **`consumed_at`/`redeemed_at` union-null shape** matches the codebase convention (`staff_sessions.ended_at`) — good, keep it.
- Consider asserting `chatType === "private"` on OTP *send* as well as on bind (defense-in-depth): a `telegram_user_id` should only ever be a private chat id, but assert it.

---

## 5. Duplication Analysis

### Existing code to leverage (spec already cites most — confirmed present)
| Code | Location | How to use |
|------|----------|------------|
| `mintUrlSafeToken(32)` | `convex/lib/tokens.ts:53` | bind + remember-device tokens (V8-safe, CSPRNG) ✅ |
| `chatIdOverride` send path | `convex/telegram/send.ts:166,177` | DM routing for `owner_otp` ✅ (the spec correctly found this) |
| `verifyPinOrThrow` / argon2 funnel | `convex/auth/verifyPin.ts:24` | quick-PIN verify (own isolated counter, not pos_auth_attempts) |
| `withIdempotency` dual-call authCheck | `convex/idempotency/internal.ts` | request/verify/bind mutations |
| `_getLockState_internal` shape | `convex/auth/internal.ts` | model the owner OTP throttle on it (separate table) |
| `MessageContext.text` | `convex/telegram/commands.ts:19` | token re-parse after C1's matcher fix |

### Potential duplication risks
- The cockpit session helpers (`requireCockpitSession`, `touchCockpitSession`, `logoutCockpit`) parallel the booth `requireSession`/`logout`. Keep them in `auth/sessions.ts` next to the booth helpers (one revoke point — ADR-052 Decision A), not a new module.

## 6. Phase / Wave Accuracy

| Workstream | Assessment | Notes |
|-----------|------------|-------|
| WS1 Schema | Needs adjustment | C2 (keep `outlet_id` optional), I2 (fence exclusion), I5 (cron slot) |
| WS2 `/start` binding | **Needs rework** | C1 (matcher) is a hard blocker; I1 (issuance auth) |
| WS3 OTP req/verify | Needs adjustment | C3 (log leak), C4 (counter), I3 (role for audit) |
| WS4 Cockpit session helpers | Needs adjustment | C5 (guard order, blocked-on-Spec-1) |
| WS5 Remember-device quick-PIN | Good | isolated lockout counter (per C4) |
| WS6 FE login + context | Good | I4 (getSession consumers); e2e deferred to Spec 3 harness is reasonable |

**Ordering:** WS1 → WS2/WS3 (parallel after schema) → WS4 → WS5 → WS6. **Blocked-on-Spec-1** gates: C2 (schema field), C5 (`requireSession`), I2 (fence), I4 (`getSession`), and the `owner` role itself + `staff_outlet_access` bypass. The plan must layer cleanly on the Spec-1 plan and annotate each of these.

## 7. Specialist Agent Recommendations

| Workstream | Recommended Agent | Rationale |
|-----------|-------------------|-----------|
| WS1/WS3/WS4 (backend) | `convex-expert` | schema threading, internal/action split, argon2-in-action |
| WS2 (Telegram) | `convex-expert` | webhook command-matcher change + handler |
| WS6 (FE) | `frontend-integrator` / `ui-component-builder` | `/cockpit/login` route + session context |
| Pre-merge | `code-reviewer` + `/triple-review` → `/simplify xhigh` | repo standard close-out |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `feat/v2.0-owner-auth-plane` (spec header) |
| Branch naming follows convention | ✅ |
| Merge strategy | ✅ squash-PR (repo convention) |
| Commit checkpoints | ⚠️ to be defined in the plan (one per workstream/task) |
| Pre-push `typecheck`/`lint`/`vitest` | ⚠️ plan must spell out the full gate per task |
| Rollback | ✅ spec §Rollback — all additive/optional |
| Deployment order | ⚠️ must sequence **after** Spec-1 execution; `kind`/owner tables are inert until cockpit routes ship |
| Migration safety | ✅ no destructive migration; owner promotion is a one-time PIN-gated op |

## 9. Documentation Checkpoints

| Item | Docs to update |
|------|----------------|
| New tables/fields | `docs/SCHEMA.md` (owner_auth_otp, owner_auth_bindings, staff.telegram_user_id, staff_sessions.kind/last_active_at) |
| New audit verbs | `docs/SCHEMA.md` (owner.bind_link_issued, owner.telegram_bound, owner.otp_requested, owner.otp_failed, owner.login, owner.logout, owner.device_remembered) |
| New business rule | `CLAUDE.md` (OTP-authorises-MANAGE third leg; cockpit vs booth session planes; `owner_otp` is the one DM-routed template kind) |
| ADR status | ADR-052 Proposed → Accepted on merge |
| Env var | `TELEGRAM_BOT_USERNAME` (dev + prod); document in RUNBOOK-telegram |
| CHANGELOG | entry on merge |

## 10. Testing Plan Assessment

**Verdict: Adequate** (spec carries a Tests line per workstream). For the plan gate, each must become TDD steps. **Must-add tests** beyond what's listed:

| # | Missing test | Why it matters |
|---|--------------|----------------|
| 1 | matcher: `/start <token>`, bare `/start`, `/start@Bot <token>`; other commands stay strict | C1 — proves the binding flow is reachable without loosening other commands |
| 2 | `owner_otp` send writes NO 6-digit code into `telegram_log` | C3 — secret-in-logs regression guard |
| 3 | OTP-request flood does NOT increment `pos_auth_attempts` (booth login still unlocked) | C4 / SEC-07 isolation |
| 4 | `requireSession` on a `kind:"cockpit"` session throws `NOT_BOOTH_SESSION` (not `SESSION_NO_OUTLET`) | C5 — guard order |
| 5 | cockpit session inserts with NO `outlet_id` succeed against the schema | C2 — proves the field stayed optional |

## 11. Edge Cases to Address

- [ ] Group-chat `/start <token>` rejected (OTP never lands in a group) — spec covers; keep.
- [ ] Duplicate `telegram_user_id` (two staff binding one account) rejected — spec covers; keep.
- [ ] Owner with no `telegram_user_id` → generic `{ok:true}` (no oracle) — spec covers; keep.
- [ ] OTP `device_id` mismatch (request on browser A, verify on browser B) — spec binds verify to request `device_id`; assert it.
- [ ] Expired/consumed challenge on verify → generic `OTP_INVALID`.
- [ ] Idempotency distinct keys: `verifyOwnerOtp` action key ≠ `_cockpitLoginCommit_internal` mutation key (`:commit` suffix) — spec covers (MEMORY: idempotency shared-key collision); keep.
- [ ] First owner cutover sequence (promote → issue bind → `/start` → first OTP) documented in runbook.

## 12. Open Questions — surfaced for the user (recommended resolutions)

The spec carries 5 inline open questions. Recommended resolutions (confirm or override):

- **Q1 — identifier at login:** use `staff.code` (e.g. `S-0001`). Already unique + external-stable (API uses it); no new field/index. ✅ Recommend accept.
- **Q2 — Telegram-account-loss recovery:** admin-issued manager-PIN re-bind (overwrites `telegram_user_id`) + remembered-device quick-PIN as same-device fallback. Full self-serve recovery deferred. ✅ Recommend accept (ties to I1).
- **Q3 — does `owner` grant booth/manager powers?** NO for v1 — owner is cockpit-plane only; keeps the planes clean (the whole point of C5's guard). ✅ Recommend accept.
- **Q4 — OTP length/TTL:** 6-digit / 5-min / 5-attempt cap / 3-req-per-15-min. ✅ Recommend accept.
- **Q5 — cockpit sessions in booth device-active queries:** NO; filter `kind === "booth"`. Partially auto-resolved by Spec-1's `by_outlet_device_active` (cockpit has no outlet → invisible to that scan). ✅ Recommend accept + add the explicit filter on `by_staff_active` readers.

## 13. Approval Conditions

**To approve, address (done inline this pass):**
1. C1 — scoped matcher change for `/start <token>` + tests.
2. C2 — keep `staff_sessions.outlet_id` optional; amend Spec-1 Task 12; runtime kind-conditional enforcement.
3. C3 — redact OTP code from `logOutbound`/audit for `owner_otp`.
4. C4 — dedicated OTP/quick-PIN throttle counter, never `pos_auth_attempts`.
5. C5 — `kind` guard ordering in `requireSession`, layered on Spec-1.

**Recommended before implementation:** I1–I5 (all folded into the spec).

**Cross-spec gate:** every blocked-on-Spec-1 item (C2, C5, I2, I4, owner role, access bypass) must be annotated in the plan and sequenced after Spec-1 execution.

---

*Generated by /staffreview*
