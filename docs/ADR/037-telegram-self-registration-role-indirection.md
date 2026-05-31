# 037. Telegram self-registration with role-indirection

**Date:** 2026-05-30
**Status:** Accepted
**Group:** Comms

## Context

[ADR-035](./035-telegram-as-internal-comms.md) established Telegram as the sole internal-comms infrastructure and replaced the wa.me share-intent approach. That decision left the bot wired to a single `TELEGRAM_CHAT_ID` environment variable. As v0.4 extended Telegram delivery to cover `manual_payment_override` (and the design anticipates further approval kinds), the single-env-var model surfaced structural gaps:

1. **Multiple chat targets.** The `managers` group gets off-booth approval links; the `founders` group gets shift-summary posts. Two distinct roles require two distinct chat ids. Introducing a second env var (`TELEGRAM_FOUNDERS_CHAT_ID`) starts a proliferation race and moves routing logic into deployment config rather than the database.

2. **Operational events that must not require a code deploy.** When the managers' supergroup is renamed and receives a new Telegram chat_id, or when the bot rejoins a fresh group after an incident, updating routing today means a code change or a redeploy to rotate env vars. The ops team should be able to self-heal by sending `/register` and calling a manager action — no deployment required.

3. **Bot restart and chat_id drift.** Telegram supergroup chat_ids change when a group is upgraded or the bot is kicked and re-invited. A db-backed registry that reacts to `/register` absorbs those events without operator intervention.

4. **Manager-gated admin without a separate admin surface.** The starter repo pattern (`requireAdminKey`) uses a long-lived shared secret. Frollie POS already has a manager-session model ([ADR-005](./005-manager-pin-one-off.md)); re-using it for chat registry admin keeps the auth surface coherent and avoids a second credential store.

