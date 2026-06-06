import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

test("voucher (online): mgr creates → staff applies → paid → redemption visible", async ({ signedInAsLucas: page }) => {
  // 1. Manager creates voucher
  await page.goto("/mgr/vouchers");
  await page.getByLabel(/Code/i).fill("E2E10");
  // Pre-authorized fallback selector (plan Task 0): Radix label-click forwarding
  // via htmlFor can vary by version; getByRole("combobox", { name }) resolves
  // unambiguously now that Task 4 wired htmlFor=new-voucher-type ↔ SelectTrigger id.
  await page.getByRole("combobox", { name: /Type/i }).click();
  await page.getByRole("option", { name: /Percentage/i }).click();
  await page.getByLabel(/^Value/i).fill("10");
  await page.getByRole("button", { name: /Create \(PIN\)/i }).click();
  for (const d of "9999") await page.getByLabel(`Digit ${d}`).click();
  await expect(page.getByText(/E2E10/)).toBeVisible();

  // 2. Apply at sale
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 1 ?pc/i }).click();
  await page.getByRole("link", { name: /voucher/i }).click();
  await page.getByPlaceholder(/voucher code/i).fill("E2E10");
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await page.waitForURL(/\/sale$/);

  // 3. Charge + simulate
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("tab", { name: /QRIS/i }).click();
  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("no qrId");
  // Dubai 1pc @ 45k - 10% = 40.5k IDR
  await simulateQrisPaid(qrId, 40_500);
  await expect(page.getByText(/Paid/i)).toBeVisible({ timeout: 15_000 });

  // 4. Verify redemption in mgr drawer
  await page.goto("/mgr/vouchers");
  await page.getByRole("button", { name: /History/i }).first().click();
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible();
});
