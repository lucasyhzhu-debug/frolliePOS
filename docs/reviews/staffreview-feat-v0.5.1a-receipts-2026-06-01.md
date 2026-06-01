# Staff Review — feat/v0.5.1a-receipts (PR A: receipts subsystem)

**Date:** 2026-06-01
**Reviewer:** Reviewer 3 — Principal Developer (Architecture, ADR-034 lens)
**Branch:** `feat/v0.5.1a-receipts` (10 commits, 24 files, +1052 −11 vs main)
**Scope:** PR A of v0.5.1 — receipts module, shared token helper, `_confirmPaid` token mint, ESLint OWNERSHIP/ALLOWLIST update, `/r/:token` httpAction route.

---

## 1. Summary

**Module-depth verdict (one line):** PR A makes the codebase **deeper, net positive** — it adds one new deep module (`receipts/`) with a single external interface (`GET /r/:token`), narrows token-mint duplication into one shared helper, and does not widen any existing module's public surface.

**Overall assessment:** **Approve with 1 Important issue and 4 Minor refinements.** No Critical findings.

The implementation is faithful to the plan after the two acknowledged deviations, and both deviations are tasteful — the V8-safe `tokens.ts` design is strictly better than the plan's "thread the token through the args" workaround for a constraint the plan had inverted (it assumed `node:crypto`-only, which would have blocked deployment). Test coverage is appropriately tight on the seams: schema round-trip, cache TTL, http 200/404/cache-hit, status guard, lazy-mint idempotence, and a `_confirmPaid` token-stability re-fire test. The receipts module honestly admits two hardcodes (settings, payment_method) with TODOs pointing at PR B and v0.5.3 follow-ups.

The one Important issue is the **ESLint ALLOWLIST entry for `receipts`** — it works today, but it weakens the rule's invariant for a module that arguably should pull its cross-module reads through `transactions/internal` and `payments/internal`. The Minor refinements are: (a) the `_purgeReceiptCache_internal` stub is dead code until PR B lands, (b) the hand-rolled base64url encoder is more code than necessary, (c) `escapeHtml` is duplicated across `template.ts` and `lib/telegramHtml.ts`, and (d) the cache table has no reaper.

Graft integrity: clean. The receipt template owns its own hardcodes (business identity, payment method) inline rather than baking them into a schema or exporting them, so the v0.5.3 settings UI + the v1.1+ Frollie Pro integration both stay clean — both are pure renderer changes.

## 2. Critical Issues (Must Fix)

**None.**

## 3. Important (Should Fix Before Merge)

### I1 — ALLOWLIST exemption for `receipts` widens the lint invariant where a deep alternative exists

**Where:** `eslint.config.js:74` adds `receipts` to `ALLOWLIST`. The justification comment is honest about why (aggregate read spanning `pos_transactions` + `pos_transaction_lines` + future `pos_xendit_invoices`).

**The architectural question:** ADR-034 §"Cross-module patterns" makes the deep choice explicit — *"if two modules need the same data, one owns it and the other reads through the owner's public/internal API."* The receipts module already does the right thing for primary-record access through indices it owns (`pos_transactions.by_receipt_token`). For the aggregate read in `_buildViewModel_internal`, two options exist:

- **Today's choice (shallow boundary, deep allowlist):** `receipts` reads `pos_transactions` + `pos_transaction_lines` directly with an ALLOWLIST exemption. Code is local; the read joins the consumer.
- **The deep alternative:** `transactions/internal._getTxnAndLinesForReceipt_internal({ txnId })` returns `{ txn, lines }` as a typed shape. Receipts loses the ALLOWLIST entry. The aggregate read pattern lives in the owner module (transactions), exposed as a named contract.

Both are defensible. The plan picked option 1 with the reasoning "today's cross-table read is shallow; the wrapper is the deep alternative" — but ADR-034 explicitly does *not* sanction aggregate-read-in-consumer as a general pattern; it sanctions cross-module reads via the owning module's internal surface. The ALLOWLIST entry is an escape hatch that admits "this module breaks the rule on purpose." Every entry on that list weakens the rule for the next module too.

