---
name: persona-uat
description: Run end-to-end persona-driven UAT on the running Frollie POS web app — one browser pass judged by two isolated personas (a non-technical booth operator + a POS-domain expert), producing a severity-tagged findings report covering bugs AND UX/usability nitpicks. Use when the user asks to "run UAT", "UX test this", "usability review", "persona UAT", or validate a feature end-to-end after triple-review/simplify (sale / payment / refund / shift / stock / owner-cockpit surfaces).
---

# Persona-Driven UAT

Drive the app **once**, judge it **twice**. Navigation is decoupled from evaluation so the
browser runs a single pass while independent persona sessions evaluate the captured evidence.

## Architecture

```
/persona-uat → uat-orchestrator agent (owns the browser)
   1. ONE Playwright / /browse pass through every in-scope flow (mobile viewport — booth is a
      single Android-device PWA)
   2. Writes an evidence pack: screenshots + per-step observed-vs-expected
      + console/network errors + timings  → docs/reviews/uat/<run-id>/
   3. Dispatches TWO isolated evaluator subagents IN PARALLEL (no cross-talk):
        • uat-pos-user   — "Bu Sri", non-technical booth operator (UX friction,
                           jargon, missing feedback, unclear money) + functional bugs
        • uat-pos-expert — POS best practice + this repo's 4 themes / 12 business-rule invariants
   4. Consolidates → docs/reviews/uat/<run-id>/UAT-FINDINGS.md
```

The two personas run in **separate sessions and never see each other's output** — independence
prevents anchoring bias. They never touch the browser (single-pass guarantee).

Full contract: [docs/reviews/uat/UAT-HARNESS-DESIGN.md](../../../docs/reviews/uat/UAT-HARNESS-DESIGN.md)

## Quick start

1. Ensure a **live env** is running. Frollie POS dev needs **both**:
   - `npx convex dev` (deployment `helpful-grasshopper-46`)
   - `npm run dev` (Vite on :5173)
   Seed with `npx convex run seed/actions:reset` — pre-registers `dev-booth-device` so dev loads
   skip `/activate`, and seeds staff + catalog. Log in with the manager PIN (seeded manager:
   "Lucas"). UAT needs a real running app.
2. Invoke the orchestrator via the Agent tool:

   ```
   Agent(subagent_type="uat-orchestrator", prompt=
     "App URL: http://localhost:5173
      Login: manager PIN <PIN> (role: manager, staff: Lucas)
      Run-id: <feature>-2026-06-25
      Scope: <list the flows/screens to exercise>
      Spec summary: <1-paragraph of what the feature should do>")
   ```

3. The orchestrator returns the path to `UAT-FINDINGS.md`. Triage: fix BLOCKER/BUG before
   merge; route UX-HIGH/UX-NIT to ROADMAP backlog or fix if cheap.

## When to run

Run this as the **final gate after** `/triple-review` and `/simplify` — UAT is for the
finished, verified implementation, not work-in-progress. If no live env is available, the
orchestrator reports **"pending: needs live env"** — that is not a pass.

## Scope checklist (compose per feature)

List concrete flows so the single pass covers them. Common Frollie POS surfaces: login + booth
start-of-day, the sale grid → cart → QRIS / manual-BCA payment, history + receipt reprint, the
refund flow (manager-PIN), stock-in / recount / spoilage, shift handover + lock + resume +
end-of-day sign-off, the manager admin pages (staff / products / receipt / settlements / audit),
the owner cockpit (`/cockpit/*`, amber plane), and every empty / loading / error / **offline**
state. Tell the orchestrator the booth is mobile-first — run the pass at a mobile viewport.
