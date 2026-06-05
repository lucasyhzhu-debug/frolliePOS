import { test as base, type Page } from "@playwright/test";
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

export const test = base.extend<Fixtures>({
  signedInAsLucas: async ({ page }, use) => {
    execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
    await page.goto("/");
    await page.getByRole("button", { name: /Lucas/i }).click();
    await enterPin(page, "9999");                                    // real manager PIN per seed
    // login.tsx navigates to "/" on success; RootLayout renders the home dashboard there.
    // Wait for the post-login home heading instead of asserting a URL pattern.
    await page.getByRole("heading", { name: /Frollie · Lucas/i }).waitFor({ timeout: 10_000 });
    await use(page);
  },

  signedInAsStaff: async ({ page }, use) => {
    execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
    await page.goto("/");
    await page.getByRole("button", { name: /Bayu/i }).click();       // first seed-staff
    await enterPin(page, "0000");                                    // real staff PIN per seed
    await page.getByRole("heading", { name: /Frollie · Bayu/i }).waitFor({ timeout: 10_000 });
    await use(page);
  },
});

export { expect } from "@playwright/test";
