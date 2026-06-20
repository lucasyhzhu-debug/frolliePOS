import { test, expect } from "../fixtures";
import { simulateQrisPaid } from "../helpers/xendit-simulate";

// Un-skipped in v0.6.1 — see docs/postmortems/2026-06-issue-43-e2e-skip-triage.md.
test("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
  // 1. Paid sale
  await page.goto("/sale");
  await page.getByRole("button", { name: /Add Dubai 1 ?pc/i }).click();
  await page.getByRole("button", { name: /Charge/i }).click();
  await page.getByRole("tab", { name: /QRIS/i }).click();
  const qrId = await page.locator("[data-qr-id]").first().getAttribute("data-qr-id");
  if (!qrId) throw new Error("no qrId");
  await simulateQrisPaid(qrId, 45_000); // 1 × Dubai 1pc @ 45k IDR per seed
  await expect(page.getByText(/R-\d{4}-\d{4}/)).toBeVisible({ timeout: 15_000 });

  // 2. Open via history; the Refund button navigates to /refund/:txnId
  // (src/routes/history/$txnId.tsx:259 — data-testid="history-refund").
  // Stale-expectation fix: the history list rows do NOT render the receipt
  // number — each row shows the total + time + staff and links to
  // /history/:txnId (src/routes/history/index.tsx:97,105-108). Click the
  // first list row (a <Link>) rather than receipt-number text.
  await page.goto("/history");
  await page.getByTestId("history-list").getByRole("link").first().click();
  await page.getByTestId("history-refund").click();
  await page.waitForURL(/\/refund\//);
  // Capture the txnId from /refund/:txnId so we can re-open the history detail
  // after the refund commits and assert the persisted refund-status badge.
  const txnId = page.url().match(/\/refund\/([^/?#]+)/)?.[1];
  if (!txnId) throw new Error("no txnId in /refund URL");

  // 3. On /refund/:txnId — per-line stepper, reason textarea, then the
  //    manager-picker → PIN-sheet inline flow (src/routes/refund/detail.tsx).
  //    Stale-expectation rewrite: the original spec assumed an inline-on-history
  //    refund with getByLabel("qty"/"Reason") + a "Confirm refund" button and a
  //    "Refunded" badge. The real UI is a dedicated route: the qty input is
  //    aria-label "Refund quantity for <product>" (RefundLineSelector.tsx:41),
  //    the reason is data-testid="refund-reason" (detail.tsx:370), the submit is
  //    data-testid="refund-submit-inline" labelled "Refund with manager PIN"
  //    (detail.tsx:396,400), which opens the ManagerPickerOverlay
  //    (data-testid="pick-manager-<code>") then the "Confirm refund" PinSheet
  //    (detail.tsx:434). On success it toasts "Refund committed" and navigates
  //    back to /refund (detail.tsx:198,204).
  await page.getByLabel(/Refund quantity for/i).first().fill("1");
  await page.getByTestId("refund-reason").fill("E2E test refund");
  // Guard: canSubmit needs qty>0 AND non-empty reason. A non-firing onChange
  // would leave this disabled, making .click() a silent no-op — assert ENABLED
  // so the flow fails loudly instead.
  await expect(page.getByTestId("refund-submit-inline")).toBeEnabled();
  await page.getByTestId("refund-submit-inline").click();
  // Manager picker — Lucas is the sole seeded manager (S-0005 per seed).
  await page.getByTestId("manager-picker").waitFor({ timeout: 10_000 });
  await page.getByTestId(/^pick-manager-/).first().click();
  for (const d of "9999") await page.getByLabel(`Digit ${d}`).click();
  // Success: navigates back to the refundable list at /refund.
  await page.waitForURL(/\/refund$/, { timeout: 15_000 });

  // Prove the refund actually COMMITTED (not just navigation): re-open the
  // transaction detail and assert the persisted refund-status badge flipped to
  // the full-refund label. This is a 1-item / 1-qty FULL refund, so
  // refundStatus() returns "full" → REFUND_BADGE.full.labelKey ===
  // "history.badgeRefunded". The badge is now locale-driven (ADR-049); the
  // pre-login / default-staff locale is "en" (CLAUDE.md #24), so it renders
  // "REFUNDED" (was the hardcoded Indonesian "DIKEMBALIKAN" before i18n).
  // The txn drops off the /refund refundable list, so we assert against the
  // detail badge rather than the list.
  // Exact match: "PARTIALLY REFUNDED" (partial) also contains "REFUNDED", so
  // assert the precise full-refund label to distinguish full from partial.
  await page.goto(`/history/${txnId}`);
  await expect(page.getByTestId("history-refund-status")).toHaveText(/^REFUNDED$/i);
});
