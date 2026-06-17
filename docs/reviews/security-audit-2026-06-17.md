# Security Audit & Fix Spec — Frollie POS

> **Date:** 2026-06-17 · **Method:** 10-reviewer swarm (one per trust boundary) + adversarial verification of every finding + completeness critic. 16 raw findings → **14 confirmed** after 2 were refuted as false positives during verification.
> **Scope:** entire `convex/` backend + `src/` frontend. **Outcome of this doc:** a prioritised, code-level remediation spec. No code changed yet.

## Severity summary

| # | ID | Severity | Title | Primary file |
|---|----|----------|-------|--------------|
| 1 | SEC-01 | 🔴 High | PIN lockout fully bypassable by reusing one `idempotencyKey` across wrong-PIN guesses | `convex/auth/verifyPin.ts` |
| 2 | SEC-02 | 🔴 High | `commitCart` accepts negative / zero / fractional line qty → inverts stock movements, negative totals | `convex/transactions/public.ts` |
| 3 | SEC-03 | 🔴 High | Default manager bootstrap PIN `1111` shipped to production | `convex/seed/actions.ts` |
| 4 | SEC-04 | 🟠 Medium | Device setup-code activation unthrottled → 6-digit code brute-forceable | `convex/staff/public.ts` |
| 5 | SEC-05 | 🟠 Medium | `transactions.getById` has no session/role check → IDOR + `receipt_token` capability leak | `convex/transactions/public.ts` |
| 6 | SEC-06 | 🟠 Medium | `getCurrentInvoice` (payment instrument) also session-less | `convex/payments/public.ts` |
| 7 | SEC-07 | 🟠 Medium | Telegram approve PIN-verify pollutes booth lockout table → off-booth DoS-lock of a manager | `convex/approvals/actions.ts` |
| 8 | SEC-08 | 🟡 Low | Webhook confirms payment without amount/currency **gate** (honor-and-flag only) | `convex/transactions/internal.ts` |
| 9 | SEC-09 | 🟡 Low | `getByToken` returns full approval payload for **expired** tokens (VIEW leak past TTL) | `convex/approvals/public.ts` |
| 10 | SEC-10 | 🟡 Low | `getChatIdByRole` env fallback can ACT-gate against a stale chat | `convex/telegram/chatRegistry/internal.ts` |
| 11 | SEC-11 | 🟡 Low | Raw single-use approval token persisted to IndexedDB for 24h via idempotency intent | `src/routes/approve/index.tsx` |
| 12 | SEC-12 | 🟡 Low | Voucher active/expiry/min-cart **not** re-validated at payment confirm | `convex/transactions/internal.ts` |
| 13 | SEC-13 | ⚪ Info | Stale "KNOWN SECURITY (deferred)" comment now contradicts shipped cap | `convex/approvals/actions.ts` |
| 14 | SEC-14 | ⚪ Info | `/activatepos` gated on chat-membership, not per-sender identity (by design) | `convex/telegram/activatePos.ts` |

### Cross-cutting root cause
**SEC-01 and SEC-07 are the same anti-pattern**: a security counter (`pos_auth_attempts`) is driven by a path keyed on a client-controllable idempotency key, and SEC-04 is the same control (rate-limit) simply absent. Idempotency = *at-most-once*; rate-limiting = *count-every-attempt*. They have opposite semantics and must never share a key. Fixing SEC-01 cleanly (a `staff_id`-keyed, non-idempotent counter + a shared `verifyPinOrThrow` pre-check) structurally closes SEC-07 too.

---

## Remediation sequencing

**P0 — do before next prod use** (auth/money integrity, low effort):
- **SEC-03** — rotate live prod PIN off `1111` *today* (operational), then land the env-PIN + must-rotate bootstrap fix.
- **SEC-01** — decouple lockout counter from `idempotencyKey`; add regression test. Fixes the brute-force hole.
- **SEC-02** — one-line `Number.isInteger(qty) && qty > 0` guard at the `commitCart` boundary; mirrors existing spoilage/refund guards.

