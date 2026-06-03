import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

test("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
  // 1. Paid sale
  await page.goto("/sale");
  await page.getByRole("button", { name: /Dubai 1pc/i }).click();
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("button", { name: /QRIS/i }).click();
  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("no qrId");
  await simulateQrisPaid(qrId, 5_000); // CONFIRM
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });

  // 2. Open via history; trigger refund
  await page.goto("/history");
  await page.getByText(/R-\d{4}-\d{4}/).first().click();
  await page.getByRole("button", { name: /Refund/i }).click();
  await page.getByLabel(/qty|Quantity/i).first().fill("1");
  await page.getByLabel(/Reason/i).fill("E2E test refund");
  await page.getByRole("button", { name: /Confirm refund/i }).click();
  for (const d of "9999") await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByText(/Refunded/i)).toBeVisible({ timeout: 10_000 });
});
