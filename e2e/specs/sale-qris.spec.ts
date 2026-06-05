import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

// SKIPPED: session-loss-on-hard-nav (see refund.spec.ts for full context).
// Business logic covered by convex/payments/__tests__ + convex/transactions tests.
test.skip("QRIS sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Dubai 1pc/i }).click();
  await page.getByRole("button", { name: /Dubai 1pc/i }).click(); // qty 2

  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("button", { name: /QRIS/i }).click();
  // QR rendered as <canvas> or SVG
  await expect(page.locator("canvas, svg").first()).toBeVisible({ timeout: 10_000 });

  // qrId surfaced on a data attribute somewhere on the page — exact attribute
  // confirmed at task time. If charge.tsx doesn't expose it, this spec needs
  // a minor src change to add data-qr-id on the QR wrapper element.
  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("qrId not exposed on the page — add data-qr-id to the QR element");

  // Cart total: 2 × Dubai 1pc — verify against seed. If pricing changes, update.
  await simulateQrisPaid(qrId, 10_000); // placeholder amount; CONFIRM at run time

  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Paid/i)).toBeVisible();
});
