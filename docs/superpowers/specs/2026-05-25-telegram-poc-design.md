# Telegram Bot POC — Message Playground + Round-Trip Callbacks

**Status:** Approved, pending implementation
**Date:** 2026-05-25
**Author:** Lucas (brainstormed with Claude)
**Supersedes:** Nothing — POC only. Does NOT replace [ADR-027](../../../docs/ADR/027-wa-approval-via-staff-own-wa.md) or [ADR-033](../../../docs/ADR/033-founders-shift-summary-share.md) yet.

## Goal

Prove that a Telegram bot can replace **the internal staff-and-founders categories** of WhatsApp messaging in the Frollie POS wireframes:

1. **Manager approval requests** (refund, manual ✓, negative-stock acknowledgment) — currently [ADR-027](../../../docs/ADR/027-wa-approval-via-staff-own-wa.md), `wa.me` to *Frollie · Managers*
2. **End-of-shift summary** — currently [ADR-033](../../../docs/ADR/033-founders-shift-summary-share.md), `wa.me` to *Frollie · Founders*

The POC ships as a small **message-playground UI** that lets the operator pick a message template, fill in fields, send it to the dev Telegram group, and watch both outbound and inbound (button-press) activity update in real time.

The "wow" moment: tap **Send approval request** in the app → message lands in Telegram with two buttons → tap **Approve** in Telegram → the original message edits itself to "✅ Approved by @lucas" AND the POC UI shows the inbound callback row appear without a page refresh.

## Out of scope (explicit non-goals)

The following are deliberately NOT part of the POC. They get addressed in the eventual ADR-027/ADR-033 replacement(s), not here:

- **Customer-facing receipts stay on WhatsApp.** Telegram cannot replace this — customers don't have your bot, and the Telegram API requires opt-in (`/start`) before any user can receive messages. This is a hard platform constraint, not a design choice. Customer receipts remain on `wa.me` share-intent in v1; channel migration (SMS / email / drop digital) is a separate ADR.
- Integration with `pos_approval_requests` or any real approval flow
- PIN re-entry after Telegram approval (per [ADR-029](../../../docs/ADR/029-token-authorizes-view-pin-authorizes-act.md))
- Audit-log emission (per [ADR-007](../../../docs/ADR/007-audit-log-append-only.md))
- Idempotency-key wrapping (per [ADR-013](../../../docs/ADR/013-idempotency-keys.md))
- Per-manager identity verification (POC treats any Telegram user as "the approver")
- Multi-chat_id routing (POC uses one chat_id; production needs `TELEGRAM_CHAT_ID_MANAGERS` + `TELEGRAM_CHAT_ID_FOUNDERS`)
- Production deployment (POC stays on dev Convex deployment `helpful-grasshopper-46`)

## Architecture

```
[Browser UI]                       [Convex dev]                  [Telegram]
/dev/telegram                                                      api.telegram.org
                                                                           │
  [Template tabs]                                                   ┌──────┴──────┐
  ├─ Approval req  ─mutation─> action sendTemplate ──POST──>  ─────▶│   sendMessage│
  ├─ Shift summary             │                                    └──────┬──────┘
  └─ Custom                    │                                           │
                               ▼                                           │
                       telegram_log table                                  │
                       (reactive query)                                    │
                               ▲                                           │
                               │                                  ┌────────▼────────┐
                       insert ─┴── httpAction <─────POST─────────│  callback_query │
                                  /telegram-webhook              │  (button press) │
                                                                  └─────────────────┘
[live activity feed shows OUT + IN rows in real time]
```

Three Convex pieces, one UI route with three templates, one log table.

## Components

### 1. Convex env (already set in dev deployment)

- `TELEGRAM_BOT_TOKEN` — bot identity
- `TELEGRAM_CHAT_ID` — destination group (negative integer for groups; POC uses one group for all three templates)
- `TELEGRAM_WEBHOOK_SECRET` — echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token` header so we can reject spoofed webhooks

### 2. Schema — `convex/schema.ts`

One new table:

```ts
telegram_log: defineTable({
  direction: v.union(v.literal("out"), v.literal("in")),
  template_kind: v.optional(v.string()),    // "approval" | "shift_summary" | "custom" | null (inbound)
  payload_json: v.string(),                 // full request/response body for debugging
  update_id: v.optional(v.number()),        // dedupe key for inbound (Telegram retries)
  callback_data: v.optional(v.string()),    // which button was pressed
  from_user: v.optional(v.string()),        // Telegram @username (or first_name) of presser
  message_id: v.optional(v.number()),       // outbound message_id, used for editMessageText follow-up
  created_at: v.number(),
})
  .index("by_update_id", ["update_id"])
  .index("by_created_at", ["created_at"])
