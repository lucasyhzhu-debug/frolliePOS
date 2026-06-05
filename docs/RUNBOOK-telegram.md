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
   ```
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
4. **Assign a role** to each registered chat via the `<Select>` dropdown — choose `managers` or `founders`. This calls `api.telegram.chatRegistry.mgrAssignRole`.
5. **Send a test message** via the "Send test message" button on each row to confirm delivery. This calls `api.telegram.chatRegistry.mgrSendTest`.
6. Once both chats have confirmed roles, the `TELEGRAM_CHAT_ID` / `TELEGRAM_FALLBACK_ROLE` env vars can remain as a fallback but are no longer the primary routing path.

---

## `/activatepos` — off-booth device activation (v0.5.7)

A manager who is away from the booth can mint a device setup code without physical access to a logged-in POS. In the chat bound to the **`managers`** role, send:

```
/activatepos
```

The bot replies with a 6-digit setup code (1h TTL) and a `<POS_BASE_URL>/activate` link. The new phone/browser opens that link and enters the code to register itself.

- **Chat-role gated:** only the chat bound to the `managers` role can mint codes; the command is ignored in any other chat. Bind a chat to `managers` first (see [Self-registration operator flow](#self-registration-operator-flow-v04)).
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

## Manual founders-summary test

To fire the founders shift-summary immediately (toggle must be ON, `founders` role must be bound):

```powershell
npx convex run telegram/foundersSummary:sendFoundersSummary
```

This calls the same logic as the 22:00 WIB cron but skips the resilient retry wrapper. If it returns `{ skipped: "disabled" }`, check the `founders_summary_enabled` toggle in `/mgr/telegram-chats`. If it throws `"No Telegram chat assigned to role 'founders'"`, bind the founders chat first.

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
| `TELEGRAM_BOT_USERNAME` | Optional | Used in `/start` help text and test-message copy. Defaults to `FrolliePOS_Bot` in `config.ts`. |
| `TELEGRAM_ADMIN_URL` | Optional | URL to the `/mgr/telegram-chats` admin UI. Shown in `/register` confirmation messages. Defaults to `POS_BASE_URL/mgr/telegram-chats`. |

## Telegram roles

`KNOWN_TELEGRAM_ROLES` in `convex/telegram/config.ts`. Roles are bound to registered chats via `/mgr/telegram-chats`. `sendTemplate` dispatches by role (with the legacy `TELEGRAM_CHAT_ID` env-fallback for `managers` only).

| Role | Purpose |
|---|---|
| `managers` | Off-booth approval requests (PIN resets, manual payment overrides, refunds). Bind first. |
| `founders` | Daily shift-summary cron at 22:00 WIB (ADR-033). Opt-out via `pos_settings.founders_summary_enabled`. |
| `inventory` *(v0.5.2)* | Operations chat that receives recount notices + low-stock alerts. Bind via `/mgr/telegram-chats`. |
