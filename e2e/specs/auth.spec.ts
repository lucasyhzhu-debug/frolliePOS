import { test, expect } from "../fixtures";

test.describe("auth", () => {
  test("sign-in happy path lands post-login", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Lucas/i })).toBeVisible();
    await page.getByRole("button", { name: /Lucas/i }).click();
    for (const d of "9999") await page.getByRole("button", { name: d, exact: true }).click();
    await expect(page).toHaveURL(/\/(mgr|home|sale)/);
  });

  test("3 wrong PINs trigger 60s lockout", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Lucas/i }).click();
    for (let i = 0; i < 3; i++) {
      for (const d of "1234") await page.getByRole("button", { name: d, exact: true }).click();
      // Either an inline error or a transition to lockout UI — accept either signal.
      await page.waitForTimeout(500);
    }
    await expect(page.getByText(/locked|LOCKED_OUT/i)).toBeVisible({ timeout: 5_000 });
  });
});
