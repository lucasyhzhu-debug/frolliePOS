import { test, expect } from "../fixtures";

test.describe("auth", () => {
  test("sign-in happy path lands post-login", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Lucas/i })).toBeVisible();
    await page.getByRole("button", { name: /Lucas/i }).click();
    for (const d of "9999") await page.getByLabel(`Digit ${d}`).click();
    // login.tsx navigates to "/" on success; assert the home dashboard heading instead
    // of an URL pattern (post-login URL is "/", not "/mgr|/home|/sale").
    await expect(page.getByRole("heading", { name: /Frollie · Lucas/i })).toBeVisible({ timeout: 10_000 });
  });

  // Targets Bayu (staff, PIN 0000) — NOT Lucas — so the manager account stays
  // unlocked for live booth use while CI runs. seed:reset wipes pos_auth_attempts
  // before any subsequent spec, so Bayu's lockout doesn't cross-pollute either.
  test("3 wrong PINs trigger 60s lockout", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Bayu/i }).click();
    for (let i = 0; i < 3; i++) {
      for (const d of "1234") await page.getByLabel(`Digit ${d}`).click();
      // PinEntry guards `if (buffer.length >= 4) return` — the keypad ignores further
      // clicks until login.tsx bumps pinReset on error (which clears the buffer). If
      // we proceed before the server response lands, the next iteration's clicks get
      // swallowed and we never accumulate 3 fails. Wait for the error toast as proxy
      // for "PIN was processed and keypad has been reset" — iter 1 & 2 get "Wrong PIN",
      // iter 3 gets "Locked out…".
      await page.getByText(/Wrong PIN|Locked out/i).first().waitFor({ state: "visible", timeout: 5_000 });
      await page.waitForTimeout(200);
    }
    await expect(page.getByText(/Locked out/i)).toBeVisible({ timeout: 5_000 });
  });
});
