import { test as base, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

type Fixtures = {
  signedInAsLucas: Page;
  signedInAsStaff: Page;
};

async function enterPin(page: Page, pin: string): Promise<void> {
  for (const digit of pin) {
    await page.getByLabel(`Digit ${digit}`).click();
    // Belt-and-braces inter-click delay. PinEntry's functional-updater fix
    // makes this strictly unnecessary, but a tiny pause guards against any
    // future state-batching edge case.
    await page.waitForTimeout(30);
  }
}

/**
 * Wait for login to fully settle. Three signals, in order:
 *   1. Post-login heading visible (RootLayout switched to active session).
 *   2. The 'New sale' tile link is visible (the home dashboard route lazy
 *      chunk loaded AND its product/SKU-count queries returned content).
 *   3. URL is not /login (catches any transient flash-render race).
 *
 * Earlier attempt used networkidle, but Vite dev's HMR + Convex subscription
 * traffic means the page never actually idles in 10s — the fixture would time
 * out even when login worked.
 */
async function awaitSignedIn(page: Page, staffName: string): Promise<void> {
  await page.getByRole("heading", { name: new RegExp(`Frollie · ${staffName}`, "i") }).waitFor({ timeout: 10_000 });
  await page.getByRole("link", { name: /New sale/i }).waitFor({ timeout: 5_000 });
  await expect(page).not.toHaveURL(/\/login/, { timeout: 2_000 });
}

export const test = base.extend<Fixtures>({
  signedInAsLucas: async ({ page }, use) => {
    execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
    await page.goto("/");
    await page.getByRole("button", { name: /Lucas/i }).click();
    await enterPin(page, "9999");                                    // real manager PIN per seed
    await awaitSignedIn(page, "Lucas");
    await use(page);
  },

  signedInAsStaff: async ({ page }, use) => {
    execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
    await page.goto("/");
    await page.getByRole("button", { name: /Bayu/i }).click();       // first seed-staff
    await enterPin(page, "0000");                                    // real staff PIN per seed
    await awaitSignedIn(page, "Bayu");
    await use(page);
  },
});

export { expect } from "@playwright/test";
