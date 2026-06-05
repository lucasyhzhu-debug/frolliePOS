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
 * Wait for login to fully settle: post-login heading appears AND the URL is no
 * longer /login AND Convex's session-validation query has fired (networkidle).
 * Without this, the heading can flash during a transitional render while the
 * session is still "loading" — the test then navigates away and the next page
 * load sees a stale session→none redirect back to /login. Belt-and-braces
 * because the symptom (every signedIn*-fixture spec lands on the staff picker
 * after page.goto) is hard to reproduce locally but persistent in CI.
 */
async function awaitSignedIn(page: Page, staffName: string): Promise<void> {
  await page.getByRole("heading", { name: new RegExp(`Frollie · ${staffName}`, "i") }).waitFor({ timeout: 10_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 });
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
