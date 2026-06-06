import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

test("QRIS sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 1 ?pc/i }).click();
  await page.getByRole("button", { name: /Add Dubai 1 ?pc/i }).click(); // qty 2

  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("tab", { name: /QRIS/i }).click();
  // QR rendered as <canvas> or SVG
  await expect(page.locator("canvas, svg").first()).toBeVisible({ timeout: 10_000 });

  // data-qr-id is exposed on the QR wrapper div at src/routes/sale/charge.tsx:520-524
  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("qrId not exposed on the page — add data-qr-id to the QR element");

  // 2 × Dubai 1pc @ 45k = 90k IDR per seed (convex/seed/internal.ts:102)
  await simulateQrisPaid(qrId, 90_000);

  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Paid/i)).toBeVisible();
});