```

No `pos_` prefix — sandbox table, not POS-domain data. If the POC graduates to real flows, this gets replaced by direct integration with `pos_approval_requests` and a separate `telegram_outbox` if needed.

### 3. Convex functions

**`convex/telegram/send.ts`** — `action sendTemplate({ kind, payload })`

Parametric template renderer:

```ts
sendTemplate({
  kind: "approval" | "shift_summary" | "custom",
  payload: {
    // approval:        { action_type, amount_idr, reason }
    // shift_summary:   { staff_name, sales_idr, txn_count, hours }
    // custom:          { text, include_buttons }
  }
})
```

Per-kind behaviour:

- **approval**: renders HTML message body with action / amount / reason, attaches `inline_keyboard` with `Approve ✅` / `Deny ❌` callback buttons (`callback_data: "approve:<nonce>"` / `"deny:<nonce>"`)
- **shift_summary**: renders HTML multi-line block (staff line, sales total, txn count, hours), NO buttons (one-way)
- **custom**: renders text as-is, attaches buttons only if `include_buttons === true`

Common flow:
1. Read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from env
2. POST to `https://api.telegram.org/bot<TOKEN>/sendMessage` with `parse_mode: "HTML"`
3. Insert `telegram_log` row with `direction: "out"`, `template_kind: kind`, the full payload + Telegram's response (capture the returned `message_id` for later edits)

**`convex/telegram/webhook.ts`** — `httpAction`

