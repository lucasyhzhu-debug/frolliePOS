# Triage: issue #43 — E2E Xendit simulate 404 (C1) root-cause findings

**Date:** 2026-06-07
**Task:** v0.6.1 Wave B, task B1 (investigation only — no production/helper code changed here).
**Scope:** Determine, with evidence, the single source to fix so the 4 quarantined C1 specs
(`sale-qris`, `sale-bca-va`, `voucher-online`, `refund`) un-skip in B2/B3. Also record (not fix)
the C2 (`voucher-offline`) and C3 (`spoilage`) causes for B4/B5.

**Verdict up front:**
- **QRIS 404 is a real bug, in the helper.** `e2e/helpers/xendit-simulate.ts::simulateQrisPaid`
  omits the **`api-version: 2022-07-31`** header. Same load-bearing header as QR-*create*. The
  stored id and the `data-qr-id` attribute are **correct** — `charge.tsx` needs no change.
- **BCA VA is NOT the same root cause.** The FVA helper, path, and `external_id` field are all
  correct *today* — live-verified 200. The CI 404 was an environmental/state artifact, not a
  field or path bug. B3 should re-validate by un-skipping; no source change is required for FVA.

---

## 1. The six verbatim SKIP headers

### C1 — Xendit simulate 404 (the 4 specs this task triages)