**P1 — same PR series** (IDOR / DoS / perimeter):
- **SEC-05 + SEC-06** — gate `getById` + `getCurrentInvoice` on session + day-scope and stop spreading the raw Doc (`receipt_token`). Shared fix.
- **SEC-07** — split the failed-attempt recorder so the Telegram approve path audits without polluting the booth lockout counter (falls out of SEC-01 if done as a shared funnel).
- **SEC-04** — add an application-layer throttle table for `activateDevice`; optionally widen code to 8 digits.

**P2 — hardening / defense-in-depth** (low severity, cheap):
- SEC-09 (`if (eff === "expired") return null`), SEC-11 (intent = `requestId` not raw token + clear on success), SEC-12 (re-validate voucher at confirm, honor-and-flag), SEC-10 (`allowEnvFallback:false` on ACT gates), SEC-08 (CI assertion locking `DYNAMIC`/`is_closed`), SEC-13 (rewrite stale comment), SEC-14 (document the trust boundary).

---

## Detailed findings & fixes

### 🔴 SEC-01 — PIN lockout bypass via reused idempotencyKey
**Files:** `convex/auth/verifyPin.ts:46-57`, `convex/auth/internal.ts:169-231` (`_recordFailedAttempt_internal`), `convex/auth/actions.ts:54-112` (`loginWithPin`).

**What:** The 3-fail/60s lockout (ADR-002) is recorded by `_recordFailedAttempt_internal`, wrapped in `withIdempotency` under `${idempotencyKey}:failed`. On a cache hit the handler body never runs, so `fail_count` only increments on the *first* call per base key. The base-key cache is written **only** on successful login (`_loginCommit_internal`), so failed attempts never populate it. Holding `idempotencyKey` constant across different wrong PINs freezes `fail_count` at 1 → account never locks, `notifyStaffLockout` never fires. `idempotencyKey` is a plain `v.string()` action arg fully controlled by any client that can reach the deployment URL. Same defect reaches `changePin` and `verifyManagerPinOrThrow` (→ `createStaff`, `resetStaffPin`). PIN space = 10,000.

**Exploit:** Call `api.auth.actions.loginWithPin` directly with a known `staffId`, `idempotencyKey="x"` constant, iterate `pin="0000".."9999"`. Unthrottled; a hit returns a live (possibly manager) session. Defeats lockout, cooldown, and the Telegram lockout alert.

**Fix:**
1. Remove the `withIdempotency` wrap from `_recordFailedAttempt_internal`; increment `fail_count` unconditionally keyed only on `staff_id`. (Over-counting by one on a rare action crash is *fail-safe* — locks slightly sooner; the current under-count is *fail-open*.)
2. If exactly-once is still wanted, key dedup on a server-derived value the client cannot hold constant across guesses (e.g. `${staffId}:${Math.floor(now/window)}`), never a raw client token.
3. Apply via the shared `verifyPinOrThrow` funnel so `loginWithPin`, `changePin`, `createStaff`, `resetStaffPin` are all covered.
4. Keep FE `pinReset` key rotation as non-load-bearing defense-in-depth.

**Test:** call `loginWithPin` 3× with the **same** `idempotencyKey` and different wrong PINs; assert the 3rd throws `LOCKED_OUT`.

---

### 🔴 SEC-02 — commitCart accepts negative/zero/fractional quantities
**Files:** `convex/transactions/public.ts:143-300` (qty consumed at 204-217, 248-254; only guard is `EMPTY_CART` at 181). Inversion downstream: `convex/transactions/internal.ts:217` → `convex/inventory/internal.ts:72-81` (`qty: -line.qty`).

