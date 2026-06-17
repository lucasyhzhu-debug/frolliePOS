# Launch-Day Ops Observability — Design Spec

**Date:** 2026-06-17
**Slug:** `v1.0.1-launch-ops-observability`
**Status:** Approved (brainstorm) → staffreview pending
**Driver:** Production booth runs start 2026-06-18. Need to (a) catch issues live and hot-fix them, and (b) see every sale land in real time. Lucas is **on-site** at the booth.

---

## Problem

Two gaps bite on a live run when there's no central visibility:

1. **Silent failures.** `RouteErrorBoundary` (`src/components/layout/RouteErrorBoundary.tsx`) catches frontend crashes and renders a friendly fallback — but reports the error **nowhere**. No Sentry, no client-error pipe, no failure alerting. Backend action/mutation failures only surface in the Convex prod Logs (manual check). So a broken screen or a silently-failed payment is invisible until a staffer phones Lucas.
2. **No live sales feed.** Sales confirm via webhook/manual override, but there's no at-a-glance "is the booth selling?" signal. Lucas wants every paid sale to appear in the Managers Telegram group as a ticker.

This phase closes both with the smallest robust slice that ships before 2026-06-18, plus a runbook section for the hot-fix loop.

---

## Scope

**In:**
1. `ops` Telegram role + dedicated alerts channel.
2. `convex/ops/` error-ingest httpAction + `pos_error_reports` table + dedup/storm-cap + `system_error` Telegram alert.
3. Frontend error reporting wired at four sites (global handlers, error boundary, payment path, sale mutation wrapper).
4. Backend error reporting on the payment charge action + Xendit webhook.
5. Live sales ticker → Managers group, hooked into `_confirmPaid_internal`, with a `pos_settings` opt-out toggle.
6. `docs/RUNBOOK.md §9` — live-run smoke checklist + sanctioned hot-fix protocol + rollback.

**Out (explicit YAGNI):**
- A custom `/mgr/ops` live dashboard. Lucas is on-site; Telegram push + Convex Logs cover one booth-day. Flagged as the obvious v-next.
- WhatsApp/other channels (Telegram only per ADR-035).
- Persisting/retrying error alerts on Telegram failure (fire-and-forget; an unreported crash costs one data point, an un-capped reporter costs a flooded channel).
- Aggregation/rollups of error reports beyond the raw table.

---

## Design

### 1. Transport decision — httpAction, not a public mutation

Business rule #20 (ESLint-enforced) forces every public mutation through `idempotencyKey + withIdempotency + authCheck`. An error reporter is precisely the thing that must fire **when auth/session is broken or absent** (pre-login crash, broken React tree). Fighting that invariant with an ESLint carve-out the night before launch is the wrong move.

An **httpAction** at `/ops/error` mirrors the existing `payments/webhook.ts` pattern exactly and sidesteps rule #20 cleanly. It is also **more robust** for error reporting: the frontend hits it with a plain `fetch()`, which has **no dependency on the (possibly-broken) Convex React client** that a crash may have taken down with it.

**Endpoint:** registered in `convex/http.ts` as `POST /ops/error` → handler from `convex/ops/http.ts`.