**The case for option 2:**
1. The receipts module gains a single dependency surface (`transactions/internal`) rather than ad-hoc table reads. PR B's payment_method work will need to do the same exercise against `payments/internal` — that's a second ALLOWLIST entry's worth of read scope arriving soon.
2. Other modules already follow this pattern: `transactions/internal._confirmPaid_internal` reaches into `catalog/internal`, `inventory/internal`, and `vouchers/internal` for owned reads. Receipts is doing something different.
3. The wrapper is ~6 lines (`internalQuery` + collect lines by index). Cost is low. It also gives the receipts module a future cache-by-txn-id mutation that PR B's `_purgeReceiptCache_internal` will want to coexist with cleanly.

**Recommendation:** Either (a) replace the ALLOWLIST entry with a `transactions/internal._getTxnAndLinesForReceipt_internal` helper before merge, OR (b) leave the entry but commit the ADR-034 amendment in the same PR — document the "aggregate read in consumer" pattern explicitly in ADR-034 as a sanctioned exception, with stated criteria (e.g., "purely read-only render assembly, no writes, no business logic"). Today the codebase has the entry without the amendment, which is a doc/code drift.

If you pick (b), update the ALLOWLIST comment to point at the amended ADR-034 section rather than gesturing at "per ADR-034 guidance" — the current text reads like the pattern is already sanctioned, but I can't find that sanction in ADR-034 as written.

**Not blocking:** the code is correct and the test surface is solid. This is an architectural choice with a half-life — it lands precedent for future module ALLOWLIST entries. Worth a 15-minute decision before merge.

## 4. Improvements (Recommended)

### M1 — `_purgeReceiptCache_internal` is dead code until PR B

**Where:** `convex/receipts/internal.ts:123-129` ships an empty-body `internalMutation` with a comment that says "PR A stub — no callers. PR B replaces."

**Tradeoff:** committing the API surface in PR A means PR B's refunds/internal can import this name immediately without churning the receipts module. The cost is a deployed mutation with a `return;` body for the lifetime of PR A on `main`. If PR B is delayed or split, this is genuinely dead code visible to the dashboard.

**Recommendation:** Acceptable as-is, *if* PR B is the next thing landing on main (which the PROGRESS.md flip to "in progress" suggests). If PR B is more than ~2 weeks out, either inline the no-op at PR B's call sites and drop this stub, or land a meaningful body now (looking up the txn → if `receipt_token` absent, no-op; else delete cache by token). The latter is ~10 lines and removes the dead-code concern entirely without waiting for PR B's purge semantics.

The current docstring is honest about the staleness ("PR A stub — no callers"). That's the right pattern *if* the stub stays under a few weeks.

### M2 — Hand-rolled base64url encoder is more code than necessary

**Where:** `convex/lib/tokens.ts:14-45` ships a 32-line hand-rolled base64url encoder.

**The alternative:** Convex's V8 runtime supports `btoa` + standard string replace:

