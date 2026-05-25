# Frollie POS

Internal point-of-sale system for the Frollie booth. Mobile web app (PWA) running on Android. Digital payments via Xendit (QRIS + BCA Virtual Account). Same Convex project as [product_master](https://github.com/lucasyhzhu-debug/product_master).

> Current state: **v0.2 baseline scaffolding** committed. Backend, screens, and PWA polish land per the phased roadmap (see `docs/WORKFLOW.md`).

## Stack

- Convex 1.31.7 (shared deployment with product_master)
- React 19 + TypeScript + Vite 6
- Tailwind CSS 4 + shadcn/ui (new-york, stone, tuned to Frollie teal)
- Framer Motion · React Router v7
- Xendit Invoice API (QRIS + BCA VA)
- Vercel (frontend hosting)
- PWA via `vite-plugin-pwa` (installable on Android)
- Sonner toasts · Zustand for local cart state · IDB for offline queue

Design tokens mirror Frollie Pro's design system (Inter, Frollie teal palette, role/channel/station colors). Source: `frollie-pos design files/lucas-frollie-design-system`, embedded in `src/index.css`.

## Quick start

```bash
# clone
git clone git@github.com:lucasyhzhu-debug/frolliePOS.git
cd frolliePOS

# install
npm install

# env (copy from .env.example, fill in values)
cp .env.example .env.local
# Required client-side: VITE_CONVEX_URL
# Required server-side (set via `npx convex env set`):
#   XENDIT_SECRET_KEY, XENDIT_CALLBACK_TOKEN,
#   RECEIPT_SIGNING_SECRET, APPROVAL_TOKEN_SECRET

# dev (two terminals)
npm run dev
npx convex dev

# open
http://localhost:5173
```

Seed data (once `convex/seed.ts` lands in Wave 3): `npx convex run seed:reset` writes test staff (PIN `0000`) and a manager (PIN `9999`). Set the `dev_staff` PIN in `convex/seed.ts` if you want a different value.

## Commands

```bash
npm run dev              # vite dev server
npx convex dev           # convex dev (connects to dev deployment)
npm run build            # production build (tsc -b && vite build)
npm run preview          # preview production build locally
npm run deploy           # vercel deploy
npx convex deploy        # convex prod deploy (shared deployment — coordinate)
npm run typecheck        # tsc --noEmit
npm run lint
```

## Project structure

```
frolliePOS/
├── CLAUDE.md                       # AI agent context — read first
├── README.md
├── package.json · vite.config.ts · tsconfig.json
├── components.json                 # shadcn/ui config
├── convex.json
├── index.html
├── .env.example · .gitignore
│
├── convex/                         # backend (filled in Wave 3)
│   ├── schema.ts                   # POS table definitions
│   ├── auth.ts                     # PIN auth (argon2id), sessions, lockout
│   ├── staff.ts                    # staff + device CRUD
│   ├── transactions.ts             # cart, draft, void
│   ├── payments.ts                 # Xendit invoice lifecycle
│   ├── refunds.ts                  # refund flow (with WA approval entry)
│   ├── stock.ts                    # movements, levels, reconciliation
│   ├── products.ts                 # products + inventory SKUs + components
│   ├── vouchers.ts · discounts.ts
│   ├── approvals.ts                # WA approval requests + tokens
│   ├── audit.ts                    # logAudit helper + audit query
│   ├── dashboard.ts                # manager dashboard queries
│   ├── settlements.ts              # Xendit settlement sync
│   ├── settings.ts                 # pos_settings singleton
│   ├── idempotency.ts              # mutation harness + dedupe helpers
│   ├── seed.ts                     # dev seeding
│   └── xendit/
│       ├── invoice.ts
│       ├── webhook.ts              # HTTP action for Xendit callbacks
│       ├── polling.ts
│       └── refund.ts
│
├── src/
│   ├── main.tsx · router.tsx · index.css
│   ├── routes/                     # one file per route (see router.tsx)
│   │   ├── login.tsx · home.tsx · lock.tsx · history.tsx · settlements.tsx
│   │   ├── refund.tsx · wait.tsx
│   │   ├── sale/                   # index, drafts, voucher, charge, charge-success
│   │   ├── stock/                  # index (check), in
│   │   ├── mgr/                    # home, dashboard, products, receipt
│   │   ├── approve/                # index (WA landing), pin (PUBLIC routes)
│   │   └── receipt.tsx             # PUBLIC /r/:receiptNumber
│   ├── components/
│   │   ├── ui/                     # shadcn primitives — button, badge, card,
│   │   │                           #   input, label, separator, dialog,
│   │   │                           #   dropdown-menu, popover, select, switch,
│   │   │                           #   tabs, tooltip, progress, scroll-area,
│   │   │                           #   sonner (toast)
│   │   ├── layout/                 # RootLayout, Stub (PhoneFrame, ConnDot land per phase)
│   │   ├── pos/                    # NumericKeypad (PIN + qty entry, keyboard-aware)
│   │   └── (screen-specific)/      # ProductGrid, CartPanel, etc. (land per phase)
│   ├── hooks/                      # useSession, useCart, useOfflineQueue, useIdempotency (per phase)
│   └── lib/
│       └── utils.ts                # cn() — clsx + tailwind-merge. Other utils per phase
│
├── public/                         # static assets, icons (Wave 8)
│
├── docs/
│   ├── SCHEMA.md                   # POS tables + Frollie Pro relationship
│   ├── ADR/                        # 000-strategic-foundations.md + 33 numbered ADRs
│   │   └── README.md               # index
│   ├── DECISIONS.md                # legacy product/flow decisions reference
│   ├── CHANGELOG.md
│   ├── WORKFLOW.md                 # extends Frollie Pro's
│   └── API_REFERENCE.md            # Convex function inventory
│
├── archive/                        # local-only (.gitignore'd) — original delivery bundle
└── frollie-pos design files/       # local-only (.gitignore'd) — wireframe handoff bundle
                                    # (source of truth for screens + 33-ADR registry)
```

## Environment variables

```
# Client (Vite, public — included in build)
VITE_CONVEX_URL=
VITE_APP_URL=                    # used for receipt URLs sent via WhatsApp

# Server (set via `npx convex env set`, NEVER in client bundle)
XENDIT_SECRET_KEY=
XENDIT_CALLBACK_TOKEN=           # webhook signature verification
RECEIPT_SIGNING_SECRET=          # HMAC for receipt URL tokens
APPROVAL_TOKEN_SECRET=           # HMAC for WA approval tokens
```

## Deployment

**Frontend:** `vercel --prod` or push to `main` if GitHub integration is wired.

**Backend:** `npx convex deploy` — deploys to the **shared product_master Convex deployment**. Coordinate with the Frollie Pro maintainer before running this. The shared schema means a broken POS deploy can affect product_master queries.

See `docs/WORKFLOW.md` for the deploy-coordination checklist.

## Documentation

- [CLAUDE.md](./CLAUDE.md) — agent context, business rules, conventions
- [docs/SCHEMA.md](./docs/SCHEMA.md) — POS tables and Frollie Pro relationship
- [docs/ADR/](./docs/ADR/) — architecture decisions (33 implementation ADRs + consolidated strategic foundations)
- [docs/DECISIONS.md](./docs/DECISIONS.md) — legacy product/flow decisions reference
- [docs/CHANGELOG.md](./docs/CHANGELOG.md) — version history
- [docs/WORKFLOW.md](./docs/WORKFLOW.md) — dev workflow (extends Frollie Pro's)
- [docs/API_REFERENCE.md](./docs/API_REFERENCE.md) — Convex function reference

## Wireframes & handoff

The visual + IA source of truth lives in `frollie-pos design files/project/Frollie POS Wireframes.html` (not in the repo — provided as a handoff bundle from Claude Design). When implementing a screen, open the corresponding artboard's source under `wireframes/*.jsx` for layout intent. The hand-drawn aesthetic in the wireframes is a wireframe convention; implementation uses production-polish shadcn/Tailwind via the tokens in `src/index.css`.