The [`convex-telegram-bot-starter`](https://github.com/lucasyhzhu-debug/convex-telegram-bot-starter) repo (public) provides the reference pattern for self-registration + role-indirection. v0.4 ports and adapts this pattern to Frollie POS's module layout, auth model, and idempotency rules.

## Decision

### Decision A — `telegramChats` registry table

One row per Telegram chat that has registered with the bot. Fields:

```
telegramChats {
  chatId: string               // Telegram chat_id (string — can be negative)
  chatType: "private" | "group" | "supergroup"
  title: string                // display name at registration time
  role?: string                // assigned role ("managers", "founders", …)
  registeredBy?: number        // Telegram user_id of the person who sent /register
  registeredAt: number         // server timestamp (ADR-031)
  lastSeenAt: number           // updated on every /register re-send
  archivedAt?: number          // set when a chat is decommissioned; role cleared
  lastError?: { at, message }  // best-effort send-failure trail
}
```

Indexes: `by_chatId` (unique lookup), `by_role` (role scan — JS post-filters `archivedAt === undefined` for active rows). *v0.5.1 update:* the compound `by_role_archived` index was dropped after the Convex optional-field filter gotcha (see MEMORY.md) forced production code to use the bare `by_role` index + JS post-filter. The compound index was unreferenced once tests were rewritten to mirror prod.

### Decision B — `telegramUpdates` dedup table

One row per processed Telegram `update_id`. Written atomically before handling, queried to skip already-processed updates. Prevents duplicate `/register` handling on Telegram's at-least-once webhook delivery.

```
telegramUpdates {
  updateId: number
  receivedAt: number
}
```

Index: `by_update_id`.

### Decision C — `/register` + `/start` bot commands

Any chat member can send `/register@<BotUsername>` (or the bare `/register` in a DM). The command upserts a `telegramChats` row:

- **New chat** → row inserted, no role assigned yet; bot replies with the admin URL.
- **Re-register (dormant — no role yet)** → `lastSeenAt` updated; bot replies "already registered, assign a role at \<url\>".
- **Re-register (live role)** → `lastSeenAt` updated; bot replies "already registered as role \<r\>; change at \<url\>".

`/start` replies with bot identity and a registration nudge. Neither command requires manager auth; they are self-service for any chat where the bot is present.

Role assignment is a separate, manager-gated step (see Decision D).

### Decision D — `getChatIdByRole` is the routing primitive

`getChatIdByRole(role: string): Promise<string>` (internalQuery) is the single routing call used by every component that needs to post a Telegram message. It:

1. Queries `telegramChats` by the `by_role` index for rows matching `role`, then JS-post-filters on `archivedAt === undefined` to find the active one (Convex optional-field filter gotcha workaround — see MEMORY.md).
2. If found, returns `chatId`.
3. If not found and `TELEGRAM_FALLBACK_ROLE == role` and `TELEGRAM_CHAT_ID` is set, returns the env-var value (backward-compat — see Decision F).
4. Otherwise **throws** with a descriptive error (`No Telegram chat assigned to role '<role>'`).

Callers of `getChatIdByRole` never hardcode a chat id. `sendTemplate` (v0.4) already wires through role rather than chat id.

### Decision E — Manager admin via `mgr*` twins inside `chatRegistry.ts`

Chat registry admin (assign role, archive, restore, send test) is exposed as public manager-session-gated mutations and an action, all co-located in `convex/telegram/chatRegistry.ts`. There is no separate `mgrAdmin.ts` module — the original plan was superseded by the v0.4 spike, which established that co-location is cleaner given the small surface.

| Export | Type | Auth | Idempotency |
|---|---|---|---|
| `mgrListChats` | query | `requireManagerSession` | n/a (read-only) |
| `mgrAssignRole` | mutation | `requireManagerSession` | `withIdempotency` (ADR-013) |
| `mgrArchiveChat` | mutation | `requireManagerSession` | `withIdempotency` (ADR-013) |
| `mgrRestoreChat` | mutation | `requireManagerSession` | `withIdempotency` (ADR-013) |
| `mgrSendTest` | action | `_requireManagerSession_internal` via `ctx.runQuery` | — |

`mgrSendTest` is an `action` (not a mutation) because it makes an external HTTP call to the Telegram API. Actions cannot call `ctx.db` directly; it gates authorisation by running `auth.internal._requireManagerSession_internal` as an internalQuery before any external call. This ensures a stale client session cannot trigger Telegram sends.

Mutations accept `idempotencyKey: v.string()` per business rule #15. Retries replay the cached `{ ok: true }` response instead of double-mutating.

Internal counterparts (`assignRole`, `archiveChat`, `restoreChat`, `listChats`) are internalMutation/internalQuery — available to other server-side code without a session.

### Decision F — Backward-compatible env-var fallback

`TELEGRAM_CHAT_ID` is honored as a fallback if the `managers` role is unbound in `telegramChats`. The fallback is controlled by the `TELEGRAM_FALLBACK_ROLE` env var (set to `"managers"` on deployments that migrated from the v0.3 single-env-var model). This allows zero-downtime cutover: deployments with an existing `TELEGRAM_CHAT_ID` continue to deliver notifications to that chat until an operator runs `seedChatFromEnv` (or calls `mgrAssignRole`) to bind the `managers` role in the registry. After binding, `TELEGRAM_CHAT_ID` becomes inert.

`seedChatFromEnv` (internalAction) automates the one-time migration: it reads `TELEGRAM_CHAT_ID` + `TELEGRAM_BOT_TOKEN`, calls `getChat` to resolve the current title and type, then upserts the row with the given role. The operator runbook (Task 33 — `RUNBOOK-telegram.md`) documents the exact migration steps.

### Decision G — Role type system

`KNOWN_TELEGRAM_ROLES` in `convex/telegram/config.ts` is the single source of truth for valid role strings:

```ts
export const KNOWN_TELEGRAM_ROLES = ["managers", "founders"] as const;
```

`isKnownTelegramRole(s)` is the type-guard used by `assertKnownRole` in chatRegistry.ts. Adding a role means editing `config.ts` only — no schema migration, no index change. The `role` column on `telegramChats` is `v.optional(v.string())` at the schema level; the invariant is enforced at the application layer.

## Alternatives considered

- **Multiple env vars (`TELEGRAM_MANAGERS_CHAT_ID`, `TELEGRAM_FOUNDERS_CHAT_ID`, …).** Rejected: every new role or chat rotation requires a deployment config change. Ops cannot self-heal; developers are in the critical path.
- **Separate `mgrAdmin.ts` module for chat registry admin.** Rejected by spike: co-location in `chatRegistry.ts` reduces the surface and avoids a thin pass-through module. The original plan called for a separate file; the implementation consolidated.
- **Telegram `callback_data` buttons for approve/deny.** Rejected by [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md): the two-stage token-VIEW / PIN-ACT model requires the manager to open the POS web UI to enter their PIN. A callback_data button would complete the action in the Telegram thread without PIN verification. The approval message uses an inline URL button (`approve_url`) that opens `/approve/:token`; no callback_data is used.
- **Hard-coded `ADMIN_KEY` pattern from the starter.** Rejected: Frollie POS already has a manager-session credential store. Introducing a separate long-lived shared secret creates a second auth surface with no lockout policy. The starter's `requireAdminKey` is replaced by `requireManagerSession`.

## Consequences

- *Easier:* chat reassignment (rename, rejoin, role swap) requires no code change or deployment — send `/register` and call `mgrAssignRole`. Multiple distinct Telegram groups each get a typed role. `getChatIdByRole` throws on misconfiguration, surfacing the error early rather than silently skipping notifications.
- *Operational requirement:* on a fresh deployment, the `managers` role must be bound in `telegramChats` before any approval notification can be sent. The env-var fallback (Decision F) covers deployments migrating from v0.3. New deployments must run the registration flow during setup.
- *Audit trail:* `telegramChats.registeredAt` / `lastSeenAt` / `archivedAt` give a full operator-visible history. `lastError` surfaces send failures per chat.
- *Role type safety:* `KNOWN_TELEGRAM_ROLES` gates role assignments at the application layer. Typos are caught at `mgrAssignRole` call time, not silently stored.
- *One bot, many chats:* the same bot instance can simultaneously serve the `managers` group and the `founders` group. No second bot token needed.

## References

- [ADR-005](./005-manager-pin-one-off.md) — manager PIN one-off gates; `requireManagerSession` is the auth primitive used by `mgr*` mutations
- [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md) — token authorises VIEW / PIN authorises ACT; approval URL buttons do not use callback_data
- [ADR-034](./034-deep-modules-surface-apis.md) — module boundaries; `convex/telegram/` is foundational allow-listed infrastructure
- [ADR-035](./035-telegram-as-internal-comms.md) — Telegram as the internal comms infrastructure; this ADR extends that decision
- Business rule #15 — every public mutation accepts `idempotencyKey`; `mgr*` mutations comply
- [`convex-telegram-bot-starter`](https://github.com/lucasyhzhu-debug/convex-telegram-bot-starter) — the self-registration pattern this ADR ports and adapts
