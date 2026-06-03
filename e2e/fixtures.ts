import { test as base, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

type Fixtures = {
  signedInAsLucas: Page;
  signedInAsStaff: Page;
};

async function enterPin(page: Page, pin: string): Promise<void> {
  for (const digit of pin) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

export const test = base.extend<Fixtures>({
  signedInAsLucas: async ({ page }, use) => {
    execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
    await page.goto("/");
    await page.getByRole("button", { name: /Lucas/i }).click();
    await enterPin(page, "9999");                                    // real manager PIN per seed
    // Lucas is a manager — RootLayout may land on /mgr or /home depending on role-routing.
    // Accept either to keep the fixture forgiving.
    await page.waitForURL(/\/(mgr|home|sale)/, { timeout: 10_000 });
    await use(page);
  },

  signedInAsStaff: async ({ page }, use) => {
    execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
    await page.goto("/");
    await page.getByRole("button", { name: /Bayu/i }).click();       // first seed-staff
    await enterPin(page, "0000");                                    // real staff PIN per seed
    await page.waitForURL(/\/(home|sale)/, { timeout: 10_000 });
    await use(page);
  },
});

export { expect } from "@playwright/test";
