import { test, expect } from "../fixtures";

// v1.2 #10 — replaces sale-bca-va.spec.ts (the dynamic BCA VA tab was retired;
// QRIS is the sole Xendit method). The manual bank-transfer tender is staff
// self-confirm against the static company account — NO Xendit invoice/simulate.
test("Manual BCA sale: cart → charge → Bank transfer tab → attest → confirm → paid receipt", async ({
  signedInAsLucas: page,
}) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 3 ?pcs/i }).click();
  await page.getByRole("button", { name: /Charge/i }).click();

  // The "Bank transfer" tab renders only when manual-BCA is enabled (default true).
  await page.getByRole("tab", { name: /Bank transfer/i }).click();

  // Wait for the account to render (getManualBcaAccount resolved) before attesting,
  // so we don't race the query. The account NUMBER is env-dependent —
  // MANUAL_BCA_DEFAULTS falls back to MANUAL_BCA_ACCOUNT_NUMBER on the target
  // deployment ("0000000000" only when unset), so assert any digit-string
  // account paragraph rather than a literal value.
  await expect(page.getByText(/^\d{8,}$/)).toBeVisible({ timeout: 10_000 });

  // The static account is shown; attestation gates the confirm button.
  const confirm = page.getByRole("button", { name: /Confirm payment/i });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(confirm).toBeEnabled();

  // Staff self-confirm → confirmManualBcaPayment commits + navigates to the receipt.
  await confirm.click();
  await page.waitForURL(/\/success$/, { timeout: 15_000 });
  // v2.0: receipt numbers carry the outlet code — "R-PKW-2026-0001".
  await expect(page.getByText(/R-[A-Z]+-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Payment confirmed/i)).toBeVisible();
  await expect(page.getByText(/Bank transfer \(manual\)/i)).toBeVisible();
});
