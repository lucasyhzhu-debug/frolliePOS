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

  // The static account is shown; attestation gates the confirm button.
  const confirm = page.getByRole("button", { name: /Confirm payment/i });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(confirm).toBeEnabled();

  // Staff self-confirm → confirmManualBcaPayment commits + navigates to the receipt.
  await confirm.click();
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Payment confirmed/i)).toBeVisible();
  await expect(page.getByText(/Bank transfer \(manual\)/i)).toBeVisible();
});
