# e2e gaps deferred until v1 verification

**Status:** Live tracker. Don't fix entries here piecemeal — revisit as a batch after v1 feature dev is complete (catalog, refund, settlements, vouchers, spoilage flows are all on the v1 path; their UI may shift again before final verification).

**Why deferred:** PR #52 (v0.5.9) shipped Slice 1 a11y / selector-drift fixes that demonstrably work — every blocked spec now progresses past the previously-failing step in CI. The remaining failures are a mix of (a) external-API behaviour (Xendit test-mode), (b) form-state mysteries needing local headed-Playwright repro, (c) UI structure changes that may move again before v1, and (d) seed-side surface changes that are out of v0.5.9 scope. Spot-fixing each in v0.5.9 turned into selector-drift whack-a-mole on top of selector-drift whack-a-mole. Better: finalize v1 UI, then verify all six specs in one batch.

**Discipline contract:** Every entry below has a three-field SKIP in its spec file (`docs/PATTERNS/skip-comment-template.md`). When verifying, start from the SKIP comment, not this tracker — the spec file is the source of truth for the observed failure mode.

## Index

| # | Spec | Follow-up issue | Verifying step |
|---|---|---|---|
| 1 | `e2e/specs/sale-qris.spec.ts` | [#53](https://github.com/lucasyhzhu-debug/frolliePOS/issues/53) | After Xendit `xendit_invoice_id`-vs-QR-id resolution; or test-mode endpoint shape update |
| 2 | `e2e/specs/refund.spec.ts` | [#53](https://github.com/lucasyhzhu-debug/frolliePOS/issues/53) | Same as #1 (refund depends on a paid sale, which depends on QRIS simulate working) |
| 3 | `e2e/specs/sale-bca-va.spec.ts` | [#53](https://github.com/lucasyhzhu-debug/frolliePOS/issues/53) | Same root family (Xendit FVA simulate 404) |
| 4 | `e2e/specs/spoilage.spec.ts` | [#54](https://github.com/lucasyhzhu-debug/frolliePOS/issues/54) | Local headed repro to diagnose disabled-button-after-fill behaviour |
| 5 | `e2e/specs/voucher-online.spec.ts` | [#53](https://github.com/lucasyhzhu-debug/frolliePOS/issues/53) | Same as #1 (depends on QRIS simulate) |
| 6 | `e2e/specs/voucher-offline.spec.ts` | [#55](https://github.com/lucasyhzhu-debug/frolliePOS/issues/55) | Seed-side: `seed/actions:reset` must expose stable test IDs |

(`e2e/specs/auth.spec.ts` lockout body — out of scope, separate v0.5.7.1 decision. Not tracked here.)

## What's evidenced

All evidence below was captured in PR #52 CI runs. Re-pull from `.claude/pw-report/run-<id>/` for screenshots / traces / page snapshots.

### Xendit QRIS simulate 404 — `#53`

- **Endpoint:** `POST /qr_codes/{xendit_invoice_id}/payments/simulate`
- **Response:** `404 {"error_code":"DATA_NOT_FOUND","message":"Data not found"}`
- **Evidence runs:** `27054044763` (sale-qris + refund), `27055267328` (voucher-online — same root cause downstream)
- **Source of `data-qr-id`:** `src/routes/sale/charge.tsx:524-525` — `invoice.xendit_invoice_id`
- **Confirmed working through:** QR canvas render, data attribute on the DOM, locator captured the qrId successfully.
- **Hypothesis to test (NOT a fix):** Xendit's QR Codes API may distinguish `id` vs `reference_id`, and `xendit_invoice_id` may be storing the wrong field. Verify via `docs/xendit-reference/` and a curl probe before any code change.

### Xendit BCA VA simulate 404 — `#53`

- **Endpoint:** `POST /callback_virtual_accounts/external_id={reference_id}/simulate_payment`
- **Response:** `404 {"error_code":"CALLBACK_VIRTUAL_ACCOUNT_NOT_FOUND_ERROR","message":"item does not exist"}`
- **Evidence run:** `27055135440` (sale-bca-va)
- **Source of `data-external-id`:** `src/routes/sale/charge.tsx:549-558` — `invoice.reference_id` (or derived `pos-${txn._id}` fallback)
- **Confirmed working through:** BCA VA tab opens, VA number element waits for `data-external-id`, attribute resolved cleanly.
- **Likely same root cause family** as QRIS 404 (paired investigation in `#53`).

### Spoilage form-state mystery — `#54`

- **Failure:** `Log spoilage now` button stays disabled after `.fill()` of Qty and Reason; PIN sheet never opens.
- **Page snapshot reference:** `.claude/pw-report/run-27054044763/data/c4a487c7…md`
- **Confirmed working through:** SKU combobox selection, htmlFor-paired Qty Label/Input (Slice 1 Task 3), Reason placeholder match.
- **Hypothesis to test (NOT a fix):** `spoilage.tsx:270` has `replace(/[^\d]/g, "")` on Qty onChange; Playwright `.fill("2")` may not be triggering onChange under chromium-mobile viewport. Needs local headed Playwright repro before any change.

### Voucher-offline seed-IDs gap — `#55`

- **Failure:** Spec body needs `lucasSessionId` + `voucherId` to race a concurrent archive against an offline apply (ADR-009 reject-banner verification). `seed/actions:reset` returns only `{wiped, inserted}`.
- **Source confirmation:** `convex/seed/actions.ts:23` — `Promise<{ wiped: number; inserted: number }>` (verified by Task 10 static analysis, 2026-06-06).
- **This is the only gap with a clear seed-side surface change as the unblocking step** — no investigation needed, just a surface change in seed action.

## Other PR-52 deviations recorded here for completeness

### `staffreview` skill not a git repo on this machine

- **Where:** `~/.claude/skills/staffreview/SKILL.md`
- **What:** §4.9 Evidence-Before-Mitigation Gate was inserted as a file edit (557 → 579 lines) but **no git commit** was made because the directory is not a git tree on Lucas's machine.
- **Risk:** `gstack-upgrade` overwrites it on the next refresh; the §4.9 prose is lost from the on-disk skill but still preserved in this repo's `docs/postmortems/2026-06-issue-44-misdiagnosis.md` + `docs/CHANGELOG.md` (v0.5.9) + the PR #52 description.
- **Resolution options (defer to user):**
  1. Put `~/.claude/skills/staffreview/` under git (per-host or shared) so the §4.9 edit can be committed and survives upgrades.
  2. Submit §4.9 upstream to wherever the staffreview skill is canonically maintained.
  3. Accept the risk; re-apply §4.9 from this repo's postmortem after future `gstack-upgrade` runs.
- **No code action in v0.5.9.**

## How to use this tracker

**After v1 feature dev is complete and the relevant UI flows are settled:**

1. Read each spec's SKIP comment (source of truth for the observed failure mode).
2. Pick ONE gap to verify at a time — start with `#53` (Xendit) since it unblocks 4 specs at once.
3. Follow the spec's "evidence path" line to the PR-52 CI artifact (still in `.claude/pw-report/` or downloadable from GitHub Actions).
4. Run the spec locally with `npx playwright test --headed` against `npm run dev` + `npx convex dev` to reproduce.
5. Diagnose. Apply the smallest possible fix to either the spec body, the src component, or the seed action. **If the fix is a timing change / warm-up / retry**, downgrade your description from "fix" to "mitigation" and open a separate issue to track the real fix (per staffreview skill §4.9).
6. Un-skip the spec in the same PR as the fix. Delete the three-field SKIP comment when the spec body is verified working.
7. Cross off the row in the Index table above.

When the Index table is empty, delete this file and close out the gap-tracking story.
