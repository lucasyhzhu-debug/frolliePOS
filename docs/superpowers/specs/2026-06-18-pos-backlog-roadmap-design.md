# Frollie POS — Post-launch Backlog Roadmap (v1.2 fixes + features)

**Date:** 2026-06-18
**Status:** Design approved — feeds per-phase `/spec-plan-pipeline` execution (one PR per phase).
**Source:** 13 items dumped by Lucas, investigated against the codebase by a 13-agent workflow (run `wf_499c926e-26c`).

## Locked decisions (from brainstorm)

1. **Design direction (#2):** Port the **full phthalo-dark canvas** from the original design system (`frollie-pos design files/lucas-frollie-design-system/.../colors_and_type.css`) — deep green `#102821` paper, warm off-white `#F1E9D8` ink, teal+citrus accents. **HARD GATE:** verify readability/glare on the real booth tablet under mall lighting (chrome-devtools-mcp `resize_page`/`emulate` + a physical check) **before** app-wide rollout. If it washes out, fall back to enriched-light with phthalo accents — but dark is the chosen default.
2. **Real refunds (#9):** **Spike first.** Ship #10 (static account) for the immediate need, then run the mandatory Task-0 Xendit live-API check on TEST keys, capture facts in `docs/xendit-reference/refunds-disbursements.md`, *then* scope the build. Do not build from doc assertions.
3. **i18n default (#1):** **English default**, Bahasa via toggle.
4. **Execution:** Phase-by-phase through Lucas's `spec → 2× staffreview → plan → staffreview → merge` pipeline. One PR per phase. This document is the master ordering; each phase gets its own SPEC/PLAN.
5. **Manual BCA confirm (#10):** **staff self-confirm, no manager-PIN, no in-app photo.** Staff tap "I confirm payment proof has been sent to the Block M staff WhatsApp group" → txn commits. Photo/WhatsApp is fully out-of-band (staff do it in WhatsApp). The **compensating control** is an **itemized** manual-BCA reconciliation summary (every manual-BCA txn of the shift + count + total IDR) sent at **staff clock-out (#6)** and **end-of-day** (founders-summary cron), validated against the real BCA account; **and** the per-sale `txn_ticker` message flags manual-BCA sales distinctly ("check the BCA account for the deposit"). Deviates from ADR-036's manager-PIN gate — documented in the amendment.

## Roadmap (dependency-ordered)

**Critical path:** 8 → 2 → 12 → 10 → 9.
**Quick wins (shippable almost immediately):** 8, 4, 13.

### Phase 0 — Unblock (ship first, standalone)
- **#8 — Modal off-screen (BLOCKER).** `effort: S · no deps · no ADR.`

### Phase 1 — Foundations (sequential; gate most UX work)
- **#2 — Phthalo-dark design system.** `XL · ADR · no deps.`
- **#12 — Contextual messaging over toasts.** `L · ADR · deps: #2.`

### Phase 2 — Quick UX polish (parallel where files differ)
- **#4 — Staff-home declutter.** `S · deps: #2.`
- **#13 — Receipt cleanup.** `M · deps: #2, #10.`
- **#11 + #7 — Login PIN feedback (one coordinated unit).** `M each · deps: #2, #12.`
- **#5 — Lock → top-left icon.** `S · deps: #2, #6.`

### Phase 3 — Payments + features
- **#10 — Retire BCA VA + static-account manual transfer.** `L · ADR (amends 036) · deps: #2, #12.`
- **#9 — Real Xendit refunds (spike-gated).** `XL · ADR-047 (supersedes 038) · deps: #10 + Task-0.`
- **#3 — Product photos + sale-grid title legibility.** `L · no ADR · deps: #2.` (Independent of payments — parallelizable. Includes the narrow-phone product-title truncation fix — see per-item detail.)
- **#6 — Handoff flow.** `L · no ADR · deps: #2, #4, #5, #12, #10.` Sign-off shows #10's manual-BCA tally → lands after/with #10.

### Phase 4 — i18n (last)
- **#1 — EN/ID toggle.** `XL · ADR · deps: #2.` Copy-extraction grunt-work may start in parallel earlier; toggle UI + wiring land last so they extract from copy-stable surfaces.

## Per-item detail

> Format: current state (grounded in code) · recommended approach · effort · deps · open decisions (with recommended defaults to confirm in the per-phase spec).

### #8 — Modal off-screen on Windows tablet Chrome (BUG, BLOCKER)
- **Root cause:** `DialogContent` (`src/components/ui/dialog.tsx:32-37`) is `fixed left-[50%] top-[50%] translate-x-[-50%] translate-y-[-50%]` with **no max-height and no `overflow-y-auto`**. Tallest offender is `PinSheet` (header + 4 dots + full keypad ≈ 480-560px); on a ~720px-tall tablet (less once Chrome chrome / on-screen keyboard eat height) the top + footer clip off-screen and become unclickable. Same mechanism for `PrinterSheet`. The refund-approval PIN the user saw off-screen is the **booth** `PinSheet` at `src/routes/refund/detail.tsx:432` (the off-booth `/approve` route is a full page, unaffected).
- **Secondary:** `dialog.tsx` references `animate-in/zoom-in-95/slide-in-from-*` but neither `tailwindcss-animate` nor `tw-animate-css` is installed — those classes are dead no-ops.
- **Fix:** single-file — add `max-h-[calc(100dvh-2rem)] overflow-y-auto` to `DialogContent` (consider a bottom-sheet layout `top-4 translate-y-0` on short heights for thumb-reachable keypad). Resolves PinSheet, PrinterSheet, and all mgr/refund PIN dialogs at once.
- **Files:** `src/components/ui/dialog.tsx`, `src/components/pos/PinSheet.tsx`, `src/index.css`, `package.json`.
- **Open decisions:** bottom-sheet vs scroll-capped centering (recommend bottom-sheet on short heights); install `tw-animate-css` to revive animations (couples with #2) vs strip; verify on real tablet viewport before declaring fixed (yes).

### #2 — Phthalo-dark design system (UX foundation)
- **Current state:** `src/index.css @theme` defines a full Frollie token set (`--color-frollie-50..950`, semantic, role, channel, station) but `frollie-*` is referenced **0 times** outside `index.css` — ~60 dead tokens. The shadcn `:root` is near-white (`--background: oklch(0.99 0 0)`) with teal only as `--primary`. Routes bypass tokens with raw Tailwind palette (`text-teal-600` ×9, `bg-amber-50`, etc.). The original DS is phthalo-**dark** by default; it was never ported. Highest-leverage bland surfaces: home tiles, sale product grid + cart, login/PIN, payment/charge.
- **Approach:** ADR pinning the dark direction (with the glare gate). Then: (1) rewrite `:root`/`.dark` shadcn vars to phthalo green/warm-ink from `colors_and_type.css`, **prune ~40 dead station/channel/role kitchen tokens** (no POS surface); (2) enrich Card/Button/Badge primitives (elevation, optional primary gradient, wire role badges) so the lift propagates via tokens; (3) replace raw-palette usages in home/sale/login/charge with semantic tokens; (4) redesign the 3 highest-leverage surfaces with real hierarchy. **Reserve the photo/initials slot in tile/card redesign so #3 doesn't re-lay-out cards twice.**
- **Files:** `src/index.css`, `src/components/ui/{card,button,badge}.tsx`, `src/routes/{home,sale/index,login,sale/charge}.tsx`, `src/components/layout/{AppHeader,RootLayout}.tsx`, `src/components/pos/NumericKeypad.tsx`.
- **Open decisions:** token pruning (recommend prune); one-screen design spec (tokens + 3 surfaces mocked) approved before rollout (recommend yes); tablet glare check (HARD GATE, locked).

### #12 — Contextual messaging over toasts (cross-cutting)
- **Current state:** Sonner is the app-wide channel; `Toaster` mounted once (`src/main.tsx:36`). **154 toast calls across 23 files**, three categories: (A) ~75 client-side **form-validation** toasts that should be inline — worst: `mgr/products.tsx` (36), `mgr/vouchers.tsx` (18), `settlements.tsx`, `mgr/staff.tsx`, `stock/*`, `DeviceActivation.tsx`, `mgr/receipt.tsx`; (B) ~10 PIN-flow toasts overlapping #11/#8; (C) ~70 global/async toasts to **keep** (print, draft saved, cancelled, server-rejection, Telegram, low-stock). No reusable inline-field-message component exists.
- **Approach:** add one reusable `FieldMessage` (tone error|success, red/green, `role=alert`) using #2 tokens; convert category-A validation toasts to per-field inline, starting with the two worst files. Reuse `PinSheet`'s existing inline-error pattern for login (delivers #11). Short ADR codifying "inline for sync validation; toast for global/async."
- **Files:** `src/components/ui/field-message.tsx` (new) + the category-A files above.
- **Open decisions:** scope all 75 now vs phase by file (recommend phase); inline API per-field map vs form-level (recommend `FieldMessage(tone)` + per-field error object); keep cross-device approval + server-rejection as toast (recommend yes).

### #4 — Staff-home declutter
- **Current state:** `src/routes/home.tsx` — static `TILES` array, `isManager = session.staff.role === "manager"`. Two `mgrOnly` tiles render **greyed-out** with a "mgr only" badge instead of being hidden. Settlements tile (`id:"sett"`, group `you`) has no `mgrOnly` flag so it shows for everyone; `/settlements` route + `listSettlements` are role-agnostic by design (v0.7).
- **Approach:** filter `mgrOnly` tiles when `!isManager` (hide, don't disable); drop empty groups so the MANAGER header disappears for staff; delete the disabled/Badge branch. For Settlements: add `mgrOnly:true` + move to the `mgr` group (vanishes from staff home, stays for managers). Add manager-role + staff-role render tests.
- **Files:** `src/routes/home.tsx`, `src/routes/__tests__/home.test.tsx`.
- **Open decisions:** hide vs disable (recommend hide); remove Settlements home tile only vs also gate the `/settlements` route to managers (recommend tile-only + move to mgr group; route-gating optional); suppress empty MANAGER header (yes).

### #5 — Lock → top-left icon near printer
- **Current state:** Lock surfaces in 3 places — a bottom button on home (`home.tsx:147`), a "Lock + handoff" YOU tile → `/lock`, and the `/lock` confirm screen. All run `logout → clearSession → navigate("/login")`. The printer button sits top-right in two headers (`AppHeader` right slot + home's own inline header). No existing top-bar lock icon.
- **Approach:** add a top-left `Lock` (lucide) icon button to the home header that `navigate("/lock")` (keep the confirm screen as the single sign-out funnel — it becomes #6's handoff seam). Delete the redundant bottom Lock button.
- **Files:** `src/components/layout/AppHeader.tsx`, `src/routes/home.tsx`, `src/routes/lock.tsx`, `src/routes/lock.test.tsx`.
- **Open decisions:** icon → `/lock` confirm (recommend yes, not one-tap logout); home-header only vs shared AppHeader (recommend home-only); remove bottom button (recommend yes); coordinate `/lock` body with #6.

### #6 — Handoff flow (stock check → sign-off w/ hours → staff selection)
- **Current state:** "handoff" today = logout only. Sign-in times **are** recorded (`staff_sessions.started_at`/`ended_at`, `convex/auth/internal.ts:274`); `convex/lib/time.ts::wibDayWindow` gives the WIB day window. **No index on `started_at`** (add one). Recount UI exists (`src/routes/stock/recount.tsx`, staff-allowed per ADR-041). Staff-selection = `login.tsx` list stage. **Net-new:** the orchestrated 3-step flow, the forced-stock-check gate, and the sign-off/hours-summary screen + its backend aggregation query.
- **Approach:** `/handoff` 3-step flow: (1) reuse recount UI as a gated stock-update; (2) NEW sign-off screen backed by a NEW query (`auth.public.shiftHoursForDay` or `transactions.public.dayShiftSummary`) reading `staff_sessions` for the device's WIB day, computing earliest `started_at` → now span → total hours+minutes — **and the #10 manual-BCA tally (count + total IDR) for the day**; (3) `logout` → `/login`. Add `by_device_started` index `(device_id, started_at)`. Repoint both Lock entry points at `/handoff`.
- **#10 coupling:** the sign-off screen must show the **manual-BCA summary** (count + total amount). This requires #10's `source: "manual_bca"` marker to exist first → **land #10 before (or with) #6.** The same summary feeds the EOD founders-summary cron.
- **Files:** `src/routes/{lock,home}.tsx`, `src/routes/handoff/{index,signoff}.tsx` (new), `convex/{transactions/public,auth/public,auth/schema}.ts`, `src/routes/stock/recount.tsx`, `docs/SCHEMA.md`.
- **Open decisions (confirm in spec):** hours metric = wall-clock span earliest→handoff (what was asked) vs summed active durations — **recommend span**; whose hours = device-wide day total (implied by "earliest sign-in → final handoff") vs per-staff — **recommend device-wide**; forced stock check hard-block vs soft nudge — **confirm (lean hard-block, it's the explicit ask)**; recount ALL SKUs vs acknowledge — **lean acknowledge/partial**; end session immediately vs hold open through sign-off so the hours number reads its own session — **hold open, end at final confirm**; WIB day boundary (yes); replace both lock entry points (yes).

### #7 — Login feedback (pressed-state, post-digit spinner, slide)
- **Current state:** login is `src/routes/login.tsx` → `PinEntry.tsx` → `NumericKeypad.tsx` (NOT `PinSheet`). Keypad keys have only `transition-colors hover:bg-accent` — **no active/pressed state** (hover does nothing on touch). After the 4th digit, `login.tsx` awaits the long argon2 `loginWithPin` action with **no spinner** (keypad stays live). `PinSheet` already implements a `pending` + `Loader2` "Verifying…" pattern to lift. Success = `navigate("/", {replace:true})` — hard route swap, no animation. Framer Motion ^12 is in deps but imported by **zero** files.
- **Approach:** thread a `pending` prop into `PinEntry` (mirror `PinSheet`): on the 4th digit, disable keypad + swap the dots row for an inline "logging in" spinner. Add CSS `active:scale-[.96] active:bg-accent` pressed state to keypad + `StaffListItem`. Wrap `/login → /` in the **View Transitions API** (`startViewTransition`) for a cheap native slide, falling back to plain navigate. Keep Sonner only for LOCKED_OUT/reset-denied; hand wrong-PIN inline to #11.
- **Files:** `src/components/pos/NumericKeypad.tsx`, `src/components/auth/{PinEntry,StaffListItem}.tsx`, `src/routes/login.tsx`, `src/components/ui/button.tsx`, `src/components/pos/PinSheet.tsx`.
- **Coordination:** **build #7 + #11 as one unit** — both rewrite `PinEntry`/`login.tsx` render and will collide. #11 owns error/inline; #7 owns success spinner+slide; shared slide built once.

### #11 — Inline PIN red/green feedback + diagnose the "random" toast
- **Current state:** `PinEntry` has no inline error/success and no spinner; on the 4th digit it submits immediately. All login feedback is Sonner `toast.error` (`login.tsx:101`). **The `useSession` debounce the user half-remembers is a RED HERRING** — issue #44's debounce hypothesis was refuted and never shipped (`docs/postmortems/2026-06-issue-44-misdiagnosis.md`). **Prime suspect for the "random" toast:** the **PIN-reset-denial toast** (`login.tsx:75-80`), driven by `getRecentPinResetForStaff` returning any unresolved reset within a 10-min window; the fired-once guard (`shownDenialRef` useRef Set) **resets on every remount**, so re-entering the PIN stage / post-login remount within 10 min re-fires "PIN reset declined" though the staffer did nothing.
- **Approach:** (1) lift `PinSheet`'s inline-error + Verifying spinner into `PinEntry` (red message + red-tinted dots, brief green before slide); remove the wrong-PIN `toast.error` for INVALID_PIN (keep a banner for LOCKED_OUT). (2) **Evidence-first** (per the #44 postmortem rule): add light instrumentation/repro confirming the random toast is the denial re-fire **before** touching the guard; then persist shown-denial requestIds across remounts (localStorage by requestId) or fire only on a fresh transition-to-denied.
- **Files:** `src/components/auth/PinEntry.tsx`, `src/routes/login.tsx`, `src/components/pos/PinSheet.tsx`, `src/routes/login.test.tsx`.

### #3 — Product photos + sale-grid title legibility
- **Current state (title truncation — the immediate ask):** `src/routes/sale/index.tsx:216` renders the product name with `truncate` (single-line ellipsis) inside `grid grid-cols-2 gap-2 sm:grid-cols-3`. On narrow phones (base = 2 columns) long names ("Dubai Chewy Cookies Mixed Box 4pcs", "Mixed Box 4pcs") clip and the staffer can't read the full product. `buildAddCardLabel` already passes the full name to `aria-label`, so it's a **visual-only** loss (a11y/cart logic unaffected). The cart-panel line items (`sale/index.tsx:~270`) also use `truncate` — separate, lower-priority surface.
- **Approach (title legibility):** product titles must always be fully readable. **Step 1 — responsive collapse first:** drop to **1 card per row on the narrowest widths** and check whether the full longest title fits at one column. Tailwind 4 supports arbitrary min-width variants with no config change — e.g. `grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3` (base = single column, widen as space allows). **Step 2 — word-wrap fallback:** if a single column still can't hold the longest title, remove `truncate` and let the title wrap (`break-words`, capped at ~2 lines via `line-clamp-2` as a safety bound). Equalize card heights when wrapping pushes one card taller (`items-stretch` on the grid items). Locked by Lucas: **try the resize-to-1-per-row first, wrap only as fallback.**
- **Photos (the larger #3 scope):** *placeholder — needs its own brainstorm/spec.* Reserve the photo/initials slot already left by #2's card redesign so cards aren't re-laid-out twice; the title-wrap layout above must coexist with that slot.
- **Files:** `src/routes/sale/index.tsx`, optionally `src/components/ui/card.tsx`. (No `src/index.css` breakpoint change needed — use arbitrary `min-[Npx]:` variants.)
- **Open decisions:** 1-per-row-then-wrap order (locked — resize first); `line-clamp-2` cap vs unbounded wrap (recommend 2-line cap); apply the same treatment to cart-panel line items (recommend defer to the #3 photo work).
- **Note:** tackled in a **separate session** from #7/#11 (login PIN feedback); listed here so the photo phase owns it. No code dependency on the login work — different files.

### #13 — Receipt cleanup
- **Current state:** wording lives in two renderers fed by one `ReceiptViewModel`. **`[ lunas ]`** is hardcoded on the **thermal** path (`src/lib/escpos.ts:53`) and a status badge on the **HTML** path (`convex/receipts/template.ts:157`); text from `STATUS_LABELS.paid` (`template.ts:52`). **"Dibayar via qris" + "RRN: xxx"** hardcoded in both (`template.ts:170`, `escpos.ts:78`). **"dapur raya" does NOT exist in code** — it's `vm.settings.business_name` (config, `pos_settings.receipt_business_name`, code default already `"FROLLIE"`). Footer is config too (`footer_text` default `"Terima kasih! 💛"`). Tests assert `"LUNAS"` for paid receipts.
- **Approach:** edit both renderers — suppress the paid badge/`[ ... ]` **only when status=='paid'** (keep `SEBAGIAN DIKEMBALIKAN`/`DIKEMBALIKAN` refund labels); collapse payment block to a single `${payment_method} - ${rrn}` line. Fix `Dapur Raya → FROLLIE` and footer → `Thank you!` by updating the prod `pos_settings` row via `/mgr/receipt` (and optionally the code defaults in `settings/internal.ts`). Update LUNAS/wording test assertions. **Keep the payment-line template method-agnostic** so #10's Transfer Bank method needs no rework.
- **Files:** `convex/receipts/template.ts`, `src/lib/escpos.ts`, `convex/settings/internal.ts`, + 4 test files.
- **Open decisions:** header fix via config edit vs harden default (config edit; default already FROLLIE); suppress label for paid only (yes); exact wording `qris - <rrn>` + no-RRN behavior; footer default vs prod-row edit (ties to #1 EN/ID).

### #10 — Retire BCA VA + static-account manual transfer
- **Current state:** QRIS (`createQrisCharge`) is live-proven; BCA VA (`createBcaVaCharge`, `xendit.ts:96`) is flagged LIVE-UNVERIFIED and throws `XENDIT_VA_FAILED` → `BANK_NOT_ACTIVATED_ERROR`. **The error storm:** the auto-create effect (`charge.tsx:173-233`) re-fires on tab/invoice change, `toast.error` per attempt. Manual override path exists (`manuallyConfirmPayment`, source=manual, manager-PIN, ADR-036) — reusable. Convex file storage is proven for the receipt logo (`generateUploadUrl` + `_storage` id + `getUrl`) — the exact pattern for the transfer-confirmation photo. Static account constants + WhatsApp number have **no home** (pos_settings has receipt_* only).
- **Approach (decision: keep BCA-VA close as the immediate fix; real refunds spike comes after):**
  - **Hide** the BCA VA tab in `charge.tsx` (keep `createBcaVaCharge`, FVA webhook parser, and the `BCA_VA` schema literal — **removing the literal is deploy-skew-fatal and breaks historical rows**). QRIS becomes the sole Xendit method → the toast storm disappears by construction. **Move dynamic BCA VA to backlog** (rationale: BCA-only, non-universal). Amend ADR-036's method set.
  - Add a third option **"Bank transfer (manual)"** showing the static account (BCA / PT Malo Group Bahagia / 6044830994), sourced from **new editable `pos_settings` fields** (manager-session CRUD). **Staff self-confirm — NO manager-PIN, NO in-app photo upload.** Flow: show account → staff tap a **confirm checkbox/button "I confirm payment proof has been sent to the Block M staff WhatsApp group"** → transaction commits. The photo capture + WhatsApp send is a **fully manual, out-of-band** process the staff do in WhatsApp themselves; the POS records **only the attestation tap**, not the image. (No `_storage`, no `navigator.share`, no `.webp` upload for #10 — `.webp` applies to #3 only.)
  - **Mark every manual-BCA txn** so it can be tallied — a new payment source/method marker (e.g. `source: "manual_bca"` on the confirm path, distinct from `manual` manager-override). Commits via a **new staff-session confirm action** (not `manuallyConfirmPayment`, which is manager-PIN), reusing `_onPaidManual_internal`/`_confirmPaid_internal` with the new source.
  - **Reconciliation is the compensating control (replaces the photo gate):** an **itemized manual-BCA summary — every manual-BCA txn of the shift (time, amount, staff) plus count + total IDR** — surfaces at (a) **staff clock-out** in the #6 handoff sign-off screen, and (b) **end-of-day**, hooking the existing `founders-shift-summary` cron (22:00 WIB) or a sibling summary. Lets the operators validate each deposit against the real BCA account they already have access to.
  - **Ticker flag (v1.0.1 `txn_ticker` coupling):** when a sale commits via `source: "manual_bca"`, its per-sale `txn_ticker` Telegram message (one per paid sale → managers role) must **clearly flag it as a MANUAL transaction** with a *"check the BCA account for the deposit"* prompt — visually distinct from the normal QRIS ticker line. Branch the ticker renderer on the source.
  - **Light resilience hardening:** wrap the auto-create catch → inline message (via #12) and guard the create effect against re-fire loops.
- **DEVIATION (ADR-036):** manual payment confirmation is currently **manager-PIN**. #10 deliberately lets **staff self-confirm** manual BCA transfers — the EOD + clock-out reconciliation summary is the compensating control. Write this into the ADR-036 amendment explicitly.
- **Files:** `src/routes/sale/charge.tsx`, `src/hooks/useXenditPayment.ts`, `convex/payments/{actions,xendit,schema,internal}.ts`, `convex/settings/{schema,public}.ts`, `convex/transactions/{internal,public}.ts`, `convex/telegram/{foundersSummary,send}.ts`, `convex/lib/telegramHtml.ts` (ticker renderer branch), `docs/{SCHEMA.md,ADR/036-...}`, tests.
- **Open decisions:** hide-only confirm (yes, keep literal); config source = pos_settings fields (recommend); new `source: "manual_bca"` marker + staff-session confirm action — **no manager-PIN** (locked by Lucas); attestation tap only, no image stored (locked); EOD manual-BCA summary via the founders-summary cron vs a new cron (recommend reuse); manual-BCA tally in #6 sign-off (locked — couples #10 ↔ #6).

### #9 — Real Xendit refunds (SPIKE-GATED)
- **Current state:** refunds are a complete ledger with **manual** money movement (ADR-038). `_commitRefund_internal` (`convex/refunds/internal.ts:181`) is the single writer (inserts `pos_refunds`, patches `refunded_qty`, re-credits stock, audits); `settlement_status: "pending"|"settled"` tracks merchant→customer cash a manager moves out-of-band, acked via `markRefundSettled` (manager-session, rule #21). **No Xendit refund/disbursement API is ever called.** ADR-038 explicitly rejected automation for v1 because the rails are asymmetric: QRIS has `POST /qr_codes/{id}/refunds` but it's **issuer-dependent** (GoPay/others reject → disbursement fallback); BCA VA has **no refund API** (only an outbound Disbursement, needs customer bank data the sale never captures). The payments webhook has **no refund branch**. `settlement_status` was designed as the forward-compatible callback seam (pending→settled with no schema change).
- **Decision:** **Spike first.** #10 (closing BCA VA) lands first and **shrinks #9's scope** (BCA-VA-has-no-refund-API drops to historical/edge cases). Then **mandatory Task-0 live-API check** on TEST keys — QRIS refund endpoint shape (full/partial body, response), the refund webhook event name + payload, which issuers reject — captured into `docs/xendit-reference/refunds-disbursements.md`. KYB gates whether real money-back is live-verifiable at all. **Scope the build from verified facts, not doc assertions** (both ADR-036 and v0.7 settlements caught divergences this way).
- **Likely shape (pending spike):** new **ADR-047** superseding ADR-038's manual-money decision while preserving its asymmetry analysis + the `settlement_status` seam. Build incrementally: (1) QRIS refund-API automation with the **manual path RETAINED** as the issuer-rejection fallback (`markRefundSettled` stays); (2) a refund/disbursement webhook branch driving `settlement_status` off the confirmed event, storing a provider-refund-id on `pos_refunds` with a match index. Keep the binary `settlement_status` unless Task-0 reveals a multi-stage lifecycle.
- **Open decisions (resolve post-spike):** which rails to automate (QRIS-only vs +Disbursements); state machine binary vs expanded; failure/rejection → manual fallback (recommend keep); sync action + webhook-confirm vs async enqueue.

## Cross-cutting constraints & collision warnings

- **Schema/deploy-skew:** do NOT remove the `BCA_VA` method literal (#10) — deploy-skew-fatal, breaks historical invoice rows. Hide UI only.
- **Currency:** `id-ID` formatting in `src/lib/format.ts` (business rule #14) is **currency, not copy** — i18n (#1) must leave it untouched.
- **PinEntry collision:** #7 + #11 both rewrite `PinEntry`/`login.tsx` — one coordinated unit.
- **home.tsx region:** #4, #5, #6 all edit the same area — sequence #4 (declutter) → #5 (lock icon) → #6 (handoff) to avoid churn.
- **Same renderers:** #13 + #2 both touch receipt renderers; #13's wording stays method-agnostic for #10.
- **Evidence-before-mitigation:** #11's "random toast" fix must follow a confirmed repro (issue-#44 postmortem rule); label it a verified fix only after repro.
- **Glare gate:** #2 dark canvas must pass a real-tablet readability check before rollout.

## ADR-gated items
#1 (i18n infra), #2 (design direction), #9 (ADR-047 supersedes 038), #10 (amends 036's method set), #12 (inline-vs-toast policy).
