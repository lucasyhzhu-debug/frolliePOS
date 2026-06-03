import { test, expect } from "../fixtures";
import { simulateBcaVaPaid } from "../helpers/xendit-simulate";

test("BCA VA sale: cart → charge → simulate → paid receipt", async ({ signedInAsLucas: page }) => {
  await page.goto("/sale");
  await page.getByRole("button", { name: /Dubai 3pcs/i }).click();
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("button", { name: /BCA/i }).click();
  await expect(page.getByText(/Virtual Account|VA/i)).toBeVisible();

  const extId = await page.locator("[data-external-id]").first().getAttribute("data-external-id");
  if (!extId) throw new Error("external-id not exposed — add data-external-id to the VA element");

  await simulateBcaVaPaid(extId, 25_000); // placeholder; CONFIRM
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });
});
