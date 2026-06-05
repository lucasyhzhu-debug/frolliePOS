import { test, expect } from "../fixtures";

test.describe("auth", () => {
  test("sign-in happy path lands post-login", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Lucas/i })).toBeVisible();
    await page.getByRole("button", { name: /Lucas/i }).click();
    for (const d of "9999") await page.getByLabel(`Digit ${d}`).click();
    await expect(page).toHaveURL(/\/(mgr|home|sale)/);
  });

  // Targets Bayu (staff, PIN 0000) — NOT Lucas — so the manager account stays
  // unlocked for live booth use while CI runs. seed:reset wipes pos_auth_attempts
  // before any subsequent spec, so Bayu's lockout doesn't cross-pollute either.
  test("3 wrong PINs trigger 60s lockout", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Bayu/i }).click();
    for (let i = 0; i < 3; i++) {
      for (const d of "1234") await page.getByLabel(`Digit ${d}`).click();
      // Either an inline error or a transition to lockout UI — accept either signal.
      await page.waitForTimeout(500);
    }
    await expect(page.getByText(/locked|LOCKED_OUT/i)).toBeVisible({ timeout: 5_000 });
  });
});
