# Implementation plans

One plan per release phase (v0.2 → v1.0). Phase scope is defined by `docs/WORKFLOW.md` § Releases.

Each plan is a self-contained, TDD-style sequence: write the failing test → run → implement → run → commit. An engineer with zero project context should be able to follow a plan top-to-bottom and ship the phase.

## Index

| Phase | Plan | Status |
|---|---|---|
| v0.2 — auth + catalog | [`2026-05-25-v0.2-auth-catalog.md`](./2026-05-25-v0.2-auth-catalog.md) | drafted |
| v0.3 — sale flow + Xendit | _not yet planned (next after v0.2 ships)_ | — |
| v0.4 — audit + WA approval | _not yet planned_ | — |
| v0.5 — refunds + history + dashboard | _not yet planned_ | — |
| v0.6 — voucher mgmt + reconciliation | _not yet planned_ | — |
| v1.0 — launch polish | _not yet planned_ | — |

## Process

Per the superpowers `writing-plans` skill: one plan per testable subsystem. We plan v0.2 in detail now, ship it, then plan v0.3 with the benefit of real signal from v0.2. This avoids writing 5 detailed plans before learning anything.

## Execution

Plans are executed via either:
- **`superpowers:subagent-driven-development`** (recommended) — fresh subagent per task with review between
- **`superpowers:executing-plans`** — inline batch execution with checkpoints