**What:** `lines` is `v.array({ productId, qty: v.number() })` with no positive-integer check. `v.number()` accepts negatives, zero, floats. A negative qty yields a negative `line_subtotal`/`total` and — on confirmation — a **positive** stock movement (`-(-qty)`), i.e. a "sale" that *credits* inventory. A mixed cart (`[{A, qty:100},{B, qty:-90}]`) keeps `total` positive/payable while fabricating 90 free units of SKU B, defeating the `by_line_and_sku` decrement model. Fractional qty also breaks ADR-015 integer-rupiah. Auth on this path is staff-session only — any of the 2-3 staff (or a replayed session) can do it.

**Fix:** Add a per-line guard right after the `EMPTY_CART` check, mirroring the canonical guard already in `_recordSpoilage_internal` / refund path:
```ts
for (const { qty } of args.lines) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("QTY_INVALID");
}
```
Optionally cap a sane upper bound (e.g. `qty <= 1000`).

**Test:** `commitCart` throws `QTY_INVALID` for qty `-1`, `0`, `1.5`; a mixed positive/negative cart is rejected before any `pos_transactions`/`pos_stock_movements` row is written.

---

### 🔴 SEC-03 — Default manager PIN 1111 in production bootstrap
**Files:** `convex/seed/actions.ts:74-85` (PIN literal line 78), commit at `convex/seed/internal.ts:290-307`.

**What:** The prod-runnable `bootstrap` internalAction seeds the first manager (Lucas, S-0001) with hardcoded PIN `"1111"`. Unlike `reset` it is **not** `assertNotProd`-guarded ("bootstrapping prod is the intended use"). No forced rotation exists, so the account can stay on `1111` indefinitely. Manager PIN authorizes the highest-privilege actions (refunds, manual payment override, voids, discounts, stock adjustments, spoilage, settings, PIN resets). Memory note `prod-cutover-2026-06-03` lists "change PIN 1111" as still-outstanding → live prod is on the default. The constant is in the public repo.

**Exploit:** Anyone who handles the shared booth tablet enters `1111` at any manager-PIN gate → mark txns paid with no money received, refund to self, reset other managers' PINs — all attributed to Lucas.

**Fix:**
1. **Operational, now:** rotate the live prod manager PIN off `1111`.
2. **Code:** require a manager PIN via env var in `bootstrap`; throw if absent (no hardcoded default).
3. Add a `must_change_pin` flag on the bootstrap row and block manager actions until rotated (force first-login rotation).

**Test:** `bootstrap` throws when the env PIN is unset; seeded manager has `must_change_pin=true`; manager-PIN gates reject until rotated.

---

### 🟠 SEC-04 — Unthrottled device activation (6-digit brute force)
**Files:** `convex/staff/public.ts:128-244` (`activateDevice`, no-op authCheck at 241), `convex/staff/internal.ts:12-18` (`generateSecureSetupCode` → 6-digit space ~900k), `convex/auth/schema.ts:54-74`.

**What:** `activateDevice` is the pre-auth perimeter (foundations §6). It validates only `/^\d{6}$/`, does a direct `by_code` lookup, registers the caller's device on match — with **no** per-device/per-IP/global attempt counter and no lockout. `pos_auth_attempts` is keyed by `staff_id` and only covers PIN login, so it gives zero protection here. While a manager-issued code is live (1h TTL), an attacker scripts `activateDevice` across the 6-digit space (~450k expected guesses) to register a rogue device — a foothold to then attack PINs.

**Fix:**
1. Add `pos_device_activation_attempts` keyed by `device_id` (+ a global counter row): `fail_count`, `locked_until`, `last_attempt_at`. In `activateDevice`, reject if `locked_until > now`; increment on the invalid-code branch; cooldown after N misses (e.g. 5 → 60s, escalating); reset on success.
2. Add a global rolling-window ceiling so an attacker spraying fabricated `deviceId`s can't sidestep the per-device cap; on a failure burst, invalidate outstanding `pending_device_setups` (force manager re-issue).
3. Defense-in-depth: widen `generateSecureSetupCode` to 8 digits and/or shorten TTL below 1h.
4. Audit lockout events (mirror the PIN-lockout audit pattern).

