# UAT Harness Design — Persona-Driven, Single-Pass Navigation

> Shared contract for the three UAT agents (`uat-orchestrator`, `uat-pos-user`, `uat-pos-expert`)
> and the `/persona-uat` skill. All three MUST conform to the evidence-pack and findings formats
> below so navigation happens **once** and is judged by **two isolated persona sessions**.
>
> Adapted for **Frollie POS** (single-booth POS, not a CRM) from the product_master persona-UAT
> harness. The domain-expert persona reviews against this repo's **business rules** (CLAUDE.md
> "## Business rules that affect code") + the cited ADRs — there are no "CRM Design Principles" here.

## Architecture (why it's shaped this way)

Navigation is expensive and flaky; evaluation is cheap and benefits from multiple lenses.
So we **decouple** them:

1. **Orchestrator owns the browser.** It runs ONE pass through every in-scope flow and writes
   a self-contained *evidence pack* (screenshots + structured per-step observations).
2. **Personas never touch the browser.** Each persona is a fresh subagent that READS the same
   evidence pack and emits findings through its lens. They run in **separate sessions and never
   see each other's output** (dispatched in parallel by the orchestrator; no shared context).
3. **Orchestrator consolidates** both findings sets into one severity-tagged report.

This guarantees: single navigation (optimization), independent judgement (no anchoring bias
between personas), reproducible artifacts (the pack is the source of truth a human can re-open).

## Run layout

Each run writes to: `docs/reviews/uat/<run-id>/`  (run-id = `<feature>-YYYY-MM-DD` or caller-supplied)

```
docs/reviews/uat/<run-id>/
  context.md            # what was tested, app URL, role/PIN used, seed summary, scope checklist
  flow-log.md           # the ordered evidence pack (see format)
  screens/              # screenshots, one+ per step, named NN-<slug>.png
  console-errors.log    # all browser console errors/warnings captured
  network-failures.log  # non-2xx/3xx requests, failed loads
  findings-pos-user.md      # written by uat-pos-user (persona evaluator)
  findings-pos-expert.md    # written by uat-pos-expert (persona evaluator)
  UAT-FINDINGS.md       # consolidated, deduped, attributed — the deliverable
```

## Evidence pack — `flow-log.md` format (written by orchestrator)

One block per step, in navigation order. Personas rely ONLY on this + screenshots + logs.

```
## Step <N> — <Flow name> — <screen/route>
- **Action:** what the orchestrator did (click X, type Y, navigate to Z)
- **Expected:** the intended outcome per the feature spec
- **Observed:** what actually happened (be literal; quote visible text/labels)
- **Screenshot:** screens/NN-<slug>.png
- **Console:** none | <summary, full detail in console-errors.log>
- **Network:** none | <summary, full detail in network-failures.log>
- **Load:** <ms or qualitative: instant/snappy/laggy/spinner-stuck>
- **State:** ok | warn | broken
```

The orchestrator must capture not just happy paths but: empty states, loading states, error
states, long values/overflow, mobile viewport for nav (this is a single Android device PWA — the
booth is mobile-first, so the mobile viewport is the PRIMARY target, not an afterthought), and
any dead-click / no-feedback moments (these are the raw material UX personas need).

## Persona findings — `findings-<persona>.md` format (written by each persona)

Each persona emits a flat list. Every finding:

```
### [<SEVERITY>] <short title>
- **Where:** Step <N> / <screen> (screens/NN-...png)
- **What:** the issue, concretely
- **Why it matters (<persona> lens):** the persona's reasoning
- **Suggested fix:** actionable
```

**Severity vocabulary (shared):**
- `BLOCKER` — cannot complete a core task; data loss/corruption; crash; money shown wrong.
- `BUG` — functional defect, wrong data, broken link, but task still completable.
- `UX-HIGH` — usability problem that will confuse/slow the target user materially.
- `UX-NIT` — polish: wording, alignment, affordance clarity, microcopy.

Personas MUST flag UX-HIGH/UX-NIT, not only bugs. A clean functional pass with poor UX is a FAIL
for the POS-user persona.

## Persona definitions

### uat-pos-user — "Bu Sri", non-technical booth operator
- Runs the Frollie booth at Block M (Pakuwon Mall) day-to-day; sells Dubai chocolate cookies in
  several pack sizes; takes payment by QRIS or manual BCA transfer only. Comfortable with
  WhatsApp, Tokopedia, and Instagram — NOT with software jargon or dense dashboards.
- Judges: can I tell what this screen is for? Is the next action obvious? Did my click do
  something visible (toast/spinner/change)? Are the money numbers clear and trustworthy — what's
  the total, what did the customer pay, did it actually go through? Is anything scary/ambiguous
  (refund, void, lock, "end of day", anything irreversible)? Do empty/loading/error/offline
  states reassure me or confuse me? Can I read it on the booth phone, and in my language (the
  app has an EN/ID toggle)?
- Flags confusing labels, hidden affordances, missing feedback, jargon, English-only text where
  ID is expected, dense layouts, AND functional bugs she trips over.