- Reads `X-Telegram-Bot-Api-Secret-Token` from request headers; rejects with 401 if it doesn't match `TELEGRAM_WEBHOOK_SECRET`
- Parses request body as JSON; expects a `callback_query` shape per [Telegram API](https://core.telegram.org/bots/api#callbackquery)
- Dedupes by `update_id` (Telegram retries on non-200; idempotency at this layer matters — checks `telegram_log.by_update_id`)
- Inserts `telegram_log` row with `direction: "in"`, populated callback fields
- Calls `answerCallbackQuery` to kill the spinner per the tutorial requirement
- Calls `editMessageText` on the original `message_id` to rewrite: `"✅ Approved by @<username>"` or `"❌ Denied by @<username>"` — strips the buttons by sending `reply_markup` of empty `inline_keyboard`
- Returns HTTP 200 with empty body

POC-clean button behaviour per the decision: **no PIN check, no audit_log emission, no real state mutation.** The webhook proves the round-trip transport, nothing more.

**`convex/http.ts`** — Convex HTTP router

Routes `POST /telegram-webhook` to the httpAction above.

### 4. UI — `src/routes/dev/telegram.tsx`

Layout (mobile-first to match the rest of the app):

```
┌──────────────────────────────────┐
│  Telegram POC                    │
├──────────────────────────────────┤
│  [ Approval ] [ Shift ] [ Custom]│  ← tabs
├──────────────────────────────────┤
│  <per-tab form fields>           │
│                                  │
│         [ Send to Telegram ]     │
├──────────────────────────────────┤
│  Activity                        │
│  ┌──────────────────────────┐   │
│  │ OUT · 14:42 · approval   │   │
│  │  Refund Rp 50,000        │   │
│  │  "stale cookie"          │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ IN  · 14:43 · @lucas     │   │
│  │  approve:a8f3c2          │   │
│  └──────────────────────────┘   │
└──────────────────────────────────┘
```

Tab/template fields:

| Tab            | Fields                                                          |
|----------------|-----------------------------------------------------------------|
| Approval       | action_type (select: refund/manual_pay/neg_stock) · amount (idr) · reason (textarea) |
| Shift summary  | staff_name (text) · sales_idr · txn_count · hours (number)      |
| Custom         | text (textarea) · include_buttons (checkbox)                    |

Activity feed:
- Sourced from `telegram_log` ordered by `created_at` desc, limited to most recent ~30 rows
- Each row: direction badge (`OUT` green / `IN` purple), timestamp (HH:mm:ss), template_kind, payload preview (~80 chars)
- Updates reactively the instant the webhook lands — that's the live behaviour we want to feel

No auth gating on the route — POC only, app runs on a registered device.

### 5. Router wiring

Add `/dev/telegram` to `src/router.tsx`.

## Acceptance criteria

The POC is successful when:

1. **Approval round-trip**: Sending an approval-template message causes a formatted card with two buttons to appear in the dev Telegram group within ~1s
2. **Button press**: Tapping either button in Telegram causes the original message to update (text becomes "Approved/Denied by …", buttons disappear) within ~1s
3. **Live UI**: The Activity feed in the POC UI shows OUT row immediately on send and IN row without manual refresh after button tap
4. **Shift summary**: Sending a shift-summary template message causes a multi-line formatted block to appear in Telegram with NO buttons; OUT row appears in feed, no IN row generated
5. **Custom message with buttons**: Sending a custom message with `include_buttons` on produces buttons; without it, produces plain text only
6. **Security**: Sending a forged POST to `/telegram-webhook` without the correct `X-Telegram-Bot-Api-Secret-Token` returns 401 and writes nothing
7. **Idempotency**: Sending the same Telegram update twice (same `update_id`) writes only one IN row
8. **HTML formatting**: Special characters in user-supplied fields (`<`, `>`, `&`) are properly escaped so they render literally rather than breaking the HTML parser

## Risks / open considerations

- **Convex action HTTP client:** Convex actions use the standard `fetch` API. Telegram's API is plain JSON over HTTPS — no SDK required.
- **HTML escaping:** Using `parse_mode: "HTML"` means we MUST escape `<`, `>`, `&` in user-supplied fields. Use a small helper. Telegram only allows a fixed tag set: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href>`. Other tags throw.
- **Group privacy mode:** Leave default ON. Callback queries are always delivered to the bot regardless.
- **Webhook backpressure:** If Telegram fires faster than Convex can process, it retries on non-200. Our dedupe by `update_id` handles that.
- **One bot, one chat:** Hardcoded for POC. Real flow will route based on the type of approval (manager group vs. founders group) via separate `TELEGRAM_CHAT_ID_MANAGERS` + `TELEGRAM_CHAT_ID_FOUNDERS` env vars.
- **Token rotation:** Bot token landed in the conversation log during setup. After POC verification, rotate via `@BotFather → /revoke`.
- **`editMessageText` failure mode:** If the original message was deleted in Telegram before the user pressed the button, `editMessageText` will fail with HTTP 400. POC: log the failure and move on. Production: this is a real edge case to design around.

## Broader migration plan (post-POC follow-up — not in scope to build now)

If the POC succeeds, a single follow-up ADR documents the WA→Telegram migration:

| Wireframe flow                  | Current ADR                                                                          | Replacement                                  |
|---------------------------------|--------------------------------------------------------------------------------------|----------------------------------------------|
| Manager approval requests       | [ADR-027](../../../docs/ADR/027-wa-approval-via-staff-own-wa.md)                     | Telegram bot + inline-keyboard + PIN landing |
| End-of-shift founders summary   | [ADR-033](../../../docs/ADR/033-founders-shift-summary-share.md)                     | Telegram bot one-way notification           |
| Token-authorizes-view, PIN-act  | [ADR-029](../../../docs/ADR/029-token-authorizes-view-pin-authorizes-act.md)         | Still applies — button opens PIN landing URL |
| Customer-facing receipts        | (unchanged — still on `wa.me`)                                                       | NOT migrated — separate ADR if/when changed  |

Architectural shape of the replacement:
- One bot, multiple chat_ids (`TELEGRAM_CHAT_ID_MANAGERS`, `TELEGRAM_CHAT_ID_FOUNDERS`)
- Manager flow: button → opens token-scoped landing URL → PIN entered → completion (preserves [ADR-029](../../../docs/ADR/029-token-authorizes-view-pin-authorizes-act.md))
- Founders flow: outbound only, no buttons, no callback
- Customer receipts: deliberately left on WhatsApp; revisit only if WA itself becomes a problem

## What this POC unlocks if it works

- Telegram round-trip is a viable transport ✓
- Inline buttons can replace the click-link UI ✓
- Webhook security via secret_token works ✓
- HTML message formatting is good enough for receipt-like content ✓
- The UX is faster than WA share-intent (no share sheet, no app switch on send) ✓
- The replacement ADR has empirical answers, not guesses ✓

If the POC fails or feels worse than WA, cost was ~half a day and we keep [ADR-027](../../../docs/ADR/027-wa-approval-via-staff-own-wa.md) + [ADR-033](../../../docs/ADR/033-founders-shift-summary-share.md) as-is.
