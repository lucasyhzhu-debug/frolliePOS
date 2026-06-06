import { test, expect } from "../fixtures";
import { simulateBcaVaPaid } from "../helpers/xendit-simulate";

test("BCA VA sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 3 ?pcs/i }).click();
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("tab", { name: /BCA VA/i }).click();

  // Wait for the VA number to render — the data-external-id attribute is
  // attached to the VA number element (charge.tsx:549-558). This avoids the
  // strict-mode ambiguity of `getByText(/Virtual Account|VA/i)` which matches
  // both the active tab text ("BCA VA") and the "Generating VA number…" content.
  const extIdLocator = page.locator("[data-external-id]").first();
  await extIdLocator.waitFor({ timeout: 15_000 });
  const extId = await extIdLocator.getAttribute("data-external-id");
  if (!extId) throw new Error("external-id not exposed — add data-external-id to the VA element");

  // Dubai 3 pcs @ 125k IDR per seed (convex/seed/internal.ts:103)
  await simulateBcaVaPaid(extId, 125_000);
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
});
