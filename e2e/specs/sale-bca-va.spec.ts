import { test, expect } from "../fixtures";
import { simulateBcaVaPaid } from "../helpers/xendit-simulate";

// SKIPPED: Xendit BCA VA simulate endpoint returns 404
// CALLBACK_VIRTUAL_ACCOUNT_NOT_FOUND_ERROR ("item does not exist") when
// called with `data-external-id` value sourced from charge.tsx:549-558. Slice
// 1 a11y fixes successfully unblocked the catalog click + tab role + VA
// number rendering — the spec now reaches the simulate helper, which is
// where it fails. Same root-cause family as sale-qris.spec.ts (Xendit test-
// mode endpoint shape vs the stored reference_id / external_id we publish).
//
// Observed failure mode (Gate 2 of PR #52, Playwright run `27055135440`):
//   "simulateBcaVaPaid failed: 404 {\"error_code\":\"CALLBACK_VIRTUAL_
//    ACCOUNT_NOT_FOUND_ERROR\",\"message\":\"item does not exist\"}"
//   at e2e/helpers/xendit-simulate.ts:37 from spec line ~20.
//
// Evidence path: docs/postmortems/2026-06-issue-44-misdiagnosis.md +
//   GitHub Actions run 27055135440 → sale-bca-va error-context.
//
// Follow-up issue: open at PR-open time — same as sale-qris ("Xendit test-mode
// simulate 404 — investigate stored id vs endpoint expected id for both QRIS
// and BCA VA"). Until that ships, BCA VA payment is covered by
// convex/payments/__tests__ unit tests (FVA callback parsing + signature +
// idempotency).
test.skip("BCA VA sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 3 ?pcs/i }).click();
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("tab", { name: /BCA VA/i }).click();

  const extIdLocator = page.locator("[data-external-id]").first();
  await extIdLocator.waitFor({ timeout: 15_000 });
  const extId = await extIdLocator.getAttribute("data-external-id");
  if (!extId) throw new Error("external-id not exposed — add data-external-id to the VA element");

  // Dubai 3 pcs @ 125k IDR per seed (convex/seed/internal.ts:103)
  await simulateBcaVaPaid(extId, 125_000);
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
});
