import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

test("QRIS sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  // TEMP issue #44: bridge browser console.warn → Playwright stdout to verify
  // the [useSession#44] transient-null hypothesis. Stripped in Step 5.
  page.on("console", (msg) => {
    const txt = msg.text();
    if (txt.includes("[useSession#44]")) {
      console.log(`PW>>> ${txt}`);
    }
  });
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
