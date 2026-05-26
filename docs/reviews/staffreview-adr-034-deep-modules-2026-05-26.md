# Staff Review: ADR-034 — Deep modules with surface APIs as architectural blueprint

**Date:** 2026-05-26
**Plan:** `docs/ADR/034-deep-modules-surface-apis.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Sections auto-added — see §0

---

## 0. Plan Structure Additions

ADRs aren't traditional implementation plans, so the structural checklist was mapped to ADR equivalents:

| Required (plan) | Mapped to (ADR) | Status |
|---|---|---|
| Scope / Goal | Context + Decision | ✅ present |
| File Changes | Implementation notes (proposed `convex/` layout) | ✅ present |
| Implementation Phases | (intentionally absent — ADRs decide, plans implement) | ⚠️ rollout reference missing — see Critical #4 |
| Testing | (architecture invariants need verification mechanism) | ❌ missing — see Critical #2 |
| Success Criteria | Implicit ("modules don't leak", "API contract stable") | ⚠️ not stated explicitly |
| Rollback / Deployment | "Reversal cost" subsection in Consequences | ✅ present |

Sections silently added in this review: **architecture verification** (Critical #2), **implementation rollout commitment** (Critical #4), **explicit acceptance criteria** for moving ADR from Proposed → Accepted (Improvement #6).

---

## 1. Summary

**Overall Assessment:** **Revise** (substantive — not a rewrite; close 5 critical gaps and accept)

The architectural philosophy is sound and the structure is a clean fit for POS's role as a feeder to Frollie Pro. The three-layer model (internal modules / external API / private data) directly addresses the schema-coupling failure mode that previous design rounds were heading toward. However, the ADR ships **5 critical gaps** that would let the architecture rot in practice: a broken cross-ref, an incorrect "stable identifier" choice, an underspecified security model, no verification mechanism for module boundaries, and no defined audit-logging pattern across modules. These are all fixable in a single revision pass before this moves from Proposed → Accepted.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|---|---|---|
| 1 | Broken cross-reference to memory file (path doesn't resolve) | Docs | ADR-034 lines 9, 124, 137 |
| 2 | No verification mechanism for the architecture's invariants | Testing / Architecture | ADR-034 §"Consequences" + §"Implementation notes — Module-boundary lint rule" |
| 3 | `staffName` listed as a "stable string identifier" — names change | Logic / API contract | ADR-034 §"Implementation notes — Stable string identifiers" |
| 4 | Bearer-token security model underspecified (storage, comparison, rotation, rate-limiting) | Security | ADR-034 §"Implementation notes — Bearer-token model" + Open Q#4 |
| 5 | Cross-module audit-logging pattern unaddressed (every mutation currently writes `audit_log` directly) | Architecture / Migration | ADR-034 §"Decision — Layer 1" + existing `convex/audit.ts` per CLAUDE.md |

### Issue 1: Broken memory cross-reference

ADR-034 links twice to `../../../memory/convex-deployments.md`. From `docs/ADR/034-...md`, that resolves to `D:\Claude\memory\` — which doesn't exist. The actual memory file lives at `C:\Users\Irfan\.claude\projects\D--Claude-FrolliePOS\memory\convex-deployments.md`, outside the repo entirely.

This isn't a rendering nit — the ADR's "this decision builds on the separate-deployment commitment in [memory]" framing is load-bearing. If readers can't follow the link, the supersession of ADR-000 §1 looks unjustified.

**Recommendation:** Replace the memory reference with **either** (a) an inline paragraph stating "POS runs in its own Convex project (`helpful-grasshopper-46` dev, `savory-zebra-800` prod), separate from `product_master` — see CLAUDE.md §'Convex deployment'", **or** (b) promote the deployment-separation fact into a proper ADR (`ADR-035`?) and cross-link it. Option (a) is cheaper; option (b) is more durable. Pick (a) for v1.

### Issue 2: No verification mechanism for the architecture

The ADR commits to three invariants:
1. Modules talk only through `public.ts` / `internal.ts` (no cross-module `ctx.db` access)
2. Stable string identifiers remain stable across versions
3. External API contract matches `docs/API.md`

But the proposed enforcement is "Pseudo-rule: flag ctx.db.query calls outside the module that owns the table … Until automated, code review enforces it manually." That's not enforcement, that's hope. The Convex codebase will be touched by multiple engineers and AI agents over months — manual code review will let violations through within weeks.

An architecture ADR without verification is aspiration, not architecture. This is the same failure mode as a `.eslintrc` saying "developers should avoid `any`."

**Recommendation:** Commit to concrete verification in this ADR:

- **Module boundary lint:** Hard CI gate (not soft warning — answer Open Q#3). Implementation can be a custom ESLint rule, a `grep` in CI, or a TypeScript convention enforced by separate per-module tsconfigs. Pick one mechanism and name it in the ADR.
- **Stable ID contract tests:** A snapshot test that captures the current API response shape for each endpoint and fails on accidental changes. Updates require explicit acknowledgment (think Vitest `--update-snapshot`).
- **API contract conformance:** Either (a) an OpenAPI/JSON Schema definition checked in, or (b) typed Convex `httpAction` handlers with explicit return types that get serialized + validated. Pick one.

Without these, the philosophy is undefended.

### Issue 3: `staffName` is not a stable identifier

The ADR's "Stable string identifiers" table includes:

```
| `staffName` | display string | auth | ✅ attribution on sales |
```

Names change. People marry, fix typos, rebrand. The ADR itself elsewhere correctly warns against this exact failure ("Renaming them later is a breaking API change"). Including `staffName` contradicts the principle.

What's actually wanted is a **stable opaque identifier** for staff that's separate from their display name.

**Recommendation:** Replace `staffName` with `staffCode` (or `staffId` — a string, not Convex `_id`). Format: `S-NNNN` or similar, allocated at staff creation, immutable for the staff record's lifetime. `staffName` can still appear in API responses as a **mutable display-only field** — but it's not the join key. Add to the schema commitment: `staff` table gets a `code: v.string()` field with `by_code` index.

This also future-proofs against name collisions (two staff named "Sari") which the current `audit_log.actor_id: v.id("staff")` model handles but the proposed API surface wouldn't.

### Issue 4: Bearer-token security model

The ADR's bearer-token section says tokens have `scope`, `permissions`, `issuedAt`, `expiresAt`, `revokedAt`, `createdBy`. It doesn't say:

- **How tokens are stored** (hashed at rest? Plaintext? The existing PIN-auth model uses argon2id per [ADR-004](../ADR/004-pin-hashing-server-side.md) — should bearer tokens follow the same pattern?)
- **How tokens are compared** (must be **constant-time** to prevent timing attacks — `===` is wrong; use `crypto.timingSafeEqual` or equivalent in the Convex action runtime)
- **How tokens are rotated** (Frollie Pro will need a way to roll a token without downtime — overlapping validity windows?)
- **Rate limiting** (Frollie Pro could accidentally DoS POS with a runaway sync loop; not catastrophic for internal use but worth a per-token QPS ceiling)
- **What "permissions: array of endpoint patterns" syntax looks like** (glob? regex? enum? matters because typos in patterns silently grant access)
- **PII exposure rules** (the API will return customer_phone on transactions; is that gated by permission? Frollie Pro probably wants it for delivery; future consumers might not)

Open Q#4 admits "Token issuance UX: bearer tokens are issued by managers via a Convex CLI action … or do we need a minimal manager-dashboard page for it?" — but that's the UX question. The schema/security questions above are *prerequisites* to the UX question.

**Recommendation:** Add an "API authentication model" subsection to the ADR with explicit answers on all six points above. Specifically: tokens hashed with argon2id (reuse ADR-004 pattern), constant-time comparison required (cite the helper), rotation via overlapping 7-day window, per-token rate limit (default: 60 req/min, configurable), permission syntax = explicit endpoint enum (no patterns), PII fields gated by scope (`scope: "frollie_pro_full"` vs `"frollie_pro_aggregate_only"`).

If any of these are deferred to a follow-up ADR, name that ADR explicitly so it's traceable.

### Issue 5: Audit-logging pattern across modules

CLAUDE.md `audit_log` rules say: "every state-changing action emits a `logAudit` row from the mutation." Currently any mutation can call `convex/audit.ts logAudit()` directly. The proposed module-boundary rules say "modules talk to other modules only through their `public.ts` or `internal.ts` exports." These conflict.

If audit becomes a module, every state-changing mutation in `cart/`, `checkout/`, `transactions/`, `inventory/`, `vouchers/`, `auth/`, `approvals/` must call `audit/internal.logAudit()`. That's fine in theory. But:

- **Atomicity**: today `logAudit()` runs in the same mutation context. Under the module split, does it still? Convex mutations are transactional — calling another module's `internalMutation` from inside a mutation runs in the same transaction if the called function is `internalMutation`. The ADR doesn't say. Get this right or you risk an audit row written without the state change (or vice versa).
- **Performance**: cross-module function call vs direct table insert — same cost in practice (both are JS calls), but worth confirming.
- **Existing code**: the current `convex/audit.ts` already exposes `logAudit()`. Moving it to `convex/audit/internal.ts` changes the import path everywhere it's called. This is the audit-pattern migration the ADR is silent on.

**Recommendation:** Add a subsection "Cross-module mutation patterns" in the ADR with:
1. Explicit endorsement: state-changing mutations call `audit/internal.logAudit()`; this runs in the same Convex mutation transaction; failure of the audit write rolls the entire mutation back (the existing guarantee per [ADR-007](../ADR/007-audit-log-append-only.md) survives).
2. The voucher-redemption pattern: `transactions/public.checkoutSale` calls `vouchers/internal.redeem`. Cross-module call is normal and expected.
3. Migration step: `convex/audit.ts` → `convex/audit/internal.ts`. Existing call sites update import path. No behavior change.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|---|---|---|
| 1 | Document cross-module reactive subscription pattern | M | L |
| 2 | Commit to implementation rollout (which planning phase / when) | H | L |
| 3 | Show concrete `convex/schema.ts` composition example | M | L |
| 4 | Tighten or justify the 90-day API deprecation window | L | L |
| 5 | Spell out the inbound vs outbound `httpAction` distinction (Xendit webhook is NOT an external API consumer) | M | L |
| 6 | Add explicit "acceptance criteria for this ADR" — what must be true for Status to flip to Accepted | M | L |
| 7 | Add `docs/ADR/README.md` index update + new group classification | L | L |

### Improvement 1: Cross-module reactive subscriptions

POS frontend will subscribe to data owned by multiple modules (the cart screen needs catalog data + cart state + inventory levels + voucher validation). The ADR doesn't say whether that's done via direct subscription to each module's `public.ts` queries, or via an aggregating module. Default answer (direct subscription, Convex handles the reactive merge) is fine — but should be stated explicitly.

**Recommendation:** Add one sentence to "Decision — Layer 1": "POS frontend subscribes directly to multiple modules' `public.ts` queries; Convex's reactive query engine handles the merge. Aggregator modules are an anti-pattern — they centralize subscription state for no benefit."

### Improvement 2: Implementation rollout commitment

The ADR decides the philosophy but doesn't say when or how the existing `convex/` directory restructures. CLAUDE.md lists 14 designed Convex files, all flat. Open Q#5 acknowledges this exists but defers it.

If accepting this ADR doesn't trigger any code action, the philosophy will drift — new code will be added to the existing flat structure because there's no module to put it in yet.

**Recommendation:** Commit in the ADR to: "Restructure rolled out in a follow-up planning phase (`v0.6-architecture-restructure` or equivalent) before any new module-touching feature lands. Existing files (`convex/auth.ts`, `convex/schema.ts`, `convex/xendit/`, `telegram_log` POC) move first, then the missing modules (cart, transactions, etc.) get scaffolded in their final locations." Pick the answer to Open Q#5 (forward-only vs retroactive) — my recommendation: retroactive, since the codebase is small.

### Improvement 3: Concrete schema composition example

The ADR says `convex/schema.ts` "composes module schemas into one `defineSchema()`." Convex supports this but the syntax matters (spread? merge? import-and-call?). Without an example, the first implementer has to figure it out and might pick a fragile pattern.

**Recommendation:** Add a 5-line code block showing the actual pattern. Something like:

```ts
// convex/schema.ts
import { defineSchema } from "convex/server";
import { catalogTables } from "./catalog/schema";
import { cartTables } from "./cart/schema";
// ... etc.

