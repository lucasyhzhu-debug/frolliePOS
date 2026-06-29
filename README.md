# Frollie POS

The point-of-sale that runs [Frollie](https://instagram.com/frollie.id), our snacks business in Jakarta. It lives entirely on one Android phone. No terminal, no extra hardware, no monthly SaaS.

We built it for our own counter and have run it at our Block M outlet every day since launch. Now it's open source, so any small shop can fork it and make it theirs. Built with [Claude Code](https://claude.com/claude-code).

A web app (installable PWA), so the whole thing is a URL on a phone. Digital payments only: QRIS for tap-to-pay, manual bank transfer as the backup. Money is whole-rupiah integers, never floats.

---

## What it does

Everything below is a button on the home screen. A staffer signs in with a 4-digit PIN and gets the day-to-day surfaces; a manager PIN unlocks the rest.

**Selling**
- **New sale** — build a cart from the catalog, charge by QRIS or manual transfer. Works offline; the charge step waits for a connection.
- **Saved carts** — park a cart mid-sale and resume it later (drafts queue offline).
- **History** — today's sales, reprint a receipt, or start a refund.
- **Refund** — refund a paid sale. A refund is its own record, never an edit to the original sale.

**Stock**
- **Stock check** — live inventory and a guided recount. Stock decrements at the inventory-SKU level, and a sale is never hard-blocked at zero (it's flagged for review instead).

**You**
- **Change PIN** — staff self-service.
- **Language** — switch English / Bahasa Indonesia per person, instantly.
- **Lock** — hand the phone to the next person; the session ends cleanly.
- **Receipt printer** — connect a Bluetooth thermal printer, test, and print.
- **Install / Update** — add the app to the home screen, and a banner pushes the newest build so a kiosk never sits on a stale version.

**Manager** (manager PIN)
- **Manager home** — the back office: dashboard (today's totals, payment mix, top SKUs, per-staff), products (price, photo, archive), staff (roles, deactivate, reset PIN), vouchers, spoilage, receipt branding, stock-drift triage, device setup, and an append-only audit log.
- **Settlements** — track Xendit payouts to your bank, with manual entry on payout day.
- **Telegram chats** — register the bot and route each alert to the right group.

**End of shift**
- **Close booth** and **Handover** — the two ways to end a shift. Both send the daily summary to the owners over Telegram.

**Owners** (a separate plane at `/cockpit`)
- Sign in with a one-time code sent to your Telegram. Get a daily sales rollup, approve manager actions remotely (refunds, voids, PIN resets, manual payments), and run multiple outlets from one place.

---

## How it works

- **Approvals and alerts run on Telegram.** Off-booth approvals arrive as a single-use link; owners get a daily sales summary; managers get a live sales ticker, low-stock alerts, and recount notices. Owner login is a Telegram one-time code.
- **Payments are webhook-confirmed.** QRIS renders in-app via Xendit's QR Codes API; confirmation comes from the payment webhook, with a manager-PIN override as the manual fallback. No polling.
- **Auth is PIN-first.** 4-digit PINs hashed with argon2id, device registration before first login, lockout on repeated misses. Manager-PIN gates the actions that move money or change identity; owners authorise the rest by one-time code.
- **Offline is partial and honest.** Catalog, cart, drafts, and the stock-in queue work offline. Payments, auth, and refunds tell you plainly that they need a connection rather than failing silently.
- **Multi-outlet by design.** Every operational query is scoped to the outlet bound to the device; owners see across all of them.

## Stack

React 19 + TypeScript + Vite, [Convex](https://convex.dev) for the backend and real-time sync, Tailwind 4 + shadcn/ui, Framer Motion, React Router v7. Zustand for cart state, IndexedDB for the offline queue. [Xendit](https://xendit.co) for payments, the Telegram Bot API for comms. Hosted on Vercel as an installable PWA.

The depth lives in [`CLAUDE.md`](./CLAUDE.md) and [`docs/`](./docs) — architecture decisions in [`docs/ADR/`](./docs/ADR), the schema in [`docs/SCHEMA.md`](./docs/SCHEMA.md), the function inventory in [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md), and Telegram ops in [`docs/RUNBOOK-telegram.md`](./docs/RUNBOOK-telegram.md).

## Run it locally

```bash
git clone https://github.com/lucasyhzhu-debug/frolliePOS.git
cd frolliePOS
npm install

cp .env.example .env.local        # set VITE_CONVEX_URL

# two terminals
npm run dev                        # vite on http://localhost:5173
npx convex dev                     # backend (creates your own Convex dev project)

npx convex run seed:reset          # dev staff + a pre-registered booth device
```

In dev, `seed:reset` pre-registers a fixed device so you skip activation. The seeded manager's PIN comes from `BOOTSTRAP_MANAGER_PIN` (see below).

```bash
npm run build        # tsc -b && vite build
npm run typecheck    # tsc --noEmit
npm run lint
npm run deploy       # frontend → Vercel
npx convex deploy    # backend → your Convex prod
```

## Configuration

Client (Vite, shipped in the bundle — never secret):

| Var | Purpose |
|---|---|
| `VITE_CONVEX_URL` | Convex deployment URL |
| `VITE_APP_URL` | base URL for shareable receipt links |
| `VITE_OPS_INGEST_TOKEN` | client error-reporting token |

Server (set with `npx convex env set …`, on both dev and prod):

| Var | Purpose |
|---|---|
| `BOOTSTRAP_MANAGER_PIN` | 4-digit PIN for the seeded manager; forced to rotate on first login |
| `XENDIT_SECRET_KEY` | Xendit API key (QRIS) |
| `XENDIT_CALLBACK_TOKEN` | verifies the payment webhook signature |
| `TELEGRAM_BOT_TOKEN` | the bot that sends approvals, summaries, and OTPs |
| `TELEGRAM_WEBHOOK_SECRET` | verifies inbound Telegram updates |
| `TELEGRAM_BOT_USERNAME` | builds owner bind deep-links |
| `MANUAL_BCA_ACCOUNT_NUMBER` · `MANUAL_BCA_ACCOUNT_NAME` | the bank account shown for manual transfers |
| `POS_BASE_URL` | base URL for approval and receipt links |
| `OPS_INGEST_TOKEN` | server side of error reporting |

## Deploy

Frollie runs on its **own** Convex project (dev + prod). The Vercel production build ships backend and frontend together: on `VERCEL_ENV === "production"`, `npm run build` runs `npx convex deploy` first, then builds the frontend against the prod URL, so the app can never go live against a stale backend. A production deploy needs `CONVEX_DEPLOY_KEY` in Vercel's Production env.

## What it is, and isn't

Built for a single booth, two or three staff, digital payments only. It is not a cash drawer, a kitchen/recipe inventory system, a customer-facing screen, or a Play Store app. It sells finished goods, tracks them at the SKU level, and stays out of everything else. The reasoning behind each of those lines is written down in [`docs/ADR/`](./docs/ADR).

## License

[MIT](./LICENSE). Fork it, ship it, make it yours.