```ts
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

5 lines vs 32. The hand-roll is correct (I traced the bit-shuffle and the tail-byte handling) but the surface area is higher than necessary and the next person editing this file has to re-verify the bit math.

**Recommendation:** Swap to the `btoa`-based version unless there's a Convex V8 runtime gotcha I'm missing. The test (`tokens.test.ts`) asserts the output shape (43 chars, no padding, URL-safe alphabet) so the swap is mechanically safe — same test passes. Worth verifying `btoa` works inside a Convex `internalMutation` (it should — V8 standard) with one quick run before swapping.

If you keep the hand-roll, that's fine — it's correct — but consider deleting the BASE64URL_ALPHABET module-level const and inlining the lookup since it's used in exactly one function.

### M3 — `escapeHtml` is duplicated across `template.ts` and `lib/telegramHtml.ts`

**Where:** `convex/receipts/template.ts:74-81` has its own `escapeHtml`. CLAUDE.md's File locations section advertises `convex/lib/telegramHtml.ts` as owning "escapeHtml" as a cross-cutting utility.

**The architectural question:** Is `escapeHtml` a "telegram" utility that happens to be HTML-safe, or a generic HTML-encoding helper? Looking at the implementation in both files, it's the canonical 5-replacement HTML entity encoder — there's no Telegram-specific flavour. It belongs in a more neutral location.

**Recommendation:** Move `escapeHtml` from `convex/lib/telegramHtml.ts` to a new `convex/lib/html.ts` (or just `convex/lib/escape.ts`). Both callers import from there. `telegramHtml.ts` re-exports for back-compat (or its callers update). The `rp()` duplication is unavoidable (frontend vs backend; see plan staffreview Section 5) but `escapeHtml` is server-side in both call sites and can dedupe cleanly. ~5 lines of change.

Out of scope for PR A if you'd rather batch it with PR B's `rp()` work. But noting it because the receipts template is a *third* place this same helper now lives (telegramHtml, here, and probably a fourth time in PR B's refund renderer).

### M4 — Cache table has no reaper; storage grows monotonically

**Where:** `convex/receipts/schema.ts:4-15` ships `pos_receipt_html_cache` with a soft TTL (`expires_at` filtered on read). Plan acknowledges this: "no reaper cron — storage is cheap, lazy is always correct."

**The math:** At 50 sales/day × 365 days × 5 years = 91k rows. Average rendered HTML is ~3-5KB per template inspection. Conservative estimate: 300-500MB at 5y. Convex's pricing is generous on storage, but the row count itself (not size) is what hurts queries that scan without indices. The `_getCachedReceipt_internal` query uses `by_token` (unique lookup), so it's index-only and fine. No query in PR A or planned PR B scans the table without `by_token`.

**Recommendation:** Acceptable. The "lazy regenerate always" claim is true and the index supports it. But: add a one-line comment to the schema noting that **if** a future surface needs to scan the cache (e.g., "list all cached receipts in last 24h" for an admin debug screen), the reaper becomes required at that point. Today's deferral is correct; what's risky is the deferral becoming invisible.

Alternatively, a 5-line `crons.ts` entry that runs `_purgeExpiredCache_internal` weekly (deleting rows where `expires_at < Date.now() - 30 days`) is cheap insurance and removes the architectural-debt note from the changelog. Not a hill to die on — defer to founder preference.

## 5. Refinements (Optional)

### R1 — Inline-style HTML in `template.ts` is intentional but undocumented

The receipt template uses ~30 inline `style=` attributes. This is correct for a self-contained printable receipt (no external stylesheet to fetch, prints reliably from WhatsApp link previews, no CSP issues), but the rationale is implicit. Add a 2-line comment at the top of `renderReceipt()` explaining the inline-style choice so a future reviewer doesn't refactor it to a `<style>` block thinking they're cleaning up.

### R2 — `_renderReceiptByToken_internal` does an extra index lookup that `_buildViewModel_internal` repeats

`_renderReceiptByToken_internal` looks up the txn by `by_receipt_token` (line 69-72), then calls `_buildViewModel_internal({ transactionId: txn._id })` which immediately does `ctx.db.get(args.transactionId)` again (line 19). Two reads for one logical fetch. At Convex query overhead this is microseconds, but it does load the txn document twice into memory.

**Cleanup option:** factor the txn-load into `_renderReceiptByToken_internal`, pass the loaded txn into a renamed `_buildViewModelFromTxn_internal({ txn })`. Or accept the duplication as "two callers might want either entry point." Today only `_renderReceiptByToken_internal` calls `_buildViewModel_internal`, so the latter is dead-end optimisation. Defer.

### R3 — Hardcoded `payment_method: "QRIS"` masks BCA VA receipts

Comment at `internal.ts:43` acknowledges this is wrong for BCA VA. PR B plans to fix it. Make sure the PR B plan calls this out explicitly — the receipt template currently lies about how customers paid for any BCA VA sale that lands between PR A merging and PR B's payment-method wire-up shipping. For most booths this window is short; if PR B slips, the BCA VA receipts will say "Dibayar via QRIS" until PR B ships.

**Mitigation if PR B slips >1 week:** add a 5-line fix that reads `pos_xendit_invoices` (via `payments/internal._getLatestInvoiceForTxn_internal` — yes, that's a second ADR-034 helper that doesn't exist yet, c.f. I1 above) and writes the actual method. Or just hardcode `"QRIS / BCA VA"` for safety until PR B lands.

### R4 — Audit verb `receipt.token_minted` is only emitted by the dormant lazy-mint path

`_confirmPaid_internal` mints `receipt_token` *without* a `receipt.token_minted` audit row — the per-transaction mint is implicit in the existing `payment.confirmed` audit. Only the lazy-mint helper (dormant in v0.5.1) emits the new verb. That's the right call (no need to double-log the same event), but the SCHEMA.md audit enum lists `receipt.token_minted` as a top-level verb without noting it fires only from the lazy path. Add a one-liner to SCHEMA.md so the next reviewer doesn't search for the missing emit site.

## 6. Deep-module discipline scorecard (ADR-034 lens)

| Question | Verdict |
|---|---|
| Is the `receipts/` module deep? | **Yes.** One external interface (`GET /r/:token`). Internal lifecycle is hidden (cache lookup → render → write-through). The httpAction surface is narrower than the internal helper count. |
| Did receipts widen any other module's public interface? | **No.** `transactions` schema gained an optional field (`receipt_token`), but the public surface didn't change. `_confirmPaid_internal`'s args validator is byte-identical. `approvals/actions` had its `randomBytes` replaced with `mintUrlSafeToken` — that's a refactor, not a surface widening. |
| Information leakage across modules? | **Mostly clean.** The aggregate read in `_buildViewModel_internal` is the one exception — see I1. Cross-module helpers used (`logAudit`, `mintUrlSafeToken`) are both in the sanctioned `audit` and shared-lib categories. |
| Does receipts lock in anything that would make v1.1+ Frollie Pro integration harder? | **No.** The receipt is a pure projection. Settings and payment_method hardcodes live inside `_buildViewModel_internal` and are entirely renderer-internal — Frollie Pro never sees them. The `pos_receipt_html_cache` table is internal-only; nothing on the external API surface references it. |
| Future flexibility cost? | **Low.** The template is a pure function; the cache is keyed by token (no schema migration if format changes); the lazy-mint helper exists but is dormant so v0.5.3 doesn't need to retrofit. |

## 7. Plan-fidelity scorecard

| Plan item | Implementation | Verdict |
|---|---|---|
| Task A1: schema additions (`pos_receipt_html_cache` + `receipt_token` field) | Shipped verbatim, schema.test.ts confirms both | ✅ |
| Task A2: schema round-trip test | `convex/receipts/__tests__/schema.test.ts` | ✅ |
| Task A3: extract `mintUrlSafeToken` shared helper | Web Crypto deviation acknowledged; better than plan | ✅ (deviation tasteful) |
| Task A4: `formatWibDateTime` + receipt template | Template at `convex/receipts/template.ts` (not `src/`; plan correctly amended) | ✅ |
| Task A5: receipts internal module | `_buildViewModel_internal`, `_renderReceiptByToken_internal`, `_getCachedReceipt_internal`, `_writeCacheEntry_internal`, `_purgeReceiptCache_internal` (stub), `_lazyMintReceiptToken_internal` | ✅ |
| Task A6: `_confirmPaid` mints `receipt_token` | Inline mint (deviation #2) — V8-safe via Task A3 deviation. Tasteful, simpler than plan's arg-threading approach | ✅ (deviation tasteful) |
| Task A7: `/r/:token` httpAction + tests | `http.ts`, `__tests__/http.test.ts` covers 200, 404, cache-hit, status guard | ✅ |
| Task A8: audit verb `receipt.token_minted` added | Audit enum is `v.string()`, no validator needed (plan's "add to validator" was wrong — review caught it correctly) | ✅ |
| Task A9: docs (CHANGELOG, SCHEMA, CLAUDE.md, API_REFERENCE, PROGRESS) | All five surfaces updated in one commit (`5d2de88`) | ✅ |
| Task A10: ship | Awaiting | — |

**Deviations from plan, ranked:**

1. **Web Crypto in `tokens.ts`** (instead of `node:crypto`). Strictly better than the plan. The plan's `node:crypto` assumption would have forced an args-threading workaround in `_confirmPaid` that the V8-safe design simply doesn't need. The previous plan staffreview (C1) called this out as a runtime-mismatch issue, but the solution it proposed (thread the token through args) is the *worse* of the two fixes. The implementation found the better fix.

2. **Inline mint in `_confirmPaid_internal`** (instead of caller-threaded arg). Possible because of deviation #1. Result: zero changes to `payments/internal.ts` or any test seed. Cleaner.

3. **ESLint ALLOWLIST gained `receipts`**. Not anticipated by the plan. See Important I1 above.

4. **Plan was wrong about Task A8** (claimed `receipt.token_minted` needs adding to an actionValidator). Reality: `audit.action` is `v.string()`. Plan was incorrect; the controller correctly skipped that work. ✅

5. **Plan said `convex/lib/receipt-template.ts` (frontend)**. Reality: `convex/receipts/template.ts` (backend). Documented inline in the plan as a known correction. ✅

## 8. Tests vs. seams

The seam coverage is the right shape. Each test asserts at a different boundary:

- `schema.test.ts` — Convex schema validates new columns + optional-field back-compat
- `cache.test.ts` — `_writeCacheEntry_internal` + `_getCachedReceipt_internal` round-trip + TTL window + expired-returns-null + upsert idempotence (4 cases)
- `http.test.ts` — `t.fetch("/r/<token>")` end-to-end through the httpAction registration; 200, 404 (unknown), 404 (cancelled status guard), cache-hit byte-identity
- `template.test.ts` — pure renderer: LUNAS, multi-line, voucher, IDR format, XSS escape, Instagram CTA
- `lazy-mint.test.ts` — dormant helper proves: mint + audit + receipt_token patched on first call, idempotent on second call
- `confirm-paid-token.test.ts` — `_confirmPaid_internal` mints + token format + idempotent re-fire
- `tokens.test.ts` — mintUrlSafeToken format + entropy + custom byte counts

What's **not** tested:
- `_renderReceiptByToken_internal` directly (covered transitively by `http.test.ts`). Fine — internal helpers are tested through their callers.
- The lazy-mint helper does NOT have an auth-gate check (the helper docstring explicitly says callers must verify session). No test asserts this contract — but there are no callers in v0.5.1 either. PR's v0.5.3 history surface should add the auth test when it adds the caller. Acceptable.
- No test exercises the lazy-mint helper's `TXN_NOT_FOUND` throw path. One-liner to add, very low value. Defer.

## 9. Graft integrity (Frollie Pro v1.1+ readiness)

PR A does not touch `convex/api/v1/`. The receipts module is entirely internal. The receipt is a customer-facing HTML page, not part of the v1.1 Frollie Pro contract — Frollie Pro will read `pos_transactions` rows via the external API and render its own receipts (or not). Nothing in PR A locks in a field name, table shape, or ID format that would make that contract harder.

The one consideration: `pos_transactions.receipt_token` is now part of the txn shape. If the v1.1 external API ever exposes transaction rows, the token will need to either be omitted (it's a capability — leaking it on the API surface defeats the unguessable-URL property) or hashed before serialization. **Recommendation:** add a one-line note to ADR-034's `staffCode`-style stable-ID table that `receipt_token` is **internal-only and MUST NOT appear on the external API surface**. Forward-defends the v1.1 endpoint design.

## 10. Approval

**Approve to merge** after addressing Important I1 (either replace the ALLOWLIST entry with a `transactions/internal` helper, or commit the ADR-034 amendment that sanctions aggregate-read-in-consumer with stated criteria — pick one before merge).

Minor refinements M1–M4 and R1–R4 are non-blocking; address opportunistically in PR B or v0.5.3 unless any one of them flips a decision (R3 is the most likely to bite if PR B slips >1 week).

The two plan deviations are exactly the kind of taste a senior implementer should show: improve the design when the constraint that motivated the plan turns out to be soft. Both deviations were documented (CHANGELOG, code comments). That's the standard.

---

*Generated by /staffreview — Reviewer 3 (architecture / ADR-034 lens)*