export default defineSchema({
  ...catalogTables,
  ...cartTables,
  // ...
});
```

Verify it actually works in Convex before the ADR lands (a 5-min `npx convex dev` check).

### Improvement 4: API deprecation window

"≥ 90 days after `/v2/` is GA" with RFC 8594 `Sunset` headers is enterprise-grade ceremony for an internal API with one consumer. Either:

- **Tighten:** "≥ 14 days, agreed with consumer in writing" — pragmatic for internal use.
- **Justify:** state explicitly that the 90-day window is forward-looking for future external consumers (and POS is small enough that the cost is negligible).

Either is fine; "90 days because that's what enterprises do" is the rationale to avoid.

### Improvement 5: Inbound vs outbound `httpAction`

POS already has `convex/xendit/webhook.ts` as an `httpAction` — that's an **inbound** webhook from Xendit, not part of the external API surface for Frollie Pro. The ADR's "all `httpAction`s under `convex/api/v1/`" rule conflicts with the existing Xendit webhook location.

**Recommendation:** Clarify in the ADR: `convex/api/v1/` is for **outbound** APIs (POS as data provider). **Inbound** webhooks (Xendit, future Telegram graduations, etc.) stay in their domain modules (`convex/checkout/webhook.ts`, etc.). Both use `httpAction` as the Convex primitive but they're different surface categories.

### Improvement 6: Acceptance criteria

Status is currently "Proposed." For Status to flip to "Accepted," what must be true? The ADR doesn't say. Without explicit criteria, "Accepted" becomes a vibe.

**Recommendation:** Add a section near the end:

> ### Acceptance criteria
> This ADR moves from Proposed to Accepted when:
> 1. All Critical issues from `staffreview-adr-034-...md` are resolved (memory link, staffCode, bearer-token spec, verification mechanism, audit-pattern).
> 2. Open Questions #1-5 are answered (decisions in-line, not deferred).
> 3. A follow-up planning phase for the restructure exists in `docs/PROGRESS.md` or the ROADMAP.
> 4. `docs/ADR/README.md` index updated.

### Improvement 7: README index update

`docs/ADR/README.md` has 33 ADRs indexed across 8 groups (Auth, Ops, Pay, Stock, Receipts, Sync, WA, Time). ADR-034 is Group "Architecture (foundational)" which doesn't exist. Either:

- **Add a new group** to README.md: "Arch" or "Architecture".
- **Use existing group**: closest fit is "Ops" but that's a stretch.

**Recommendation:** Add new group "Arch" — this won't be the only foundational architecture ADR over the project's life. Document in README.md groups section. Update index table.

## 4. Refinements (Optional)

- **Open Q#1** (absorb into ADR-000): keep standalone for now. ADR-000 is already long. Consolidate after the pattern is proven (~3 months post-implementation). **My pick: keep standalone.**
- **Open Q#2** (API.md naming): `docs/PUBLIC_API.md` is clearer than `docs/API.md` — and avoids confusion with the existing `docs/API_REFERENCE.md` (which is Convex function reference, internal-facing). **My pick: `docs/PUBLIC_API.md`.**
- **Open Q#5** (existing code retroactive): forward-only leaves a mixed-convention codebase that will confuse new engineers. Retroactive is ~1 day per Improvement #2. **My pick: retroactive.**
- The "Easier / Harder / Reversal cost" consequence breakdown matches existing ADR style — good.
- "Implementation notes" subsection is heavier than the canonical ADR template (per `docs/ADR/README.md` template). Justified for a foundational ADR but worth noting consistency cost.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|---|---|---|
| `convex/auth.ts` | existing | Move → `convex/auth/internal.ts` + `convex/auth/public.ts` (login/logout split). No logic change. |
| `convex/xendit/webhook.ts` | existing | Stay where it is (inbound webhook, not external API — see Improvement #5). |
| `convex/audit.ts logAudit()` | existing | Move → `convex/audit/internal.ts`. Call sites update import path. See Critical #5. |
| `argon2id` hashing pattern (ADR-004) | existing | Reuse for bearer-token hashing per Critical #4 recommendation. |
| `pos_idempotency` table | existing | Pattern carries through for external API `Idempotency-Key` header — proposed in ADR but worth explicit pointer. |
| Convex `internalQuery` / `internalMutation` | Convex primitive | Native enforcement of internal-vs-public — ADR uses this correctly. |

### Potential duplication risks

- Bearer-token storage scheme + the `_internalTokens` table could end up parallel to `pos_idempotency` and `staff_sessions` if not carefully designed. All three are "stored secret with TTL." Worth a shared helper.
- `audit_log` `source` enum already has `"system"` — bearer-token-driven API calls need an audit `source`. Add `"api_consumer"` or `"frollie_pro_sync"` to the enum? Decision needed.

## 6. Phase / Wave Accuracy

ADRs don't have phases. The **implementation** does, and it doesn't exist yet — see Improvement #2. The implementation will need at least:

1. Migrate existing `convex/auth.ts`, `convex/audit.ts`, `convex/xendit/`, `telegram_log` POC into the new module structure (1 day, mechanical).
2. Add module-boundary lint rule + CI gate (Critical #2).
3. Scaffold empty modules for cart/checkout/transactions/inventory/vouchers/approvals so future features land in the right place.
4. Implement `convex/api/v1/_auth.ts` bearer-token middleware (Critical #4 prereq).
5. Implement first external endpoint (suggest: `GET /api/v1/transactions` for testability).
6. Snapshot contract tests for the first endpoint.

Each is naturally one commit. Sequenced as listed (lint before refactor risks blocking the refactor; refactor before lint risks the refactor itself violating the rule and being undetectable).

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|---|---|---|
| Restructure migration | `convex-expert` | Project-specific Convex agent; knows the schema patterns + the module-boundary semantics in Convex. |
| Lint rule implementation | `general-purpose` | Could be a custom ESLint plugin or a CI grep — no specialized agent fits cleanly. |
| Bearer-token + auth middleware | `convex-expert` | Convex action runtime, argon2id pattern, security-sensitive. Same agent that owns POS auth. |
| API contract tests | `convex-expert` | Convex `httpAction` testing patterns. |
| ADR revision (closing Critical issues) | (no agent — Lucas + me) | Architectural commitment, not code work. |

(All agents listed are confirmed present in the project's agent roster.)

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|---|---|
| Feature branch specified | ❌ N/A — ADR is a doc commit, not a feature branch |
| Branch naming follows convention | ⚠️ for the follow-up restructure phase, follow GSD phase convention (`phase/vX.Y-architecture-restructure`) |
| Merge strategy documented | N/A for ADR |

### Commit checkpoints (for the ADR itself)

1. Initial ADR draft (this commit) → `docs(adr): add ADR-034 deep modules and surface APIs as architectural blueprint`
2. After this staffreview's Critical fixes → `docs(adr): revise ADR-034 — verification, security, audit pattern (closes staffreview findings)`
3. Acceptance → `docs(adr): accept ADR-034`

### Pre-push verification

- [x] Markdown lint (if any)
- [x] Cross-reference validity (Critical #1 — broken link must be fixed)
- [ ] No code in this commit, so no build/typecheck

### CI/CD & rollback

| Concern | Status |
|---|---|
| Rollback strategy | ✅ documented (Reversal cost section) |
| Deployment order | N/A — doc-only commit |
| Data backup needed | N/A |
| Migration safety | N/A for ADR; **the follow-up restructure phase will need it** |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|---|---|
| ADR-034 lands | `docs/ADR/README.md` index + groups (Improvement #7) |
| ADR-034 accepted | `CLAUDE.md` "Stack" section (relax mirror directive per ADR text), `docs/CHANGELOG.md` |
| Follow-up restructure phase | `docs/SCHEMA.md` reframe ("POS-internal"), new `docs/PUBLIC_API.md` (per Refinement on Open Q#2), `CLAUDE.md` file-locations section (new module paths) |

### CHANGELOG draft

```markdown
## 2026-05-26