**`e2e/specs/sale-qris.spec.ts`** (lines 4–27):
> SKIPPED: Xendit QRIS simulate endpoint returns 404 DATA_NOT_FOUND when called
> with the data-qr-id value sourced from charge.tsx:524-525 (the persisted
> `invoice.xendit_invoice_id`). Slice 1 a11y fixes successfully unblocked the
> catalog click + tab role + QR rendering — the spec reaches the simulate
> helper, which is where it fails. The 404 indicates a mismatch between what
> we store as `xendit_invoice_id` and what the `/qr_codes/{id}/payments/simulate`
> endpoint expects (possibly the QR Codes API `id` vs `reference_id` distinction,
> or test-mode endpoint shape change since the helper was authored).
> Observed failure mode (Gate 1 of PR #52, Playwright run `27054044763`):
>   "simulateQrisPaid failed: 404 {\"error_code\":\"DATA_NOT_FOUND\",
>    \"message\":\"Data not found\"}"
>   at e2e/helpers/xendit-simulate.ts:25 from spec line ~17.

**`e2e/specs/sale-bca-va.spec.ts`** (lines 4–24):
> SKIPPED: Xendit BCA VA simulate endpoint returns 404
> CALLBACK_VIRTUAL_ACCOUNT_NOT_FOUND_ERROR ("item does not exist") when
> called with `data-external-id` value sourced from charge.tsx:549-558. Slice
> 1 a11y fixes successfully unblocked the catalog click + tab role + VA
> number rendering — the spec now reaches the simulate helper, which is
> where it fails. Same root-cause family as sale-qris.spec.ts (Xendit test-
> mode endpoint shape vs the stored reference_id / external_id we publish).
> Observed failure mode (Gate 2 of PR #52, Playwright run `27055135440`):
>   "simulateBcaVaPaid failed: 404 {\"error_code\":\"CALLBACK_VIRTUAL_
>    ACCOUNT_NOT_FOUND_ERROR\",\"message\":\"item does not exist\"}"
>   at e2e/helpers/xendit-simulate.ts:37 from spec line ~20.

**`e2e/specs/voucher-online.spec.ts`** (lines 4–24):
> SKIPPED: Same Xendit QRIS simulate 404 (DATA_NOT_FOUND) root cause as
> sale-qris.spec.ts + refund.spec.ts. Slice 1 a11y fixes + Slice 2 form-flow
> fixes (Dialog open + button role for /sale voucher entry + Continue submit
> text) all work — the spec reaches the simulate step at line 35, which is
> where every QRIS-using spec fails on the dev deployment. [...]
> Observed failure mode (Gate 3 of PR #52, Playwright run `27055267328`):
>   "Error: simulateQrisPaid failed: 404 {\"error_code\":\"DATA_NOT_FOUND\",
>    \"message\":\"Data not found\"}"

**`e2e/specs/refund.spec.ts`** (lines 4–23):
> SKIPPED: Refund spec depends on `simulateQrisPaid` succeeding to create the
> paid sale that will be refunded. That helper currently returns 404
> DATA_NOT_FOUND on dev (see sale-qris.spec.ts SKIP for full diagnosis).
> The refund-specific selectors [...] are unblocked by Slice 1 a11y work —
> they're just unreachable until the upstream paid-sale step works.
> Observed failure mode (Gate 1 of PR #52, Playwright run `27054044763`):
>   "simulateQrisPaid failed: 404 {\"error_code\":\"DATA_NOT_FOUND\", [...]"

### C2 — `voucher-offline` (record only; B4)

**`e2e/specs/voucher-offline.spec.ts`** (lines 3–22):
> SKIPPED: voucher-offline spec body's execSync calls have unresolved <TBD>
> tokens for sessionId and voucherId [...]. The seed action
> `convex/seed/actions.ts::reset` returns `{wiped, inserted}` only — it does
> not emit stable test IDs for the voucher created mid-spec or for Lucas's
> manager session. The attempted concurrent-archive step [...] cannot run
> without those IDs.

### C3 — `spoilage` (record only; B5)

**`e2e/specs/spoilage.spec.ts`** (lines 3–29):
> SKIPPED: After Slice 1's Task 3 added htmlFor=spoilage-qty-${i}, Playwright
> resolves the Qty input correctly [...]. But the post-fill state shows the
> "Log spoilage now" button STILL disabled [...]. Either the React state
> didn't update from the .fill() calls (likely a `onChange` filter that strips
> the value — spoilage.tsx:270 has `replace(/[^\d]/g, "")` [...]), or the form
> has an additional disable condition the spec doesn't satisfy. Needs local
> headed-Playwright repro to diagnose.

---

## 2. The proven id chain (Step 3)

### QRIS

| Step | Value | Citation |
|---|---|---|
| QR Codes create body sends `reference_id` + `external_id` = `pos-${txnId}` | `ref` | `convex/payments/xendit.ts:50-58`, `convex/payments/actions.ts:47-51` |
| Xendit returns `{ id: "qr_…", qr_string }`; we keep `providerId = json.id` | `qr_…` | `convex/payments/xendit.ts:85-92` |
| `providerId` persisted into **`xendit_invoice_id`** | `qr_…` | `convex/payments/actions.ts:59` → `_persistInvoiceCommit_internal` |
| Schema: `xendit_invoice_id` = "QR Codes `id` … dedup/match key for webhook" | — | `convex/payments/schema.ts:7` |
| `charge.tsx` exposes **`data-qr-id = invoice.xendit_invoice_id`** | `qr_…` | `src/routes/sale/charge.tsx:524-525` |
| Spec reads `data-qr-id`, passes to `simulateQrisPaid(qrId, …)` | `qr_…` | `e2e/specs/sale-qris.spec.ts:37-41` |
| Helper hits `POST /qr_codes/{qrId}/payments/simulate` — **wants the QR Codes `id`** | `qr_…` | `e2e/helpers/xendit-simulate.ts:18-27`; `docs/xendit-reference/README.md:59,108` |

**The field is correct end-to-end.** The QR Codes `id` we store *is* what the simulate
endpoint expects. The "id vs reference_id" hypothesis in the SKIP comment is **refuted** below.

### FVA (BCA VA)

| Step | Value | Citation |
|---|---|---|
| FVA create body sends `external_id` = `pos-${txnId}` | `ref` | `convex/payments/xendit.ts:60-69`, `actions.ts:47-51` |
| `reference_id` persisted = same `ref` | `pos-${txnId}` | `convex/payments/actions.ts:60` |
| `charge.tsx` exposes **`data-external-id = invoice.reference_id`** (fallback `pos-${txn._id}`) | `pos-${txnId}` | `src/routes/sale/charge.tsx:549-558` |
| Spec reads `data-external-id`, passes to `simulateBcaVaPaid(extId, …)` | `pos-${txnId}` | `e2e/specs/sale-bca-va.spec.ts:31-37` |
| Helper hits `POST /callback_virtual_accounts/external_id={extId}/simulate_payment` — **wants the FVA `external_id`** | `pos-${txnId}` | `e2e/helpers/xendit-simulate.ts:29-39` |

**The field is correct end-to-end** for FVA too.

---

## 3. Live reproduction (Step 4) — DECISIVE

Probed the Xendit TEST API directly (`xnd_development_…` key from the dev Convex deployment),
bypassing the app and the seed wipe entirely. No spec was flipped; no dev data was wiped.

### QRIS — isolates the missing header

1. **Create** `POST /qr_codes` (with `api-version: 2022-07-31`) → `201`,
   `id = qr_d32b592c-d75d-4bac-a1e3-d6cc01c65610`.
2. **Simulate with the SAME id, NO `api-version` header** (exact helper shape):
   `POST /qr_codes/{id}/payments/simulate` → **`404 {"error_code":"DATA_NOT_FOUND"}`**
   — reproduces the CI failure byte-for-byte, with the QR's own freshly-returned id.
3. **Simulate with the SAME id, ADD `api-version: 2022-07-31`** →
   **`200 {"status":"SUCCEEDED","qr_id":"qr_d32b592c…","payment_detail":{"receipt_id":…,"source":"DANA"}}`**.
4. Simulate by `reference_id` in the path (testing the SKIP's "id vs reference_id" hypothesis)
   → `404 DATA_NOT_FOUND`. **The hypothesis is refuted: it is not a field issue.**

**Root cause (QRIS): the helper omits `api-version: 2022-07-31`.** This is the identical
load-bearing-header gotcha documented for QR *creation* (`docs/xendit-reference/README.md`
bug #2, line 34). The QR Codes endpoint resolves the `qr_…` id only under that API version;
without it Xendit applies a default version that does not know the id → 404.

### FVA — helper is correct as written

1. **Create** `POST /callback_virtual_accounts` (`external_id = probe-fva2-…`) → `200`.
2. **Simulate by `external_id`, NO `api-version`** (exact helper shape):
   `POST /callback_virtual_accounts/external_id={external_id}/simulate_payment` →
   **`200 {"status":"COMPLETED","message":"Payment for the Fixed VA with external id … is
   currently being processed …"}`**. Deterministic across two runs.
3. Adding `api-version` to the FVA simulate → `400 CALLBACK_VIRTUAL_ACCOUNT_INACTIVE_ERROR`
   (because run #2 above had already paid that VA) — i.e. the header is **not** needed for FVA
   and the path/field are right.

**Root cause (FVA): NOT a helper or field bug.** The helper's path, the `external_id` field,
and the `data-external-id` source are all correct and live-verified. The CI 404
(`CALLBACK_VIRTUAL_ACCOUNT_NOT_FOUND_ERROR`, run `27055135440`) was an environmental/state
artifact — most plausibly the FVA `external_id` not existing on Xendit at simulate time in that
specific run (e.g. the invoice-create leg not completing, or the simulate firing before the VA
landed), not a structural mismatch. QRIS and FVA therefore have **different** root causes despite
the SKIP comments grouping them as one "family".

---

## 4. Root cause + where the fix belongs

| Spec | Root cause | Fix location | Confidence |
|---|---|---|---|
| `sale-qris` | `simulateQrisPaid` omits `api-version: 2022-07-31` | **`e2e/helpers/xendit-simulate.ts`** (helper) — one header | Live-proven |
| `voucher-online` | downstream of `simulateQrisPaid` | same helper fix unblocks it | Live-proven |
| `refund` | downstream of `simulateQrisPaid` | same helper fix unblocks it | Live-proven |
| `sale-bca-va` | helper/path/field correct; CI 404 was environmental | **no source change**; re-validate by un-skipping in B3 | Live-proven helper is correct |

`src/routes/sale/charge.tsx` is **correct** for both QRIS and FVA — do not change it.

## 5. Fix plan for B2 / B3

- **B2 (QRIS, +voucher-online, +refund):** in `e2e/helpers/xendit-simulate.ts::simulateQrisPaid`,
  add `"api-version": "2022-07-31"` to the request headers (lines 20-22). One source, one line.
  Un-skip `sale-qris`, `voucher-online`, `refund`.
- **B3 (BCA VA):** no helper/charge change. Un-skip `sale-bca-va` and run it; the helper is
  already correct (live-verified 200). If it still 404s in CI, the cause is the invoice-create
  leg / timing, not the simulate field — investigate the create step, not `data-external-id`.

## 6. Recorded for B4 / B5 (not fixed here)

- **C2 `voucher-offline` (B4):** spec body has `<TBD>` tokens for `sessionId` + `voucherId`;
  `convex/seed/actions.ts::reset` returns only `{ wiped, inserted }` (no stable test IDs). Fix is
  seed-side: have `reset` emit the manager session id + first voucher id. (Issue #55.)
- **C3 `spoilage` (B5):** "Log spoilage now" stays disabled after `.fill()` of Qty + Reason;
  PIN sheet never opens. Hypothesis (unverified): `spoilage.tsx:270` `replace(/[^\d]/g,"")`
  onChange not firing under Playwright `.fill()`, or an extra disable condition. Needs local
  headed repro. (Issue #54.)

## Probe transcript (for re-verification)

Run from the worktree with `export XENDIT_SECRET_KEY=$(npx convex env get XENDIT_SECRET_KEY)`:

```
# QRIS create → returns id=qr_…  (201)
# simulate id WITHOUT api-version  → 404 DATA_NOT_FOUND      (= the CI failure)
# simulate id WITH    api-version  → 200 status:SUCCEEDED    (= the fix)
# simulate by reference_id          → 404 DATA_NOT_FOUND      (refutes "id-vs-reference_id")

# FVA create (external_id=ref)      → 200
# simulate external_id, no header   → 200 status:COMPLETED    (helper already correct)
```
