# 003. Shared device, ephemeral session

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Auth

## Context

Same iPad/Android device, multiple staff per day with overlapping shifts. "Log out at end of every action" friction is unacceptable; "stay logged in forever" leaks accountability when shifts change hands.

## Decision

Active session = one `staff_id` stored in `localStorage` + a server `staff_sessions` row. The **Lock** screen ends the session explicitly (writes `ended_at`, `end_reason: "manual_lock"`). Idle behaviour: **no auto-logout** — booth context, not banking. Every state-changing mutation requires a `sessionId` in args; server validates session ↔ staff_id binding.

## Alternatives considered

- **Auto-logout after N minutes idle.** Rejected: at a booth, idle = "between customers." Forcing re-login mid-shift is friction. Lock-on-purpose pattern matches mental model.
- **No client-side session state, refetch from cookie every request.** Rejected: doesn't work offline ([ADR-025](./025-service-worker-cache.md)); cart-build flow needs to know who's logged in without a network roundtrip.
- **Session bound to device only, no staff binding.** Rejected: loses attribution. Every mutation must trace back to a staff actor.

## Consequences

- *Easier:* session lifecycle is one explicit user action (Lock). No surprise sign-outs.
- *Harder:* session expires only when staff Locks or server reaps it nightly ([ADR-032](./032-saved-drafts-purge-24h.md) reaper covers stale sessions too). A forgotten unlock means the next staff acts as the previous one until they Lock+re-login.
- *Concurrent sessions allowed* per device for shift overlap (Citra and Dewi both signed in for 15 minutes during the handoff window). Session list visible on the lock screen.
- *Mitigation:* manager dashboard surfaces "session open for >12h" as a quality metric.
