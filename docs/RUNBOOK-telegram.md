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
  -d 'allowed_updates=["callback_query"]'
```

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
   ```
5. **Deploy the code:** `npx convex deploy`
6. **Register the prod webhook:**
   ```powershell
   curl.exe -X POST "https://api.telegram.org/bot<PROD_TOKEN>/setWebhook" `
     -d "url=https://savory-zebra-800.convex.site/telegram-webhook" `
     -d "secret_token=<PROD_SECRET>" `
     -d 'allowed_updates=["callback_query"]'
   ```
7. **Smoke test** the round-trip in prod with a non-disruptive message.
8. **Verify** `getWebhookInfo` against the prod token shows `pending_update_count: 0` and no `last_error_message`.
