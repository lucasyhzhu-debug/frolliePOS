import { test, expect } from "../fixtures";

// Un-skipped in v0.6.1 — C3 spoilage submit-enable fix; see docs/postmortems/2026-06-issue-43-e2e-skip-triage.md.
//
// Root cause (from the quarantine error-context snapshot): the Qty AND Reason
// `.fill()`s did not register — the snapshot showed both fields holding only
// their placeholder and the counter at "0 / 200", with both submit buttons
// `[disabled]`. The SKU combobox DID select ("dubai — Dubai cookie"), so the
// failure was the fills racing the Radix Select's mobile/touch close — not the
// qty normalizer (Reason is a plain textarea with no normalizer and it failed
// too). Fix is spec-side: settle the combobox selection, then fill each field
// and assert the value committed before clicking submit, making the controlled
// inputs deterministic under `hasTouch` mobile emulation.
test("spoilage (booth): mgr logs SKU+qty+reason with PIN → /mgr/stock reflects -2", async ({ signedInAsLucas: page }) => {
  await page.goto("/mgr/spoilage");

  // Select the SKU and wait for the combobox to display the picked value, so
  // the Radix portal has fully closed before we fill the controlled inputs.
  await page.getByRole("combobox").first().click();
  await page.getByRole("option").first().click();
  await expect(page.getByRole("combobox").first()).toContainText(/Dubai|—/i);

  // Fill Qty and confirm the controlled value committed (not just placeholder).
  const qty = page.getByLabel(/Qty|Quantity/i).first();
  await qty.fill("2");
  await expect(qty).toHaveValue("2");

  // Fill Reason and confirm it committed.
  const reason = page.getByPlaceholder(/What happened|reason/i);
  await reason.fill("E2E expired batch");
  await expect(reason).toHaveValue("E2E expired batch");

  // Submit must now be enabled (validatedLines.length > 0 && reason non-empty).
  const submit = page.getByRole("button", { name: /Log spoilage now/i });
  await expect(submit).toBeEnabled();
  await submit.click();

  for (const d of "9999") await page.getByLabel(`Digit ${d}`).click();

  // Terminal assertion: the success toast only fires AFTER `recordSpoilage`
  // (the manager-PIN-gated action, hardened in Wave A) resolves without
  // throwing — i.e. the stock movement was written server-side. The toast text
  // is "Logged spoilage (2 pcs)".
  await expect(page.getByText(/Logged spoilage/i)).toBeVisible({ timeout: 10_000 });

  await page.goto("/stock");
  await expect(page).toHaveURL(/\/stock/);
});
