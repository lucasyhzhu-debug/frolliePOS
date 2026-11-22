# Runbook — decommissioning Frollie POS

Status: **in progress.** Started 2026-11-22 with v1.4.12 (see [`CHANGELOG.md`](./CHANGELOG.md)).

This is the ordered procedure for switching off the POS backend, database and frontend. The order
matters: steps 1–4 protect money, a dependent system, and the data; steps 5–9 switch things off.
Steps 1–8 are reversible. **Step 9 is not.**

## What is running

| Component | Where | Notes |
|---|---|---|
| Backend + database (prod) | Convex `savory-zebra-800` | Crons, Xendit + Telegram webhooks, public receipt links (`/r/<token>`), `api/v1` for Frollie Pro |
| Backend + database (dev) | Convex `helpful-grasshopper-46` | Same Convex project as prod |
| Frontend | Vercel | A **production** build also runs `convex deploy` to prod (`scripts/build.mjs`) |
| Payments | Xendit — **account shared with Recipe Master** | Do not rotate its keys or callback token as part of this shutdown |
| Telegram bot | Webhook → `<prod>.convex.site/telegram-webhook` | |
| CI | GitHub Actions `e2e` | Manual-only since v1.4.12 |

## Blocking dependency — Recipe Master's QRIS confirmations

The POS webhook (`/payments/webhook`) is the QRIS callback receiver for the Xendit account shared
with Recipe Master (Frollie Pro). Since v1.4.10 it forwards every QRIS paid-callback that is not a
POS payment to Recipe Master (`convex/payments/forwarder.ts`, default target
`https://decisive-wombat-7.convex.site/api/xendit/qr-payment`).

**If the POS backend is paused or deleted while Xendit still points at it, Recipe Master stops
receiving QRIS payment confirmations.** Step 2 must be complete and verified before step 6.

Open question to settle on the Recipe Master side before step 2: the forwarder adds an
`x-frollie-forward-secret` header. If Recipe Master's endpoint requires that header, it will reject
callbacks arriving directly from Xendit and needs a change (or a different endpoint) first.

## Done in the repo (v1.4.12)

Effective on the production deploy that follows the merge to `main`.

- Outbound templated Telegram messages are off unless `TELEGRAM_SENDS_ENABLED=true` is set on the
  deployment.
- 7 of 8 crons removed. `settlement-sync` is kept until step 6 so the final days' payouts are
  recorded.
- `e2e` workflow no longer runs on push or pull request.

## Procedure

### 1. Settle open money items

- No transactions left in `awaiting_payment`.
- Every refund marked settled (`/refund`, ADR-038), or its transfer otherwise accounted for.
- Xendit payouts for the final trading days reconciled (`/settlements`). `settlement-sync` keeps
  recording these nightly until step 6; allow for Xendit's settlement delay after the last sale.
- Expire any open BCA virtual accounts in the Xendit dashboard. A virtual account stays payable at
  Xendit after the POS is gone, and nothing would record the payment.

### 2. Repoint Xendit callbacks

- QR Codes (`qr.payment`) callback URL → Recipe Master, once the open question above is resolved.
- Virtual-account callback URL → remove the POS URL (Recipe Master's, if it uses FVA; otherwise
  clear it).
- Verify with a live Recipe Master QRIS payment that confirmation arrives without the POS.
- Then set `FROLLIE_FORWARD_ENABLED=false` on POS prod so the POS cannot double-deliver.

### 3. Stop the Frollie Pro sales sync

Frollie Pro pulls `GET /api/v1/transactions` and `GET /api/v1/refunds` from the POS
([`PUBLIC_API.md`](./PUBLIC_API.md)). Let it complete a final sync after step 1, then disable it on
the Pro side. Revoke the POS `api_tokens` afterwards.

### 4. Export the data

```bash
npx convex export --prod --include-file-storage --path ./frolliepos-prod-export.zip
```

Requires a prod deploy key (`CONVEX_DEPLOY_KEY`). The export holds transactions, lines, refunds,
settlements, stock movements and the audit log. Store it in at least two places and open it once to
confirm it is readable. Confirm the required retention period for sales and tax records with the
accountant before step 9.

### 5. Disconnect and stop the frontend (Vercel)

- Disconnect the Vercel project from the GitHub repository **first**. While connected, any merge to
  `main` triggers a production build, which redeploys the Convex backend.
- Then pause or delete the Vercel project, and remove its domains.

### 6. Pause the Convex prod deployment

Convex dashboard → `savory-zebra-800` → Settings → Pause Deployment. This stops all functions,
crons, scheduled jobs and HTTP routes and keeps the data. Reversible.

From this point: the booth app cannot log in or sell, receipt links (`/r/<token>`) stop resolving,
and the Xendit and Telegram webhooks return errors (hence steps 2 and 7).

### 7. Remove the Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```

Until this is done the bot still answers typed commands (`/activatepos`, `/register`,
`/start <token>`) — those replies are not covered by the v1.4.12 switch. If the bot is used only by
the POS, revoke its token in BotFather afterwards.

### 8. Archive the repository

GitHub → Settings → Archive this repository. Remove the Actions secrets (`CONVEX_DEPLOY_KEY_DEV`,
`CONVEX_DEV_URL`, `XENDIT_CALLBACK_TOKEN_DEV`) and delete the Convex deploy keys.

### 9. Delete the Convex project — IRREVERSIBLE

Only after the export in step 4 has been verified and a holding period has passed with the
deployment paused. Deleting the project removes **both** the dev and prod deployments and all data.

## Rolling back before step 9

| Undo | How |
|---|---|
| Telegram sends | `npx convex env set TELEGRAM_SENDS_ENABLED true --prod` (no deploy needed) |
| Crons | Restore the blocks in `convex/crons.ts` from git history (v1.4.11) and deploy |
| e2e CI triggers | Restore the `on:` block in `.github/workflows/e2e.yml` from git history (v1.4.11) |
| Paused deployment | Convex dashboard → Settings → Resume |
| Xendit callbacks | Set the callback URLs back to `<prod>.convex.site/payments/webhook` and `FROLLIE_FORWARD_ENABLED=true` |
