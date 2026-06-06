import { test, expect } from "../fixtures";

// SKIPPED: voucher-offline spec body's execSync calls have unresolved <TBD>
// tokens for sessionId and voucherId (lines below). The seed action
// `convex/seed/actions.ts::reset` returns `{wiped, inserted}` only — it does
// not emit stable test IDs for the voucher created mid-spec or for Lucas's
// manager session. The attempted concurrent-archive step (the whole point of
// the spec — racing an offline apply against a manager archive) cannot run
// without those IDs.
//
// Observed failure mode (from PR #48 instrumentation, 2026-06-06): when un-skipped
// without seed-side changes, the execSync call would either (a) throw on
// `<TBD>` arg-parse and be swallowed by the existing try/catch (false-green),
// or (b) need manual ID injection per-run which defeats the purpose of CI.
//
// Evidence path: docs/postmortems/2026-06-issue-44-misdiagnosis.md
// (PR-#48 instrumentation; convex/seed/actions.ts:21-55 return signature).
//
// Follow-up issue: open at PR-open time — title: "seed/actions:reset should
// expose stable test IDs (manager session + first voucher) for offline e2e".
// Until that ships, ADR-009 offline-voucher rejection is covered by
// convex/vouchers/__tests__/* unit tests, not e2e.
test.skip("voucher (offline): apply → mgr expires → reconnect → ADR-009 reject banner", async ({ signedInAsLucas: page }) => {
  // Intentionally empty body. The previous body had <TBD> tokens inside a
  // silent try/catch that made un-skipping produce false-green CI. Body is
  // deleted to make the SKIP unambiguous — re-add once seed exposes IDs.
  expect(page).toBeTruthy();
});