---

### 🟠 SEC-05 — `transactions.getById`: IDOR + receipt_token capability leak
**Files:** `convex/transactions/public.ts:47-61`. Consumed by `src/hooks/useXenditPayment.ts:31-36`, `src/routes/sale/charge-success.tsx`.

**What:** `getById` is a public query taking only `{ txnId }`: no session, no role, no day-scope. It `return { ...txn, lines }` — spreading the raw Doc including `receipt_token` (`schema.ts:8`), the ADR-021 single-use capability for `/r/<token>`. Every sibling read (`getTransactionDetail`, `refunds.listForTransaction`, `receipts.getReceiptForPrint`) enforces the manager-any-day / staff-today fork **and** strips `receipt_token`; `getById` does neither. This was flagged in a prior staffreview (`docs/reviews/staffreview-feat-v0.3-sale-xendit-2026-05-28.md`, I-4) and never closed.

**Exploit:** A staffer replays a txnId from another day/staff (URLs, history, logs) via `useQuery(getById, {txnId})` → full txn read bypassing same-day scope, plus the leaked `receipt_token` reconstructs `POS_BASE_URL/r/<token>` for an arbitrary sale. (Convex Ids are opaque, so mass-enumeration is impractical — hence Medium not High — but any single leaked/old id breaks the scope.)

**Fix:**
1. Add `sessionId: v.id("staff_sessions")`; resolve via `internal.auth.internal._resolveSessionRole_internal`; return null on invalid session.
2. Non-manager: enforce `wibDayWindow(Date.now())` on `created_at` (mirror `getTransactionDetail:507-516`).
3. **Project** the result to drop `receipt_token` (and `xendit_*`/`confirmed_*`) — return an explicit shape, never `{ ...txn }`.
4. System callers (`payments/actions.ts:42,100`, `transactions/actions.ts:58`) move to a dedicated `internal._getTxnById_internal` returning the full row; the FE-facing `getById` becomes gated + projected.

**Test:** anonymous/other-day caller gets null; returned shape contains no `receipt_token`.

---

### 🟠 SEC-06 — `getCurrentInvoice` payment instrument is session-less
**Files:** `convex/payments/public.ts:9-25`. Consumed alongside SEC-05 in `useXenditPayment.ts:31-36`.

**What:** Same class as SEC-05 — takes only `{ txnId }`, no session/scope, returns the invoice row including `qr_string` / `va_number` to any caller holding a txnId.

**Fix:** Resolve session and scope the invoice read to a txn the caller is allowed to see (same session+same-day gate as SEC-05). Update `useXenditPayment(txnId)` to also pass the live `sessionId` — only consumed on `sale/charge` + `sale/charge-success` where a session already exists, so no UX regression. **Fix SEC-05 and SEC-06 together.**

---

### 🟠 SEC-07 — Telegram approve PIN-verify DoS-locks the booth
**Files:** `convex/approvals/actions.ts:574-589` (`approveRefund`), `:989-1004` (`approveSpoilage`); also `:183`, `:432` (other `telegram_approval` PIN sites).

**What:** The off-booth approve actions call `argon2Verify` directly with **no lockout pre-check** (they bypass `verifyPinOrThrow`), but on failure still write `_recordFailedAttempt_internal` to `pos_auth_attempts` — the same table the booth login lockout reads (keyed by `staff_id`, device-agnostic). `args.managerStaffCode` is attacker-supplied, so an attacker holding *any* valid pending token can pick which manager to lock. The per-token cap (5) is *more* permissive than the 3-strike booth lock, so 3 wrong PINs lock the booth before the token caps.