**Auth:** a low-assurance shared token. The frontend bakes `VITE_OPS_INGEST_TOKEN` into the bundle and sends it as a header (`x-ops-token`). This is **not a secret** (it's visible in shipped JS) — it only keeps random internet noise out of the table. The handler compares it (constant-time, reusing `convex/lib/constantTimeEqual.ts`) against the Convex env var `OPS_INGEST_TOKEN`. Mismatch/missing → return `204` (swallow silently; never reveal validity, never error). Always returns 2xx so the browser never retries or logs a network error to console.

> The `.cloud` vs `.site` split (CLAUDE.md / memory `convex-deployments`): httpActions live on `*.convex.site`, but the frontend's `VITE_CONVEX_URL` is `*.convex.cloud`. The frontend helper derives the endpoint by suffix-swap: `VITE_CONVEX_URL.replace(".convex.cloud", ".convex.site") + "/ops/error"`. A pure `opsEndpoint(convexUrl)` helper makes this unit-testable.

### 2. `convex/ops/` module

**`convex/ops/schema.ts`** — new table `pos_error_reports`:

```
pos_error_reports: defineTable({
  kind: v.union(
    v.literal("crash"),        // RouteErrorBoundary trip
    v.literal("unhandled"),    // window.onerror / unhandledrejection
    v.literal("payment"),      // payment-path failure (FE or BE)
    v.literal("mutation"),     // sale-flow mutation failure
    v.literal("backend"),      // BE action/webhook failure
  ),
  message: v.string(),          // truncated to MESSAGE_MAX (e.g. 500)
  stack: v.optional(v.string()),// truncated to STACK_MAX (e.g. 2000)
  route: v.optional(v.string()),// pathname at time of error
  staff_code: v.optional(v.string()),
  device_id: v.optional(v.string()),
  online: v.optional(v.boolean()),
  app_version: v.optional(v.string()),
  signature: v.string(),        // hash of (kind + route + normalized message) — dedup key
  alerted: v.boolean(),         // did this row trigger a Telegram send?
  created_at: v.number(),       // server time, ADR-031
})
  .index("by_signature_created", ["signature", "created_at"])
  .index("by_created", ["created_at"])
```

**`convex/ops/internal.ts`** — `_recordError_internal` (internalMutation):
- Computes `signature` = a stable hash (V8-safe; small FNV-1a or djb2 in `convex/ops/lib.ts` — **no `crypto.subtle` async** inside a mutation; a pure synchronous string hash is fine for a dedup key).
- **Dedup:** query `by_signature_created` for any row with the same signature within `DEDUP_WINDOW_MS` (5 min). If found → write the new row with `alerted: false`, skip the alert.
- **Storm cap:** find the most recent alerted row via `db.query("pos_error_reports").withIndex("by_created").order("desc").filter(q => q.eq(q.field("alerted"), true)).first()`; if its `created_at` is within `GLOBAL_ALERT_COOLDOWN_MS` (10 s) → write row with `alerted: false`, skip alert. (Fine at booth volume — the filter scans recent rows after the index. Scale follow-up: add a dedicated `by_alerted_created` index if the table grows large; noted so the scan isn't mistaken for O(1).)
- Otherwise insert the row with `alerted: true`, capture the inserted `reportId`, and `ctx.scheduler.runAfter(0, internal.ops.actions.sendErrorAlert, { reportId })`.
- Always returns void; never throws back to the httpAction (catch + best-effort).

**`convex/ops/actions.ts`** — `sendErrorAlert({ reportId })` (internalAction, no `"use node"`):
- Reads the `pos_error_reports` row by `reportId` (via an internal query) to build the payload.
- Resolves the `ops` chat id via `internal.telegram.chatRegistry.internal.getChatIdByRole` with the **same narrow-catch pattern** as `foundersSummary.ts`: missing-binding message → return `{ skipped: "role_unbound" }`; other errors rethrow.
- Calls `api.telegram.send.sendTemplate` with `kind: "system_error"`, `role: "ops"`, `chatIdOverride`, and `idempotencyKey: "ops_error:" + reportId`. Using the **row `_id`** (guaranteed unique per alert) keeps the key collision-proof and naturally re-alerts across windows — each window produces a new `alerted: true` row — with **no `Date.now()` bucketing math** in the action.
- Fire-and-forget semantics: wrapped so a send failure is audited (reuse `_auditSendFailed_internal` path inside `sendTemplate`) and does not propagate. No resilient-retry wrapper (an error alert is not worth a retry storm).

**`convex/ops/http.ts`** — `opsErrorRoute` (httpAction):
- Reads `x-ops-token`; constant-time compare to `process.env.OPS_INGEST_TOKEN`. Mismatch → `new Response(null, { status: 204 })`.
- Parses JSON body defensively (try/catch; malformed → 204). Truncates `message`/`stack`. Caps body size (reject > BODY_MAX bytes → 204).
- `ctx.runMutation(internal.ops.internal._recordError_internal, {...})`. Always `200`.

### 3. `system_error` Telegram template

- Add `"system_error"` to the `kind` union in `convex/telegram/send.ts` **and** the corresponding payload object (the union must stay exhaustive — the `switch` in `sendTemplate` has no `default`, so a new kind must add a `case`).
- Add `renderSystemError(payload)` to `convex/lib/telegramHtml.ts` — **informational, no URL button** (no inline keyboard). HTML-escaped via the existing helper. Shows kind, route, truncated message, staff/device, app version, WIB time.
- Payload object: `{ kind: string, message: string, route?: string, staff_code?: string, device_id?: string, app_version?: string, occurred_at: number }`.

### 4. `ops` Telegram role

- Add `"ops"` to `KNOWN_TELEGRAM_ROLES` in `convex/telegram/config.ts`. (The `/mgr/telegram-chats` admin UI imports this list, so `ops` becomes bindable in the existing UI — no FE change needed beyond the list growing.)
- Lucas binds a new **Frollie · Ops** group tonight via the existing self-registration flow (runbook §8 / `docs/RUNBOOK-telegram.md`).

### 5. Frontend error reporting

**`src/lib/reportOps.ts`** — pure-ish helper:
- `opsEndpoint(convexUrl: string): string` — suffix-swap, unit-tested.
- `reportOps(input: { kind, error, route?, ... }): void` — builds the payload (truncates client-side too), reads `__APP_VERSION__` (existing Vite define), `navigator.onLine`, current pathname, and the cached staff_code/device_id if available; fires `fetch(opsEndpoint(...), { method: "POST", headers, body, keepalive: true })`. **Never throws**, **never awaits** in a way that blocks UI; `.catch(() => {})`. `keepalive` so a report survives a navigation/reload.
- Dedup-on-client guard: a tiny in-memory `Set`/timestamp map to avoid hammering the endpoint when the same error fires in a tight loop (belt-and-suspenders to the server storm-cap).

**Wiring (4 sites):**
1. **Global** — `window.addEventListener("error", ...)` + `window.addEventListener("unhandledrejection", ...)`, installed once at app bootstrap (`src/pwa/` or `main.tsx`). Reports `kind: "unhandled"`. **Apply the same `isChunkLoadError` guard here as in the boundary** — global handlers also catch chunk-load failures (stale deploy/offline), and those are expected noise, not crashes.
2. **`RouteErrorBoundary`** — call `reportOps({ kind: "crash", ... })` **but skip `isChunkLoadError(error)`** (stale-deploy/offline chunk failures are expected and already handled by reload; reporting them is noise). Report only the genuine fallback path.
3. **Payment path** — the QR/VA creation failure catch (in `useXenditPayment` / the sale payment flow) reports `kind: "payment"`.
4. **Sale-flow mutation wrapper** — a thin helper so a thrown Convex mutation in the commit/confirm flow reports once (`kind: "mutation"`) before the existing toast. Keep it scoped to the sale flow; do not blanket-wrap every mutation.

> Source of `staff_code`/`device_id`: read from the existing session/device caches (`useSession`, `useDeviceId`, `storage-keys.ts`). These are best-effort context — absent before login, which is fine (optional fields).

### 6. Backend error reporting

- **Payment charge action** (`convex/payments/actions.ts` — `requestPayment` / `retryWithFreshInvoice`, Xendit QR/VA creation): on a caught failure, `ctx.runMutation(internal.ops.internal._recordError_internal, { kind: "payment", ... })` best-effort, then rethrow (reporting never masks/replaces the original error handling).
- **Xendit webhook** (`convex/payments/webhook.ts`): report **only genuine processing failures** on an *authenticated* callback (a parse/confirm exception). **Never report the `401`/bad-signature path** — that is internet bot-scanner noise and would flood the Ops channel. Reporting is wrapped so it cannot alter the returned status code (200 success, 401 bad token both preserved).

### 7. Live sales ticker

**Hook point:** end of `_confirmPaid_internal` (`convex/transactions/internal.ts`), after the `payment.confirmed` audit (line ~299). The line-162 guard (`if (txn.status === "paid") return`) guarantees the funnel body runs **exactly once** per sale, so the ticker fires once — no dedup table needed.

```
// after the audit, inside the awaiting_payment → paid branch only:
await ctx.scheduler.runAfter(0, internal.telegram.txnTicker.sendTxnTicker, {
  txnId: args.txnId,
});
```

**Why `scheduler.runAfter(0)` not inline:** the sale's atomicity must not depend on Telegram being up. A scheduled action runs in its own transaction; a Telegram failure cannot roll back a paid sale. Same rationale as `sendFoundersSummaryResilient` and CLAUDE.md #5.

**`convex/telegram/txnTicker.ts`** — `sendTxnTicker` (internalAction, no `"use node"`):
1. Read `_getSettings_internal`; if `txn_ticker_enabled === false` → **return `{ skipped: "disabled" }` silently (NO audit row)**. ⚠️ **Do NOT reuse the founders audit-skip pattern.** Founders runs once daily; the ticker runs once per sale (dozens–hundreds/day), so auditing every `disabled`/`role_unbound` skip would flood `audit_log`. Skip silently; audit **only** genuine send failures (already handled by `sendTemplate`'s `_auditSendFailed_internal`).
2. Resolve `managers` chat id (narrow-catch role_unbound pattern from `foundersSummary.ts`); on unbound → return `{ skipped: "role_unbound" }` silently (no audit, same reasoning).
3. Read the txn header via a small new `_getTxnForTicker_internal` query (receipt_number/total/staff_id) + its lines (`by_transaction` index) + staff name (`_listStaffNames_internal`). Instrument: **reuse the existing `_getPaidInvoiceForTxn_internal` query + pure `instrumentFromInvoice` helper** (`convex/payments/internal.ts`) — do NOT mint a new invoice-lookup query (memory `v053a-reporting`: this query was de-duped once already). Derive label: `confirmed_via === "manual"` → "Manual"; else `instrumentFromInvoice(inv)` → "QRIS"/"BCA VA"; `"unknown"` → "—".
4. Call `sendTemplate` with `kind: "txn_ticker"`, `role: "managers"`, `chatIdOverride`, `idempotencyKey: "ticker:" + txnId` (one ticker per txn, dedup-safe even if scheduled twice).
5. Send failure → audited by `sendTemplate` (`_auditSendFailed_internal`), swallowed by the caller (no retry storm).

**`txn_ticker` template** (add kind+payload to `sendTemplate`, `renderTxnTicker` in `telegramHtml.ts`, informational, no button):
```
🧾 #R-2026-0042 · Rp 320.000
3× Dubai Chewy Cookie Single
1× Mineral Water
Bayu · QRIS · 14:32
```
Payload: `{ receipt_number, total, lines: [{ name, qty }], staff_name, instrument, paid_at }`. Money via `Intl.NumberFormat("id-ID")` (ADR-015); time via WIB helper (`lib/time.ts`). `renderTxnTicker` truncates to the first `TICKER_MAX_LINES` (e.g. 6) items + `"…+N more"` so a large wholesale order doesn't post a wall of text.

**Notification noise:** ticker sends pass `disable_notification: true` so Managers get a **silent** running feed (not 100 buzzes/day); `system_error` alerts stay **loud** (default notification). This needs a small addition to `sendTemplate` — a per-kind or optional `silent` flag threaded into the Telegram `sendMessage` body. Keep it minimal: an optional `disableNotification?: boolean` arg on `sendTemplate`, set true only by the ticker caller.

**Channel choice:** Managers group, as requested. Tomorrow Lucas is on-site, so off-booth `/approve` flows (the only other thing in that channel) won't fire — the ticker won't bury approvals. Caveat noted for post-launch: a permanent ticker there would eventually drown a real approval button.

**Refunds:** ticker is **paid-sales only** for this slice. A refund ticker is a clean follow-up (same pattern, `_commitRefund_internal` hook) but out of scope for 2026-06-18 unless trivially cheap during implementation.

### 8. Settings toggle

Add to `convex/settings/schema.ts`: `txn_ticker_enabled: v.optional(v.boolean())`. **Optional + read-time default `true`** in `_getSettings_internal` (the existing prod `pos_settings` row predates this field; an optional field with a read default avoids a migration — same pattern as the `receipt_*` fields). Default true for launch; flippable off after via a manager-session settings write (reuse the existing settings-CRUD path; no new PIN gate — it's low-stakes config per CLAUDE.md #22).

### 9. Runbook — `docs/RUNBOOK.md §9` (Live-run ops & hot-fix)

- **Pre-run smoke checklist** (tonight + tomorrow AM): login; one real QRIS sale end-to-end → confirm ticker lands in Managers group; recount; trigger a deliberate test error → confirm it lands in Ops group; verify both Telegram roles bound.
- **What to watch:** Ops Telegram channel (push) + Convex prod Logs saved filter.
- **Hot-fix protocol — a *sanctioned* fast lane**, written down so it is an explicit, named deviation (not a silently-skipped step — per the user's instruction-adherence preference): branch → `npm run typecheck` + the single relevant test → deploy (Vercel for FE / `npx convex deploy` for BE) → verify on device → **open a follow-up issue to backfill the normal triple-review**.
- **Rollback:** Vercel instant-rollback (FE); `npx convex deploy` of the prior commit (BE).

---

## Env vars (new)

| Var | Where | Purpose |
|---|---|---|
| `OPS_INGEST_TOKEN` | Convex (dev + prod) | Validates `x-ops-token` on `/ops/error` |
| `VITE_OPS_INGEST_TOKEN` | Vercel + `.env.local` | Baked into bundle; sent as `x-ops-token` (low-assurance) |

Both must be set on **dev and prod** before the pipe works. Document in `docs/RUNBOOK.md §5`.

---

## Testing focus

The one part that can hurt: dedup + storm-cap logic. Tests:
- `convex/ops/lib.ts` signature hash — stable + collision-reasonable (pure, V8-safe).
- `_recordError_internal` — dedup within window suppresses alert; storm-cap suppresses alert; distinct signatures past cooldown alert.
- `opsEndpoint()` suffix-swap (`.cloud` → `.site`).
- `sendTxnTicker` — toggle off → skip; role_unbound → skip (narrow catch); instrument derivation; idempotency key shape.
- Ticker fires exactly once: `_confirmPaid_internal` re-fire (status already `paid`) does NOT schedule a second ticker.
- `renderSystemError` / `renderTxnTicker` HTML-escaping + no inline keyboard; `renderTxnTicker` line truncation past `TICKER_MAX_LINES`.
- **Ticker no-audit (guards Improvement 1):** `disabled` / `role_unbound` skip writes **zero** `audit_log` rows.
- **Webhook regression (guards Improvement 4):** adding BE reporting does NOT change returned status codes; the `401`/bad-token path does NOT call `_recordError_internal`.
- **Global chunk-load guard (guards Improvement 6):** `isChunkLoadError` suppresses report in `window.onerror`/`unhandledrejection`, not just the boundary.
- **Manual-confirm instrument:** `confirmed_via === "manual"` with no invoice → "Manual" label (no null crash).

Payment/stock/money paths require tests (CLAUDE.md "How to add a feature" #7); the ticker touches the payment funnel, so its hook is covered.

---

## Risks & mitigations

- **Alert storm during a crash loop** → server-side per-signature dedup (5 min) + global cooldown (10 s) + client-side in-memory guard. Load-bearing; tested.
- **Ticker burying approvals long-term** → settings toggle, default-on for launch only.
- **Telegram down** → both ticker and error alerts are fire-and-forget, audited-and-dropped (no retry storm), consistent with founders-summary. Booth selling is unaffected.
- **Token in bundle** → explicitly low-assurance; only spam prevention, never gating anything that moves money or data.
- **`.cloud`/`.site` mismatch** → `opsEndpoint()` helper, unit-tested.

---

## Touch-point summary (for the plan)

| Area | Files |
|---|---|
| Schema | `convex/ops/schema.ts` (new), `convex/settings/schema.ts` (+`txn_ticker_enabled`), `convex/schema.ts` (compose ops table) |
| Ops module | `convex/ops/{http,internal,actions,lib}.ts` (new) |
| HTTP routes | `convex/http.ts` (+`/ops/error`) |
| Telegram | `convex/telegram/config.ts` (+`ops` role), `convex/telegram/send.ts` (+`system_error`,`txn_ticker` kinds+payloads), `convex/lib/telegramHtml.ts` (+`renderSystemError`,`renderTxnTicker`), `convex/telegram/txnTicker.ts` (new) |
| Ticker hook | `convex/transactions/internal.ts` (`_confirmPaid_internal` tail), `convex/transactions/internal.ts` (`_getTxnForTicker_internal` query) |
| Settings | `convex/settings/internal.ts` (read-time default for `txn_ticker_enabled`) |
| Backend reporting | `convex/payments/actions.ts`, `convex/payments/webhook.ts` |
| Frontend | `src/lib/reportOps.ts` (new), `RouteErrorBoundary.tsx`, app bootstrap (`main.tsx`/`src/pwa/`), `useXenditPayment` + sale-flow mutation wrapper |
| Docs | `docs/RUNBOOK.md` (§9 + §5 env), `docs/SCHEMA.md` (new table + audit verbs), `docs/CHANGELOG.md` |
| Tests | `convex/ops/__tests__/`, `convex/telegram/__tests__/txnTicker.test.ts`, `src/lib/__tests__/reportOps.test.ts` |
