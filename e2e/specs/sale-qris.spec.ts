import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

// Un-skipped in v0.6.1 — simulate needed api-version:2022-07-31 header (see docs/postmortems/2026-06-issue-43-e2e-skip-triage.md).
test("QRIS sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 1 ?pc/i }).click();
  await page.getByRole("button", { name: /Add Dubai 1 ?pc/i }).click(); // qty 2

  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("tab", { name: /QRIS/i }).click();
  await expect(page.locator("canvas, svg").first()).toBeVisible({ timeout: 10_000 });

  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("qrId not exposed on the page — add data-qr-id to the QR element");

  // 2 × Dubai 1pc @ 45k = 90k IDR per seed (convex/seed/internal.ts:102)
  await simulateQrisPaid(qrId, 90_000);

  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
  // Webhook-confirmed paid state renders "Payment confirmed" (charge-success.tsx).
  // The literal "Paid" only appears as a methodLabel fallback when confirmed_via is null.
  await expect(page.getByText(/Payment confirmed/i)).toBeVisible();
});