**Exploit:** Obtain one approval token (visible/forwarded in the managers group, or the IndexedDB-persisted token of SEC-11). POST 3 wrong-PIN `approveRefund` calls (distinct idempotencyKeys) for a target manager's `staff_code` → that manager is `LOCKED_OUT` at the booth for 60s, repeatable. Availability DoS from off-site against a single-device booth.

**Fix:** Decouple the Telegram approve paths from the booth lockout table. Stop calling `_recordFailedAttempt_internal` (which patches `fail_count`/`locked_until`) from the approve failure branches; rely on the per-token `_recordTokenPinFailure_internal` cap (already revokes at 5). Preserve the `source: "telegram_approval"` audit row (rule #10) by splitting the recorder: add an audit-only internal mutation (or a `countTowardLockout: false` flag) that logs without touching `pos_auth_attempts`. Sweep **all** `telegram_approval` PIN-verify sites (`:183`, `:432`, `:584`, `:999`), not just two. (If shared lockout is genuinely desired, instead add a lockout **pre-check** mirroring `verifyPinOrThrow` — but decoupling is simpler and removes the cross-channel surface entirely.)

---

### 🟡 SEC-08 — Webhook confirms payment without amount/currency gate
**File:** `convex/transactions/internal.ts:245-250`. **Status:** documented ADR-036 design (honor-and-flag; money already moved; amount pinned upstream via `DYNAMIC` QR + `is_closed` FVA). No present exploit (webhook is `XENDIT_CALLBACK_TOKEN` constant-time gated). **Fix (hardening only):** (1) CI test asserting `buildQrisBody` always returns `type:"DYNAMIC"` + fixed amount and `buildBcaVaBody` always `is_closed:true` + `expected_amount` — so any future relaxation of upstream amount-pinning trips CI (precedent: the `buildQrisHeaders` api-version test). (2) Optionally surface currency in `parseXenditWebhook` and set `PAYMENT_AMOUNT_MISMATCH` (flag, not block) on non-IDR. No change to the confirm gate.

---

### 🟡 SEC-09 — getByToken leaks approval payload past TTL
**File:** `convex/approvals/public.ts:118-368`. **What:** computes `eff = effectiveStatus(req)` (yields `"expired"` once `token_expires_at <= now` for pending rows) then returns the full per-kind payload (amounts, refund line items, receipt numbers, staff names/codes) with no expiry gate. Sibling `listActiveManagers:487` *does* gate. Contradicts the ADR-029 VIEW-TTL model; reachable directly over the wire by any raw-token holder (the FE gate is not a security boundary). **Fix:** after line 134, `if (eff === "expired") return null;` — FE already renders the "expired/invalid" screen for null. Resolved/denied terminal rows are unaffected (`effectiveStatus` only yields `"expired"` for pending). Add a regression test.

---

### 🟡 SEC-10 — getChatIdByRole env fallback can ACT-gate on a stale chat
**File:** `convex/telegram/chatRegistry/internal.ts:161-186`. **What:** returns `process.env.TELEGRAM_CHAT_ID` when no live `managers` row exists and `TELEGRAM_FALLBACK_ROLE` matches, with no live re-validation. This same resolver backs the `/activatepos` ACT-gate. If the managers group migrates (group→supergroup, common per runbook) before re-binding, the gate trusts the stale env id. (Real-world exploitability is low — the stale id becomes *defunct*, not attacker-controlled — so the residual is mainly operational misrouting + a fail-open ACT-gate.) **Fix:** add `allowEnvFallback` (default true) to `getChatIdByRole`; ACT gates (`/activatepos`, any future PIN/ACT resolution) call with `allowEnvFallback:false` so a missing live binding **fails closed**. Outbound routing keeps the fallback. Emit a warn/audit when the env-fallback path is hit.

---

### 🟡 SEC-11 — Raw approval token persisted to IndexedDB for 24h
**Files:** `src/routes/approve/index.tsx:112,114,504-507,859-862,1227-1230`; `src/hooks/useIdempotency.ts:79-88` (TTL 24h). **What:** every `/approve` variant builds its idempotency intent as `approve-*:${token}` (raw token), and `useIdempotency` uses the intent as the IndexedDB **key**. The single-use VIEW token is written to durable disk for 24h — far exceeding its 60-min server TTL — and `clearIntent` only runs on terminal *error* states, not on success. **Fix:** (1) derive the intent from a non-secret stable id — prefer `requestId` (`approve-*:${requestId}`), else a hash prefix `sha256Hex(token).slice(0,16)`; idempotency only needs per-request stability, not secrecy. (2) Call `clearIntent` on the success branch too. (Fix 1 alone removes the secret from disk; touches only the five intent literals.)

---

### 🟡 SEC-12 — Voucher not re-validated at payment confirm
**Files:** `convex/transactions/internal.ts:252-267`; validation only at commit (`public.ts:235` → `lib/voucherValidate.ts:27-42`); `vouchers/internal.ts` `_redeemVoucher_internal` checks only `max_redemptions`. **What:** a voucher valid at cart-commit but expired/deactivated before payment still grants its discount, and writes a *clean* (non-flagged) redemption — an audit/reconciliation blind spot across the full `awaiting_payment` window. (Low: discount was legitimately computed against a then-valid voucher; `max_redemptions` still enforced; no escalation.) **Fix:** in `_confirmPaid` step 6, re-run `validateVoucherAgainst(voucher, txn.subtotal, Date.now())` before redeeming. Because money already moved, **do not** strip the discount — set a new `VOUCHER_INVALID_AT_CONFIRM` flag (`transactions/flags.ts`) and thread `validAtConfirm:false` into the `voucher.redeemed` audit metadata, mirroring the existing `PAYMENT_AMOUNT_MISMATCH` honor-and-flag pattern. Add a `confirmPaid.test.ts` case.

---

### ⚪ SEC-13 — Stale "KNOWN SECURITY (deferred)" comment
**File:** `convex/approvals/actions.ts:20-29`. The block comment claims the approve* paths have "NO per-token failed-attempt cap" — but `TOKEN_PIN_ATTEMPT_CAP=5` (`lib.ts:25`) is enforced via `_recordTokenPinFailure_internal` at five call sites, covered by `__tests__/tokenPinCap.test.ts`. **Maintenance hazard:** a maintainer trusting the comment could delete the cap as "dead code." **Fix:** rewrite the comment to state the cap IS implemented, describe only the genuine residual (cap is per-token; per-manager auth lockout recorded but intentionally not consulted on the approve path per `:177`), and point to the test.

---

### ⚪ SEC-14 — /activatepos gated on chat membership, not sender identity
**File:** `convex/telegram/activatePos.ts:41-56`. By design per ADR-035 / rule #10 — the managers Telegram group *is* the trust boundary, and device registration is only a precondition to login (the 4-digit PIN + lockout remains the actual auth gate). **Not a defect.** **Fix:** make the boundary explicit — a one-line comment at `:56` noting membership-equals-activation-authority is intentional, and a `docs/RUNBOOK-telegram.md` note that the managers chat membership list must be curated. Optional future hardening: allowlist known manager Telegram user IDs on `fromId`.

---

## Notes
- **False positives refuted during verification (2):** the swarm produced 16 raw findings; adversarial verifiers reading the actual protective code dropped 2 (verdict `false_positive`) before this list. The 14 above each survived a skeptical second read.
- **Method artifact:** each finding's `rationale` (severity calibration + why-not-a-false-positive) is preserved in the workflow result; this spec carries the actionable distillation.
- **Suggested follow-up issues:** SEC-01/SEC-07 (shared auth-counter refactor), SEC-05/SEC-06 (read-seam auth sweep), SEC-04 (activation throttle table + schema migration).
