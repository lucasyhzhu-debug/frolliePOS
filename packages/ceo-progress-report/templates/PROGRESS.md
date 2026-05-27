# Progress

**Mission.** Build the thing your users have been asking for, one shippable slice at a time, until v1.0 is the obvious default.

Living roadmap. Update as work lands. AI agents read this before starting a task and update it after.

**Legend:** ✅ done · 🔄 in progress · 📋 planned (next up) · 🗂️ backlog (not yet planned)

---

## v0.1 — first slice ✅ SHIPPED
**Outcome:** A user can sign in and see the home screen on the device they were given.
Merged 2026-04-01.

**You can:**
- Open the app on a registered device and land on a home screen
- Sign in with a short PIN
- See your own name in the corner and know which device you're on
- Sign out cleanly without losing local state

**You still can't:**
- Do any real work — this slice is sign-in only
- Recover a forgotten PIN without a manager

### Backend (be)
- ✅ Auth schema + PIN hashing + session table

---

## v0.2 — next slice 📋 PLANNED (next up)
**Outcome:** A user can complete the core action the product exists to do.
**Target:** TBD

**You'll be able to:**
- Start the primary task from the home screen
- Fill in the few fields the task needs
- Submit and get a confirmation the system understood you
- See the result reflected in your own history view

**Still not yet:**
- Edit or undo a submitted action
- Hand the task off to someone else mid-flight

### Backend (be)
- 📋 **[v02-be-core-mutation]** Server-side handler for the primary user action
  - agent: convex-expert
  - deps: —
  - docs: SCHEMA.md
  - subtasks:
    - [ ] Define the table + indexes
    - [ ] Write the public mutation with idempotency key
    - [ ] Tests: happy path, retry, validation failure
  - notes: This is the first state-changing mutation in the system — set the pattern carefully.

- 📋 **[v02-be-history-query]** Per-user history query
  - agent: convex-expert
  - deps: v02-be-core-mutation
  - docs: SCHEMA.md
  - subtasks:
    - [ ] Index by owner + created_at
    - [ ] Paginated query
  - notes: —

### Frontend (fe)
- 📋 **[v02-fe-primary-flow]** Screen + form for the primary action
  - agent: frontend-integrator
  - deps: v02-be-core-mutation
  - docs: CLAUDE.md
  - subtasks:
    - [ ] Route + skeleton
    - [ ] Form with validation
    - [ ] Wire to mutation + toast on success
  - notes: Keep the form to four fields max — anything more belongs in a later phase.

---

## v1.0 — launch 🗂️ BACKLOG
**Outcome:** The product is the obvious default for the people it was built for.
**Target:** TBD

**You'll be able to:**
- Use every primary flow without a workaround
- Trust the data — no manual reconciliation needed
- Hand the device to a new teammate and they'll figure it out
- See enough of your own history to answer "what did I do yesterday?"

**Still not yet:**
- Multi-tenant — single workspace per install through v1
- An admin portal for non-technical operators (post-v1 phase)

---

## Risks under watch

- **Scope creep on the primary flow** — every stakeholder wants "just one more field" on the main form. Hold the line at four fields until v0.3; revisit only with usage data.
- The team is one person — bus factor of one until at least one other engineer is onboarded. Mitigation: keep ADRs current so the next engineer can ramp in days, not weeks.

## Decisions awaiting the CTO

- **Should we ship v0.2 without a delete affordance?** — Soft-delete is two days of work; hard-delete is one. The team thinks delete can wait until v0.3 when refund flows ship. Need a call before locking the v0.2 plan.
- ~~**Should we use a managed auth provider?**~~ — **RESOLVED 2026-01-15**: chose hand-rolled PIN auth because the device is shared and managed auth assumes one-user-per-account. Revisit if we ever go multi-tenant.

## How to read this file

**Phase format.** Each phase is one `## vX.Y — title <status-emoji> <status-label>` heading. Under it: `**Outcome:**` (one sentence in user-action voice), `**Target:**` (date or `TBD`) or `Merged YYYY-MM-DD` if shipped, then `**You'll be able to:**` and `**Still not yet:**` bullet blocks. Lanes are `### Backend (be)`-style H3s.

**Task metadata schema.** Each addressable task is a bullet with an emoji, an ID in `**[vXX-lane-slug]**` brackets, and a title. Indented under it:
- `agent:` — which agent should own it (e.g. `convex-expert`, `frontend-integrator`, or `—` for none)
- `deps:` — comma-separated Task IDs that must be `✅` first, or `—` if no deps
- `docs:` — ADRs, schema doc, or CLAUDE.md sections to read before starting
- `subtasks:` — concrete checkbox steps; tick them as you go
- `notes:` — context that doesn't fit elsewhere; one bullet per note

**Refusal rules.**
- Do not edit `progress.html` by hand — it's regenerated from this file by `ceo-report build`.
- Do not delete a resolved decision — keep it in `~~strikethrough~~ — **RESOLVED YYYY-MM-DD**: ...` form so the institutional memory survives.
- Do not change a task's `**[id]**` once it's been merged — other tasks may reference it as a dep.
- Do not edit a phase's status from `✅ SHIPPED` back to anything else — if you shipped it and then reverted, write a new phase recording the revert.