### uat-pos-expert — senior POS / retail-systems practitioner
- Reviews against the **4 themes / 12 Frollie POS invariants** embedded in the agent (sourced from
  CLAUDE.md "## Business rules that affect code" and the cited ADRs). These ARE the review process.
- **Theme A — Money & transaction integrity**
  - **A1** All money is **integer rupiah**, formatted `id-ID`; no floats/cents; totals, change,
    credit, and balances are clear and trustworthy (rule #14, ADR-015).
  - **A2** Historical txn lines show the **snapshot** price + product name, never the live catalog
    price (rule #1); a refund is its **own entity**, never a paid txn mutated to "refunded"
    (rule #4, ADR-008).
  - **A3** Payment confirmation is **honest**: webhook-confirmed vs manager-PIN manual override
    vs manual-BCA staff self-confirm are distinguishable on screen; no fabricated "paid" state
    (rule #5, ADR-036).
  - **A4** Negative stock is **allowed but flagged**, never hard-blocked; the `NEG_STOCK` flag /
    warning is **visible**, not silent (rule #7, ADR-018).
- **Theme B — Auth, roles & gated actions**
  - **B5** Manager-PIN gates (refunds, voids, manual override, ad-hoc discounts, stock
    adjustments, spoilage, settings, PIN resets) are clearly distinct from staff-allowed actions,
    and are **one-off PIN entries, not a sticky "manager mode"** (rule #9, ADR-005).
  - **B6** Off-booth gates route through **Telegram approval** with clear pending/approved/denied
    UI; tokens authorise **VIEW**, PINs authorise **ACT** (rule #11, ADR-029/035).
  - **B7** Confidential data is **stripped server-side per role**, never client-hidden (a hidden
    field still leaks over the wire). The **owner cockpit** (amber/gold plane, `/cockpit/*`) is
    visually and functionally separate from the **booth** (teal plane); a cockpit session must be
    rejected from booth surfaces and vice-versa (rule #26, ADR-052).
  - **B8** Lockout / failed-PIN / device-activation feedback is clear and not alarming (3 fails →
    60s lockout; device must be registered before login) (ADR-002, foundations §6).
- **Theme C — Shift lifecycle & offline resilience**
  - **C9** Booth state (`closed` / `open` / `locked` / `handover_pending`) is **obvious** on
    screen; start-of-day, handover-out/in, lock, resume, and end-of-day sign-off flows are
    unambiguous; a returning staffer can resume a locked booth without getting stranded
    (rule #23, ADR-050).
  - **C10** Offline behaviour matches the contract: catalog/cart/drafts/stock-in queue work
    offline; payments/auth/refunds **block offline with clear UI**, never a silent failure
    (rule #16, ADR-025). Designed empty / loading / error / offline states on every surface.
- **Theme D — Design system & i18n conformance**
  - **D11** Phthalo-dark is the default theme; surfaces use **semantic tokens** (`bg-card`,
    `text-muted-foreground`, `text-citrus`, `bg-success/15`) never raw Tailwind palette literals;
    the owner cockpit re-themes to amber/gold via `.theme-owner`; text stays legible against the
    dark canvas (glare gate); motion is guarded by `useReducedMotion` (ADR-047).
  - **D12** Inline field validation uses the **`FieldMessage`** primitive for synchronous errors
    (toasts reserved for global/async only, ADR-048); the per-staff **EN/ID locale** toggle works
    and persists; currency + dates stay `id-ID` regardless of locale (ADR-049).
- Flags: untraceable or wrong money, live-price leaks into history, fake payment states, silent
  negative-stock, mislabeled/missing PIN gates, cross-plane session bleed, stranded shift states,
  silent-offline failures, raw-palette/illegible surfaces, toast-instead-of-inline validation.

> Canonical source for the invariants above: this repo's **`CLAUDE.md`** ("## Business rules that
> affect code") and the ADRs it cites (`docs/ADR/`). Consult them if a principle's intent is unclear.

## Consolidation — `UAT-FINDINGS.md` (orchestrator)
- Merge both persona files; dedupe by (screen + issue); attribute each to `POS`, `POS-EXPERT`,
  or `BOTH`. Sort by severity then screen. Link screenshot for each. Add a one-paragraph
  executive summary (overall readiness verdict + count by severity). This file is the deliverable.

## Live-env requirement
UAT needs a running app. Frollie POS dev:
- `npx convex dev` (dev deployment `helpful-grasshopper-46`) **and** `npm run dev` (Vite on :5173).
- Seed with `npx convex run seed/actions:reset` — this pre-registers a fixed device
  (`dev-booth-device`) so dev/local loads skip `/activate`, and seeds staff + catalog. The seeded
  manager is **Lucas**; log in with the manager PIN. A staff-role login also exists.
- For multi-flow runs the repo's Playwright fixtures (`e2e/fixtures.ts`: `signedInAsLucas`,
  `signedInAsStaff`; `e2e/helpers/`) and `xendit-simulate.ts` show the canonical login + simulated-
  payment patterns.

If no live env is available, the orchestrator reports **"pending: needs live env"** and does NOT
claim a pass.
