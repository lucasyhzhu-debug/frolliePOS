# Telegram Bot Runbook

Diagnostic guide for the Frollie POS Telegram integration. Use this when messages stop landing in the group, when button callbacks fail, or before promoting Telegram to prod.

**See also:** [`docs/PATTERNS/telegram-bot-integration.md`](./PATTERNS/telegram-bot-integration.md) for the portable setup process.

---

## Quick reference

| Symptom | Most likely cause | Section |
|---------|-------------------|---------|
| `npx convex run "telegram/send:sendTemplate" ...` returns `"Bad Request: chat not found"` | Wrong `TELEGRAM_CHAT_ID` (most common: group migrated to supergroup) | [Wrong chat_id](#wrong-chat_id) |
| `getUpdates` returns `{"result":[]}` despite messages being sent | Cached `allowed_updates` filter from prior `setWebhook` | [allowed_updates trap](#the-allowed_updates-trap) |
| `getUpdates` returns 409 Conflict | Webhook is active; can't poll while webhook is set | [Webhook vs polling conflict](#webhook-vs-polling-conflict) |
| Button tap in Telegram does nothing, no IN row appears in `telegram_log` | Webhook secret mismatch OR webhook URL wrong | [Webhook not firing](#webhook-not-firing) |
| Original message doesn't update after button tap | `editMessageText` failed (message deleted, or different message_id) | [editMessageText silent failure](#editmessagetext-silent-failure) |
| `npx convex run` works but no message arrives in Telegram | Bot removed from group, or token rotated | [Bot connectivity](#bot-connectivity) |
| All Convex env vars set, but action says "Telegram env vars missing" | Env was set on the wrong deployment (dev vs prod) | [Wrong Convex deployment](#wrong-convex-deployment) |

---

## Wrong chat_id

**Symptom:** Convex action returns `Telegram sendMessage failed: 400 {"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`.

**Most common cause:** the group's chat_id changed format. Telegram silently migrates basic groups (`-NNN`) to supergroups (`-100NNN`) when:
- The group exceeds member count thresholds
- An admin enables certain features
- A bot is added or promoted (sometimes triggers migration)

Less common: bot was removed from the group, or chat_id is a transcription error (extra/missing digit).

**Diagnose:**

```powershell
# 1. Confirm current env value (don't paste the actual chat_id in any logs)
npx convex env get TELEGRAM_CHAT_ID

# 2. Confirm the bot is in the group (open Telegram → group → members)

# 3. Re-fetch the authoritative chat_id from getUpdates (see "allowed_updates trap" below)
```

**Fix:** Update env to the real id from step 3:

```powershell
npx convex env set TELEGRAM_CHAT_ID -- <new_id>
```

The `--` separator is required because the value starts with `-`.

---

## The allowed_updates trap

**Symptom:** `getUpdates` returns `{"ok":true,"result":[]}` even though you just sent multiple messages to the bot.

**Cause:** When `setWebhook` was called with `allowed_updates: ["callback_query"]`, Telegram persists that filter. Subsequent calls to `getUpdates` inherit it — so `message` updates are silently dropped.

**Fix:** Explicitly pass `allowed_updates` to `getUpdates`:

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getUpdates?allowed_updates=%5B%22message%22%2C%22callback_query%22%5D&timeout=10"
```

The URL-encoded blob is `["message","callback_query"]`. The `timeout=10` long-polls for 10 seconds.

After this works, you'll see the message updates and can extract the real `chat.id`.

---

## Webhook vs polling conflict

**Symptom:** `getUpdates` returns `{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}`. 

Or: `getUpdates` returns nothing because Telegram is delivering everything to the webhook URL instead.

**Cause:** Once a webhook is set, Telegram routes updates ONLY to the webhook. You can't poll AND use a webhook simultaneously.

**Fix to use polling temporarily** (for chat_id discovery):

```powershell
# Delete the webhook
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

# Now getUpdates works
curl.exe "https://api.telegram.org/bot<TOKEN>/getUpdates?allowed_updates=%5B%22message%22%2C%22callback_query%22%5D&timeout=10"

# When done, re-register the webhook
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" `
  -d "url=https://helpful-grasshopper-46.convex.site/telegram-webhook" `
  -d "secret_token=<SECRET>" `
  -d 'allowed_updates=["message","callback_query"]'
```

Note: `allowed_updates` must include `"message"` so `/register` and `/start` commands are delivered. See also [LESSON 6 — BotFather privacy mode](#lesson-6--botfather-privacy-mode-and-setcommands) (in the v0.4 lessons section at the bottom).

---

## Webhook not firing

**Symptom:** User taps an inline button in Telegram, but no IN row appears in `telegram_log`. The OUT row exists; the IN row doesn't.

**Diagnostic order:**

1. **Is the webhook registered?**
   ```powershell
   curl.exe "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```
   - Expect `"url": "https://helpful-grasshopper-46.convex.site/telegram-webhook"`.
   - If `url` is empty, the webhook isn't registered — call `setWebhook` again.

2. **Does `getWebhookInfo` show a `last_error_message`?**
   - Common errors: `"Wrong response from the webhook: 401 Unauthorized"` → secret mismatch. `"SSL error"` → URL is wrong (probably using `.convex.cloud` instead of `.convex.site`).
   - Telegram retries on non-200 responses for ~24h. After exhausting retries, it gives up on that update.

3. **Test the webhook with a forged request:**
   ```powershell
   # Without secret — should return 401
   curl.exe -i -X POST "https://helpful-grasshopper-46.convex.site/telegram-webhook" -H "Content-Type: application/json" -d "{}"
   ```
   - If this returns 401 with body `"unauthorized"`, the security check works.
   - If it returns 200 or 5xx, the httpAction is broken — check Convex logs.

4. **Is the secret in Convex env the same one passed to `setWebhook`?**
   - `npx convex env get TELEGRAM_WEBHOOK_SECRET` should match the `secret_token` value in your `setWebhook` call. If you've rotated either, re-set both.

---

## editMessageText silent failure

**Symptom:** Tapping a button creates an IN row in `telegram_log` (so the webhook fires), but the original message in Telegram never updates ("✅ Approved by …" doesn't appear, buttons stay live).

**Cause:** `editMessageText` failed. Most common reasons:
- Original message was deleted from Telegram before the button was tapped.
- `message_id` mismatch (rare; only happens if `recordCallback` was called with a stale `message_id`).
- `parse_mode: "HTML"` rejected because the rewrite text contains unescaped HTML chars.

**Diagnose:** Check Convex logs (`convex dashboard → Logs`) for a warning starting with `editMessageText failed`. As of commit `cb7aa69`, the webhook logs these explicitly.

**Fix:** Send the message again and re-tap. If it persists, escape the username before injecting it into the rewrite text.

---

## Bot connectivity

**Symptom:** `npx convex run` succeeds (the action returned `{ok: true}`), Telegram API returned `{ok: true}`, but the message never appears in the group.

**Cause:** Bot was removed from the group. Telegram still accepted the `sendMessage` call because the chat_id is valid (the group exists), but the message is silently dropped because the bot isn't a member.

Actually — Telegram usually returns `Forbidden: bot is not a member of the group` in this case. If you see "ok: true" but no message, more likely causes are:
- The Telegram dev group is muted on your end (notifications, not delivery).
- The message was actually delivered but you're looking at the wrong group.

**Diagnose:**

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getMe"
```

Should return the bot's identity. If this fails with `Unauthorized`, the token was revoked.

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getChat?chat_id=<CHAT_ID>"
```

Returns chat metadata if the bot can see the chat. If it returns `Forbidden`, the bot isn't a member.

**Fix:** Add the bot back to the group; re-test.

---

## Wrong Convex deployment

**Symptom:** Action throws "Telegram env vars missing" even though `npx convex env list` shows them set.

**Cause:** Env vars were set on a different deployment than the one Convex is currently using. Check the active deployment:

```powershell
npx convex env list
# Look at the first line — it tells you which deployment is targeted
```

**Two deployments exist for Frollie POS:**
- `helpful-grasshopper-46` (dev) — what `npx convex dev` uses by default
- `savory-zebra-800` (prod) — what `npx convex deploy` targets

If you set env vars on prod but are running against dev (or vice versa), they won't be visible.

**Fix:** Set the env vars on the deployment you're actually using. To target prod explicitly:

```powershell
npx convex env set TELEGRAM_BOT_TOKEN <value> --prod
```

---

## Promoting Telegram from dev to prod — checklist

When the Telegram integration is ready to ship to prod:

1. **Create a separate prod bot** via BotFather (don't reuse the dev bot — separate tokens means a dev test message can't accidentally hit the production manager group).
2. **Create the prod Telegram group(s)** (Managers, Founders, etc.) and add the prod bot.
3. **Discover prod chat_id(s)** following the same process as dev (see `docs/PATTERNS/telegram-bot-integration.md`).
4. **Set prod env vars:**
   ```powershell
   npx convex env set TELEGRAM_BOT_TOKEN <prod_token> --prod
   npx convex env set TELEGRAM_CHAT_ID -- <prod_chat_id> --prod
   npx convex env set TELEGRAM_WEBHOOK_SECRET <new_random_secret> --prod
   npx convex env set POS_BASE_URL https://frollie-pos.vercel.app --prod
   npx convex env set TELEGRAM_FALLBACK_ROLE managers --prod
   npx convex env set TELEGRAM_BOT_USERNAME <bot_username_without_at> --prod
   ```
   `TELEGRAM_BOT_USERNAME` is the bot username without the `@` prefix (e.g. `FrolliePOS_Bot`). Required for the owner binding deep-link (`https://t.me/<bot>?start=<token>`). Set on **both** dev and prod.
5. **Deploy the code:** `npx convex deploy`
6. **Register the prod webhook:**
   ```powershell
   curl.exe -X POST "https://api.telegram.org/bot<PROD_TOKEN>/setWebhook" `
     -d "url=https://savory-zebra-800.convex.site/telegram-webhook" `
     -d "secret_token=<PROD_SECRET>" `
     -d 'allowed_updates=["message","callback_query"]'
   ```
   Note: `allowed_updates` now includes `"message"` in addition to `"callback_query"` — the `/register` and `/start` commands arrive as `message` updates. Without it, chat self-registration won't work.
7. **Smoke test** the round-trip in prod with a non-disruptive message.
8. **Verify** `getWebhookInfo` against the prod token shows `pending_update_count: 0` and no `last_error_message`.

---

## Self-registration operator flow (v0.4)

v0.4 replaces the manual `TELEGRAM_CHAT_ID` env-var approach with a self-registration registry. Each Telegram group sends `/register` to the bot, and a manager assigns the group's role via the `/mgr/telegram-chats` UI.

**Initial setup (per environment):**

1. **Create the role groups** in Telegram (e.g. "Frollie · Managers" and "Frollie · Founders"). Add `@FrolliePOS_Bot` (or whatever your bot username is) to each group.
2. **Register each group** — in each group chat, any member sends: `/register` (or `/register@YourBotUsername` in supergroups). The bot replies with a confirmation message containing the `chat_id` and a link to the admin UI.
3. **Open the admin UI** at `<POS_BASE_URL>/mgr/telegram-chats` (requires a manager session). This is `api.telegram.chatRegistry.mgrListChats`.
4. **Assign a role** to each registered chat via the `<Select>` dropdown — choose `managers`, `owners`, `inventory`, or `ops`. **v2.0:** for a per-outlet role (`managers`/`inventory`) a second **outlet picker** appears — pick the outlet before the bind is sent (it calls `api.telegram.chatRegistry.mgrAssignRole` with `outletId`); business roles (`owners`/`ops`) assign immediately with no outlet. The list is grouped by outlet (plus a "Business-wide" section). Binding an outlet-scoped role without an outlet throws `OUTLET_REQUIRED_FOR_ROLE`; binding a business role with an outlet throws `OUTLET_NOT_ALLOWED_FOR_ROLE`.
5. **Send a test message** via the "Send test message" button on each row to confirm delivery. This calls `api.telegram.chatRegistry.mgrSendTest`.
6. Once both chats have confirmed roles, the `TELEGRAM_CHAT_ID` / `TELEGRAM_FALLBACK_ROLE` env vars can remain as a fallback but are no longer the primary routing path.

---

## `/activatepos` — off-booth device activation (v0.5.7)

A manager who is away from the booth can mint a device setup code without physical access to a logged-in POS. In the chat bound to the **`managers`** role, send:

```
/activatepos
```

The bot replies with a 6-digit setup code (15min TTL — SEC-04) and a `<POS_BASE_URL>/activate` link. The new phone/browser opens that link and enters the code to register itself.

- **Chat-role gated:** any chat whose row has `role === "managers"` can mint codes *(v2.0: per-outlet — any outlet's managers chat works, not just a single one)*; the command is ignored in any other chat. Bind a chat to `managers` first (see [Self-registration operator flow](#self-registration-operator-flow-v04)). The minted code is outlet-less (no device pre-assign — decision C); the device is bound to its outlet later via the manager-PIN `assignDeviceOutlet` flow.
- **`POS_BASE_URL` must be set** on the deployment — the activation link is built from it.

**Operational gotcha — group privacy mode swallows `/activatepos`.** The managers chat is a supergroup, and Telegram bot **privacy mode is ON by default**, so a bare `/activatepos` typed in the group is NOT delivered to the bot. Two fixes:

1. **(Recommended) Disable privacy mode:** BotFather → `/setprivacy` → select the bot → **Disable**. Then **remove and re-add the bot to the group** (privacy mode only takes effect on (re)join).
2. **Or use the explicit mention form:** managers type `/activatepos@<bot_username>` — the command matcher accepts the `@Bot` suffix and Telegram always delivers `@`-mentioned commands regardless of privacy mode.

Register the command via BotFather `/setcommands` as `activatepos - mint a device setup code` so it autocompletes (with the `@Bot` form when privacy mode is on).

---

## Lessons from v0.4 development

### LESSON 6 — BotFather privacy mode and `/setcommands`

After creating or updating the bot, set privacy mode so the bot only receives messages that are directed at it (commands starting with `/`, or messages the bot is directly mentioned in):

1. Message BotFather: `/setprivacy` → select your bot → choose **Enable**.
2. Optionally: `/setcommands` → paste the command list so Telegram shows autocomplete:
   ```
   register - Register this chat with the Frollie POS bot
   start - Show help / bot info
   activatepos - mint a device setup code
   ```

Without privacy mode, the bot receives every message in the group — unnecessary network traffic and potential `allowed_updates` confusion.

---

### LESSON 8 — PowerShell mangles negative chat IDs

Supergroup chat IDs are negative (`-100XXXXXXXXXX`). PowerShell interprets the leading `-` as a flag prefix in some contexts.

**Safe pattern:**

```powershell
# DO THIS: quote the value or use the KEY=VALUE form
npx convex env set TELEGRAM_CHAT_ID "-100123456789"

# OR: use -- to signal end-of-flags, then the value
npx convex env set TELEGRAM_CHAT_ID -- -100123456789
```

Do NOT use shell variable expansion with negative IDs — the shell may strip the sign.

---

### LESSON 9 — Supergroup migration changes the chat ID

When a Telegram basic group becomes a supergroup, its `chat_id` changes from `-NNN` to `-100NNN`. Telegram triggers this migration when:
- Group member count crosses certain thresholds.
- An admin enables certain features (e.g. linked channels, slow mode).
- A bot is added or promoted to admin in some configurations.

**How to detect it:** the `lastSeenAt` field in the `telegramChats` row updates on every webhook event from that chat. If a bot stops receiving messages from a previously-working chat, open the Convex dashboard → `telegramChats` table and check whether the `chatId` matches what you expect.

**Fix:**
1. Archive the old row in `/mgr/telegram-chats` (it now has the wrong `chatId`).
2. In the new supergroup, send `/register` again — the bot will receive it with the new `-100NNN` chat ID and create a fresh row.
3. Assign the role to the new row, remove the old archived row.

The `TELEGRAM_CHAT_ID` env-fallback also needs updating if you still rely on it.

---

## Manual owners-summary test

*(v2.0 Spec 4 — renamed from "founders-summary"; the symbol was `telegram/foundersSummary:sendFoundersSummary`.)*

To fire the daily summary immediately (the default outlet's toggle must be ON, `owners` role must be bound):

```powershell
npx convex run telegram/ownersSummary:sendOwnersSummary
```

This calls the same logic as the 22:00 WIB cron but skips the resilient retry wrapper. It sends the business-wide `owners` rollup PLUS a per-outlet `managers_daily_summary` for each active outlet whose own toggle is on. If it returns `{ skipped: "disabled" }`, check the default outlet's `founders_summary_enabled` toggle in `/mgr/telegram-chats`. If it skips with `role_unbound`, bind the `owners` chat first (a `founders`-bound chat is accepted as a transitional alias until the backfill rebinds it to `owners`).

---

## Environment variable reference

Set on **both** dev (`npx convex env set KEY VALUE`) and prod (`npx convex env set KEY VALUE --prod`). PowerShell mangles negative chat IDs — see [LESSON 8](#lesson-8--powershell-mangles-negative-chat-ids).

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From BotFather. Never share. Use separate bots for dev and prod. |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Random string; passed as `secret_token` to `setWebhook`. Verified on every inbound update. |
| `POS_BASE_URL` | Yes | Base URL of the frontend (e.g. `https://frollie-pos.vercel.app`). Used to build `/approve/:token` URLs in Telegram messages. |
| `TELEGRAM_CHAT_ID` | Fallback only | Legacy env-fallback for the `managers` role until `getChatIdByRole` finds a bound row. Required during initial setup before `/mgr/telegram-chats` assigns roles. Keep set during prod cutover. |
| `TELEGRAM_FALLBACK_ROLE` | Fallback only | Which role the `TELEGRAM_CHAT_ID` fallback applies to (usually `managers`). Must match `TELEGRAM_CHAT_ID` to work. |
| `TELEGRAM_BOT_USERNAME` | Yes *(v2.0)* | Bot username without `@` (e.g. `FrolliePOS_Bot`). **Required for owner binding deep-links** (`https://t.me/<bot>?start=<token>`). Also used in `/start` help text. Set on **both** dev and prod. |
| `TELEGRAM_ADMIN_URL` | Optional | URL to the `/mgr/telegram-chats` admin UI. Shown in `/register` confirmation messages. Defaults to `POS_BASE_URL/mgr/telegram-chats`. |

## Telegram roles

`KNOWN_TELEGRAM_ROLES` in `convex/telegram/config.ts`. Roles are bound to registered chats via `/mgr/telegram-chats`. `sendTemplate` dispatches by role (with the legacy `TELEGRAM_CHAT_ID` env-fallback for `managers` only).

**v2.0 (Spec 4) — routing is two-tier `(role, outlet_id)`.** `ROLE_SCOPE` declares each role `outlet` or `business`:
- **Per-outlet roles** (`managers`, `inventory`): bound to a SPECIFIC outlet. Bind via `/mgr/telegram-chats` — pick the role, then pick the outlet from the outlet picker. Each outlet can have its own managers/inventory chat; a send routes to the chat bound to `(role, that outlet)`. During the transitional window (Step-1 deployed, backfill not yet run) a single bare-`managers` row still routes via the single-outlet fallback (gated on exactly-one-active-outlet).
- **Business-wide roles** (`owners`, `ops`): one chat for the whole business, no outlet. Bind via `/mgr/telegram-chats` (no outlet picker shown).

| Role | Scope | Purpose |
|---|---|---|
| `managers` | per-outlet | Off-booth approval requests (PIN resets, manual payment overrides, refunds) + per-shift signoff summary + **recount notices** (`recount_notice` routes to `managers`, NOT `inventory`) + the daily per-outlet `managers_daily_summary`. Bind first. |
| `owners` *(v2.0, was `founders`)* | business-wide | Daily business-wide shift-summary rollup at 22:00 WIB (ADR-033), with a per-outlet breakdown. Opt-out via the default outlet's `pos_settings.founders_summary_enabled`. (`founders` is accepted as a transitional alias until the backfill rebinds the chat to `owners`.) |
| `inventory` *(v0.5.2)* | per-outlet | Operations chat that receives low-stock alerts + `stock_drift_alert` for THAT outlet. Bind via `/mgr/telegram-chats` (with outlet). |
| `ops` *(v1.0.1)* | business-wide | POS error/crash alerts — deduped/storm-capped backend, payment, mutation and crash failures from the launch-day error pipe (`system_error` template, which now also renders the originating outlet label). Bind a dedicated "Frollie · Ops" chat via `/mgr/telegram-chats`. |

## Template kinds

`sendTemplate` (`convex/telegram/send.ts`) renders by template kind. Approval kinds carry a `/approve/:token` URL button; informational kinds carry none.

| Kind | Routes to | Button | Notes |
|---|---|---|---|
| `system_error` *(v1.0.1)* | `ops` | none (informational) | Fired by the error pipe when a `pos_error_reports` row crosses the dedup/storm-cap gate. *(v2.0)* Renders the originating outlet label when the report carries an `outlet_id`; routing stays business-wide (`ops`, no outlet scoping). |
| `txn_ticker` *(v1.0.1)* | `managers` | none (informational) | Live sales ticker — one message per paid sale. Sent **silent** (`disableNotification`) so the running feed never buzzes. Toggle via `pos_settings.txn_ticker_enabled` (default on). **Launch path (v1.0.2):** open `/mgr/telegram-chats` as a manager → toggle **"Post each paid sale to the Managers channel"** off. Takes effect on the next paid sale; no deploy. **Break-glass:** the Convex-dashboard `pos_settings.txn_ticker_enabled = false` edit still works if the FE is unavailable. |
| `owner_otp` *(v2.0)* | private DM to `staff.telegram_user_id` | none (informational) | Sent via `chatIdOverride` directly to the owner's Telegram user ID — **not** to any group role. The 6-digit code is **REDACTED** from `telegram_log` (C3). `KNOWN_TELEGRAM_ROLES` is unchanged. |
| `managers_daily_summary` *(v2.0 Spec 4)* | `managers` (per-outlet) | none (informational) | One per active outlet per day, sent by the `owners-shift-summary` cron alongside the business-wide owners rollup. Per-outlet idempotency key `mgrsum:<outletCode>:<dateLabel>`. Each outlet's send respects THAT outlet's `founders_summary_enabled` toggle; an unbound outlet chat → audited skip for that outlet only (loop not aborted). |
| `shift_summary` *(owners rollup, v2.0)* | `owners` (business-wide) | none (informational) | The daily rollup; payload gains an optional `perOutlet[]` breakdown beneath the business total. Idempotency key `owners:<dateLabel>`. |

---

## Owner auth — first-owner cutover sequence (v2.0)

One-time setup per deployment to enable cockpit login for the owner.

**Prerequisites:** `TELEGRAM_BOT_USERNAME` set on the target deployment; the owner has messaged any bot before so Telegram will permit the DM (the binding `/start` step itself opens the channel).

1. **Promote a manager to owner:**
   ```
   # As a booth manager, enter your PIN to promote the target staff row to "owner"
   # via the /mgr/staff UI → setStaffRole (manager-PIN action).
   # Owner is never minted by createStaff — promotion only.
   ```

2. **Issue a binding link** (manager-PIN or existing owner action `issueOwnerBindLink`):
   ```powershell
   # The action returns a deep-link of the form:
   # https://t.me/<TELEGRAM_BOT_USERNAME>?start=<single-use-token>
   ```

3. **Send the link to the owner** (e.g. copy-paste, or the cockpit UI will surface it). The owner taps the deep-link on their personal phone.

4. **Owner taps `/start <token>` in the Telegram bot DM.** The bot webhook fires: validates the token (single-use, 60-min TTL), writes `staff.telegram_user_id = from.id`, opens the DM channel, emits `owner.telegram_bound` audit verb.

5. **Owner requests first OTP** from the cockpit login screen at `<POS_BASE_URL>/cockpit/login` (Task 7 FE — pending). Enters their `staff.code` → bot sends 6-digit code to their private DM.

6. **Owner enters OTP.** On success: `kind: "cockpit"` session minted, `owner.login` audited. From this point, cockpit sessions can be resumed via quick-PIN on remembered devices.

**Recovery — owner loses Telegram access:** issue a new binding link from a manager or another owner (step 2–4). The old `telegram_user_id` is overwritten on successful re-bind.

**`owner_otp` delivery failure diagnosis:**
- `staff.telegram_user_id` absent → binding step was never completed. Re-issue the bind link.
- Bot returns `"Forbidden: bot was blocked by the user"` → owner blocked the bot. Ask them to unblock via Telegram → `@<BotUsername>` → **Unblock**.
- `TELEGRAM_BOT_USERNAME` unset → deep-link generation throws. Set the env var on the correct deployment and redeploy.
