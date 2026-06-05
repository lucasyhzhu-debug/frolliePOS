# Design — `/activatepos` Telegram device-activation command

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan
**Author:** brainstorming session

## Problem

Today, minting a 6-digit device setup code (`staff.generateDeviceSetupCode`,
`convex/staff/public.ts:113`) requires a **manager session** — you must already be
PIN-logged-in on an already-registered device. This is a bootstrapping catch-22:
a brand-new phone/browser cannot get itself a code, and an off-booth manager has
no way to bring a new device online without physically being at the booth on a
registered device.

We want a Telegram command, `/activatepos`, that any member of the managers
Telegram chat can issue; the bot replies with a fresh 6-digit setup code so a new
device can be activated on the fly.

## Goals

- Off-booth manager mints a device setup code from Telegram in one message.
- No weakening of the actual device-registration security control: the code stays
  single-use, 1h TTL, and a registered device alone grants nothing (staff still
  authenticate with a PIN).
- Honest audit trail: records that the code came from Telegram, and which Telegram
  user triggered it.

## Non-goals

- Creating staff accounts. The 6-digit code only registers a *device*; staff still
  log in with their PIN afterward. "Activate new accounts" in the original ask means
  "bring a new device online," not "mint a staff record."
- A Telegram-user → staff-member mapping table. Out of scope (see Attribution).
- Changing the booth `/mgr` code-issuance UI.

## Decisions (locked during brainstorming)

1. **Authorization model: instant issuance, gated to the managers-role chat.**
   The bot replies with a code immediately, but only when the incoming `chatId`
   equals the chat bound to the `managers` Telegram role. Trust = managers-chat
   membership — the same trust boundary that already receives `/approve` cards.
   Rejected: PIN-gated `/approve` flow (defeats "on the fly"); per-sender allowlist
   (unneeded — chat membership is the boundary).

2. **Attribution: `issued_via` discriminant.** `pending_device_setups.issued_by`
   becomes optional; a new `issued_via` field distinguishes booth vs Telegram, and
   the Telegram sender's `fromId` + chat title are recorded. Audit `source` is
   `telegram_approval`. Rejected: fromId→staff mapping (no such table, too heavy);
   sentinel-only (loses the human).

3. **Command name: `/activatepos`** (lowercase — BotFather requires `[a-z0-9_]`;
   the command matcher is case-sensitive).

## Authorization & trust boundary

- The command dispatches only when `msg.chatId === getChatIdByRole("managers")`.
- Any other chat → **silent 200, no reply**, identical to how the webhook treats
  an unknown slash command (`convex/telegram/webhook.ts:91`). This avoids
  advertising the command's existence to non-manager chats.
- The setup code remains single-use, 1h TTL (`SETUP_CODE_TTL_MS`), collision-checked.
- A registered device grants no access on its own — staff still enter a valid PIN
  (foundations §6 security control preserved).

## Schema changes

`docs/SCHEMA.md` first, then `convex/auth/schema.ts`:

- `pending_device_setups.issued_by` → `v.optional(v.id("staff"))`
- `pending_device_setups.issued_via` → `v.optional(v.union(v.literal("booth_inline"), v.literal("telegram")))`
  (absent = booth, preserving existing rows)
- `pending_device_setups.issued_by_telegram` → `v.optional(v.object({ from_id: v.number(), chat_title: v.string() }))`
- `registered_devices.activated_by` → `v.optional(v.id("staff"))`

**Cascade rationale:** `activateDevice` (`convex/staff/public.ts:159`) copies
`pending.issued_by` into both `registered_devices.activated_by` and the
`device.activated` audit `actor_id`. When a Telegram-issued code is consumed,
`issued_by` is absent, so `activated_by` must also be optional, and the audit row
uses the existing `"system"` actor sentinel (`logAudit` already accepts
`Id<"staff"> | "system"`, `convex/audit/internal.ts:27`). No new audit column.

## Single-writer code generation (anti-drift)

