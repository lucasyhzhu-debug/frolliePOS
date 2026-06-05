import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

// SKIPPED: session-loss-on-hard-nav (see refund.spec.ts for full context).
// Business logic covered by convex/vouchers/__tests__.
test.skip("voucher (online): mgr creates → staff applies → paid → redemption visible", async ({ signedInAsLucas: page }) => {
  // 1. Manager creates voucher
  await page.goto("/mgr/vouchers");
  await page.getByLabel(/Code/i).fill("E2E10");
  await page.getByLabel(/Type/i).click();
  await page.getByRole("option", { name: /Percentage/i }).click();
  await page.getByLabel(/^Value/i).fill("10");
  await page.getByRole("button", { name: /Create \(PIN\)/i }).click();
  for (const d of "9999") await page.getByLabel(`Digit ${d}`).click();
  await expect(page.getByText(/E2E10/)).toBeVisible();

  // 2. Apply at sale
  await page.goto("/sale");
  await page.getByRole("button", { name: /Dubai 1pc/i }).click();
  await page.getByRole("link", { name: /voucher/i }).click();
  await page.getByPlaceholder(/voucher code/i).fill("E2E10");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await page.waitForURL(/\/sale$/);

  // 3. Charge + simulate
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("button", { name: /QRIS/i }).click();
  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("no qrId");
  await simulateQrisPaid(qrId, 4_500); // 5k - 10% = 4.5k; CONFIRM
  await expect(page.getByText(/Paid/i)).toBeVisible({ timeout: 15_000 });

  // 4. Verify redemption in mgr drawer
  await page.goto("/mgr/vouchers");
  await page.getByRole("button", { name: /History/i }).first().click();
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible();
});
