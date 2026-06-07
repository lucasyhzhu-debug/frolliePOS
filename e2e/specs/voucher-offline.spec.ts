import { test, expect } from "../fixtures";
import { execSync } from "node:child_process";

// Un-skipped in v0.6.1 — seed now emits stable test IDs (C2); see docs/postmortems/2026-06-issue-43-e2e-skip-triage.md.
//
// The seed (`convex/seed/actions.ts::reset`) pre-creates an active manager
// session for Lucas + an OFFLINE10 voucher. The `signedInAsLucas` fixture runs
// reset to sign in; this spec then READS the stable IDs via the dev-only
// `seed/internal:_e2eFixtureIds_internal` query (NOT a second reset, which would
// wipe staff_sessions and log the page out). Those IDs drive a manager
// archiveVoucher (via the Convex CLI) racing an offline-applied voucher, then
// the spec asserts ADR-009's server-revalidates-on-sync reject banner on charge.
test("voucher (offline): apply → mgr archives → reconnect → ADR-009 reject banner", async ({
  signedInAsLucas: page,
}) => {
  // This spec does two out-of-process `npx convex run` CLI calls (ID read +
  // archive) plus an offline→online cycle, which exceeds the 30s default.
  test.setTimeout(60_000);
  // Read the IDs the fixture's reset already seeded. `npx convex run` prints the
  // query return value as JSON on stdout. A missing/undefined ID throws LOUDLY
  // below (no fallback) so a seed regression fails this spec rather than
  // silently passing; the query itself also throws if the rows are absent.
  const raw = execSync("npx convex run seed/internal:_e2eFixtureIds_internal", {
    encoding: "utf8",
    timeout: 30_000,
  });
  const seed = JSON.parse(raw) as {
    managerSessionId?: string;
    voucherId?: string;
    voucherCode?: string;
  };
  const { managerSessionId, voucherId, voucherCode } = seed;
  // Fail loudly on absent IDs — these are the whole point of C2.
  expect(managerSessionId, "seed must emit managerSessionId").toBeTruthy();
  expect(voucherId, "seed must emit voucherId").toBeTruthy();
  expect(voucherCode, "seed must emit voucherCode").toBe("OFFLINE10");

  // 1. Hydrate catalog cache (incl. the OFFLINE10 voucher) by visiting /sale
  //    online and adding a product so the cart has a chargeable line.
  await page.goto("/sale");
  await page.getByRole("button", { name: /Dubai.*1 pc/i }).first().click();
  // Let useCatalogCache write the snapshot (products + vouchers) to IDB.
  await page.waitForTimeout(1_000);

  // 2. Navigate to the voucher route WHILE ONLINE (the Vite dev server has no
  //    offline app-shell, so a hard nav while offline would ERR_INTERNET_-
  //    DISCONNECTED — the PWA SW only serves the shell in a real build). Then go
  //    offline so the live validateVoucher query is undefined and the UI falls
  //    back to the cached catalog snapshot (the path under test).
  await page.goto("/sale/voucher");
  await page.getByLabel(/Voucher code/i).waitFor({ timeout: 5_000 });
  await page.context().setOffline(true);
  await page.getByLabel(/Voucher code/i).fill(voucherCode!);
  await expect(page.getByText(/applying from cached list/i)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/^Valid$/)).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: /^Apply$/ }).click();
  await expect(page).toHaveURL(/\/sale$/, { timeout: 5_000 });

  // 3. Manager archives the voucher out-of-band via the Convex CLI, using the
  //    seeded stable manager session + voucher IDs. This is the "race" — the
  //    cart already has the (now-stale) voucher applied locally while the POS
  //    page is offline.
  execSync(
    `npx convex run vouchers/public:archiveVoucher "{\\"idempotencyKey\\":\\"e2e-archive-${Date.now()}\\",\\"sessionId\\":\\"${managerSessionId}\\",\\"voucherId\\":\\"${voucherId}\\"}"`,
    { stdio: "inherit", timeout: 30_000 },
  );

  // 4. Reconnect and reload so the session + catalog queries re-resolve cleanly
  //    after the offline window (the cart line + applied voucher are persisted
  //    in sessionStorage, so they survive the reload). Then charge — commitCart
  //    re-validates server-side. The voucher is now inactive, so V8 commits at
  //    full price and returns voucher_rejected, which the charge screen surfaces
  //    as the ADR-009 advisory banner.
  await page.context().setOffline(false);
  await page.reload();
  const charge = page.getByRole("button", { name: /^Charge$/ });
  await charge.waitFor({ state: "visible", timeout: 15_000 });
  await expect(charge).toBeEnabled({ timeout: 10_000 });
  await charge.click();

  // 5. Assert the reject banner. INACTIVE copy = "is no longer active".
  const banner = page.getByRole("alert");
  await expect(banner).toContainText(/no longer active/i, { timeout: 10_000 });
  await expect(banner).toContainText(voucherCode!);
});