Extract the collision-retry loop + `pending_device_setups` insert + issuance audit
currently inlined in `generateDeviceSetupCode` into a shared internal helper:

```
_issueDeviceSetupCode_internal(ctx, {
  issuedVia: "booth_inline" | "telegram",
  issuedBy?: Id<"staff">,            // booth path
  telegramIssuer?: { fromId, chatTitle },  // telegram path
  deviceId?: string,                 // booth path, for audit device_id
}) -> { code, expiresAt }
```

Both the existing public booth mutation and the new Telegram action call it — one
writer for `pending_device_setups`, preventing the multi-writer drift called out in
the v0.5.5 canonical-insert lesson. The booth mutation keeps its
manager-session + idempotency + authCheck wrapper unchanged; only its body delegates
to the helper.

## Telegram flow

1. New `CommandRegistration` for `activatepos`, added to the registry array in
   `convex/http.ts` alongside `buildRegistryCommands(scheduler)`. Lives in a new
   `convex/telegram/activatePos.ts` (factory `buildActivatePosCommand(scheduler)`
   for symmetry with `buildRegistryCommands`).
2. `dispatch` schedules `internal.telegram.activatePos.handleActivatePos` with the
   `MessageContext` (chatId, chatType, title, fromId).
3. `handleActivatePos` (internalAction):
   a. Resolve `getChatIdByRole("managers")`; if it throws (no managers chat bound)
      or `!== msg.chatId`, return silently (no reply).
   b. Call `_issueDeviceSetupCode_internal` via `ctx.runMutation` with
      `issuedVia: "telegram"`, `telegramIssuer: { fromId, chatTitle: title }`.
   c. `sendTelegramHtml` the reply (below). On send failure, record nothing extra —
      the code is already minted and usable; the manager can re-issue.

## Reply UX

```
🔓 Device setup code: <b>123456</b>
Valid until 14:32 WIB (1 hour).
On the new phone/browser, open <POS_BASE_URL>/activate and enter the code.
```

- `POS_BASE_URL` is the same env the `/approve` URL buttons use.
- WIB time formatted via `convex/lib/time.ts` (`WIB_OFFSET_MS`).
- All interpolated values HTML-escaped via `escapeHtml`.

## Audit

- Issuance: `action: "device.setup_code_issued"`, `actor_id: "system"`,
  `source: "telegram_approval"`, `entity_type: "device"`,
  `metadata: { telegram_from_id, chat_title }`.
- Activation (existing `activateDevice`, telegram-sourced code): `actor_id: "system"`,
  `metadata.activated_via: "telegram"` added alongside existing metadata. Booth-sourced
  activations keep `actor_id: pending.issued_by` unchanged.

## Testing

`convex-test` (edge-runtime config per `convex-test-vitest-config` memory):

1. Issues a valid code when the command comes from the managers-role chat; row has
   `issued_via: "telegram"` and `issued_by_telegram` populated.
2. Silently ignores (no code, no send) when the command comes from a non-managers chat.
3. Silently no-ops when no chat is bound to `managers`.
4. End-to-end: a Telegram-issued code activates a device via existing `activateDevice`;
   `registered_devices.activated_by` absent, `device.activated` audit `actor_id: "system"`.
5. Audit row for issuance has `source: "telegram_approval"` + `telegram_from_id` metadata
   (audit metadata is a JSON string — parse in the assertion, per v0.5.5 lesson).
6. Pure unit: command matcher matches `/activatepos` and `/activatepos@Bot`, rejects
   `/activatepos extra`.

## Docs to update (same PR)

- `docs/SCHEMA.md` — new/changed `pending_device_setups` + `registered_devices` fields.
- `docs/API_REFERENCE.md` — new internal helper + Telegram action.
- `docs/RUNBOOK-telegram.md` — `/activatepos` command, managers-chat gating.
- `CLAUDE.md` — Telegram section command list.
- `docs/CHANGELOG.md`.

## Open questions

None outstanding.