### Architecture
- ADR-034: Adopt "deep modules with surface APIs" as POS architectural blueprint. Supersedes ADR-000 §1 (shared Convex project). External integration with Frollie Pro happens via versioned HTTP API surface, not schema mirroring. Follow-up restructure planned in next phase.
```

## 10. Testing Plan Assessment

**Verdict:** **Missing** — ADR has no test or verification plan for its own invariants.

### Planned tests

| Layer | What | Test type | Status |
|---|---|---|---|
| Architecture | Module boundary discipline | Lint rule + CI gate | ❌ pseudo-code only (Critical #2) |
| API | Response shape stability | Snapshot tests | ❌ not planned (Critical #2) |
| API | Bearer-token auth | Integration tests | ❌ not planned (Critical #4) |
| API | Stable string ID invariance | Snapshot tests | ❌ not planned (Critical #2 + #3) |
| Schema | Composition pattern works in Convex | Manual `npx convex dev` | ⚠️ implied, not committed (Improvement #3) |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|---|---|---|
| 1 | Module-boundary lint | Without it, the architecture rots silently | Custom ESLint rule or `grep` check in CI; hard gate per Open Q#3 |
| 2 | API response snapshot | Without it, accidental shape changes break Frollie Pro silently | Vitest snapshots per endpoint, with explicit update gesture |
| 3 | Bearer-token auth path | Without it, the security model is unverified | Unit tests for valid/expired/revoked/wrong-scope token paths |
| 4 | Schema composition smoke | Without it, the proposed file layout might not actually work in Convex | `npx convex dev --once` in CI after restructure |

### Test execution checkpoints

1. Lint rule lands first (else the restructure can't be checked).
2. Restructure happens (each module move = one commit, lint passes after each).
3. First API endpoint + snapshot test land together.
4. Bearer-token auth lands with full test coverage before first external token is issued.

### Regression risk

- `audit_log` writes change call sites — existing `convex/audit.ts` consumers need updated imports. Test: every existing mutation that wrote audit rows still writes them after the move.
- `convex/xendit/webhook.ts` stays in place (per Improvement #5) — verify no accidental move during restructure breaks the Xendit webhook URL.

## 11. Edge Cases to Address

- [ ] What happens when Frollie Pro calls `/api/v1/transactions` mid-deploy of POS? (Convex deploys are atomic at the function level; old requests complete on old code. Worth confirming.)
- [ ] Bearer token revoked mid-request — what does the in-flight `httpAction` see? Should the auth middleware re-check on every request (yes, but say so).
- [ ] Pagination cursor invalidation — if POS prunes a transaction and Frollie Pro is mid-paginate with a cursor pointing past the pruned row, what happens?
- [ ] Cross-module mutation that fails partway — does the audit row roll back too? (See Critical #5 — must be yes; spell it out.)
- [ ] What if two modules want to subscribe to overlapping data atomically? (Catalog updates + inventory updates that affect the same product — Convex reactivity handles this if both are queries on the same underlying table; spell it out.)
- [ ] What's the contract when a stable string ID's underlying record is deleted? (e.g., `productCode: "DUBAI_8PC"` discontinued — does the API return the record marked inactive, or omit it, or 404?)

## 12. Approval Conditions

**To accept this ADR, address:**
1. **Critical #1**: Fix broken memory link (inline the deployment facts, ~3 lines).
2. **Critical #2**: Commit to concrete verification mechanisms — module-boundary lint as hard CI gate, API snapshot tests, schema-composition smoke.
3. **Critical #3**: Replace `staffName` with `staffCode` as the stable identifier; add `code: v.string()` to the staff table commitment.
4. **Critical #4**: Add the "API authentication model" subsection with explicit answers on storage (argon2id), comparison (constant-time), rotation (overlapping window), rate-limiting (per-token QPS), permission syntax (enum, no patterns), PII scope gating.
5. **Critical #5**: Document the cross-module audit-logging pattern + the call-in-same-transaction guarantee + the `convex/audit.ts` → `convex/audit/internal.ts` migration step.

**Recommended before implementation:**
1. Improvements #1-#7 (cross-module subscriptions, rollout commitment, schema composition example, deprecation window justification, inbound/outbound httpAction split, acceptance criteria, README index update).
2. Pick answers to Open Questions #1-5 in-line rather than deferring.

**Once Status flips to Accepted:**
1. Create the follow-up planning phase (suggested: `v0.6-architecture-restructure`).
2. Update `docs/ADR/README.md`, `CLAUDE.md`, `docs/CHANGELOG.md`.

---

*Generated by /staffreview*
