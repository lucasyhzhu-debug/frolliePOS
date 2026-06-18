# Frollie POS — Bootstrap Runbook

Operational reference for bootstrapping a fresh dev or staging deployment.
Covers wipe, seed, env vars, and webhook registration.

---

## 1. Prerequisites

- `npx convex dev` is running and targeting the dev deployment (`helpful-grasshopper-46`).
- You have set the required Convex env vars (see §4).

---

## 2. Wipe sequence (dev only)

`seed:reset` is blocked on the prod deployment slug (`savory-zebra-800`) by a hard prod-guard
in the action handler. Running it on dev or any non-prod deployment is safe.

**What it wipes:** all rows in `staff`, `staff_sessions`, `registered_devices`,
`pending_device_setups`, `pos_products`, `pos_inventory_skus`, `pos_product_components`,
`pos_stock_levels`, `audit_log`, `pos_idempotency`, `pos_auth_attempts`.

**What it seeds after wiping:**
- 4 staff (Bayu, Citra, Dewi, Eka — PIN `0000`)
- 1 manager (Lucas — PIN `9999`, code `S-0005`)
- 5 inventory SKUs with initial stock levels
- 7 products from the wireframe catalog

```bash
npx convex run seed:reset
```

> **Note:** Both `seed:reset` and `seed:bootstrap` are declared as `internalAction`.
> The Convex CLI (`npx convex run`) can invoke internal functions from the terminal
> against the dev deployment. If a future Convex version restricts this, use the
> Convex dashboard → Functions → `seed:reset` → Run.

---

## 3. Bootstrap a fresh deployment

Use `seed:bootstrap` on any deployment with an **empty staff table** — including prod.
It creates Lucas (code `S-0001`, role `manager`, PIN `1111`) and is idempotent:
if any staff row already exists, it throws `already_bootstrapped` and exits cleanly.

```bash
npx convex run seed:bootstrap
```

Expected output:
```json
{ "staffId": "<convex-id>", "staffCode": "S-0001" }
```

---

## 4. Verify

After `seed:bootstrap` (or `seed:reset` followed by verifying the manager row exists):

1. Open the POS at `http://localhost:5173` (or the Vercel preview URL).
2. Log in with PIN `1111`.
3. Confirm the session establishes and the sale screen loads.

To inspect directly:
```bash
# List staff rows via dashboard or a query
npx convex run seed:internal:_countStaff_internal
```
Expect `1` after bootstrap, `5` after reset.

---

## 5. Environment variables

### 5a. Convex-side env vars

Set via `npx convex env set NAME -- value` (or the Convex dashboard → Settings → Environment Variables).
These are available to Convex actions/mutations at runtime via `process.env`.

| Variable | Purpose | Required |
|---|---|---|
| `XENDIT_SECRET_KEY` | Xendit API key for creating/cancelling invoices | Yes (payments) |
| `XENDIT_CALLBACK_TOKEN` | Validates inbound Xendit webhook `x-callback-token` header | Yes (payments) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot HTTP token for outbound notifications | Yes (Telegram POC) |
| `TELEGRAM_CHAT_ID` | Target Telegram chat/group ID for bot messages | Yes (Telegram POC) |
| `TELEGRAM_WEBHOOK_SECRET` | Validates inbound Telegram webhook `X-Telegram-Bot-Api-Secret-Token` | Yes (Telegram webhook) |
| `POS_BASE_URL` | Full origin of the POS frontend (e.g. `https://frollie-pos.vercel.app`) — used to build approval deep-links | Yes (approval links) |
| `OPS_INGEST_TOKEN` | Validates the `x-ops-token` header on `POST /ops/error` (the launch-day error pipe) | Yes (ops pipe) |

> **Set both ops tokens on dev AND prod _before_ the FE deploy.** `OPS_INGEST_TOKEN` (here) must equal `VITE_OPS_INGEST_TOKEN` (§5b). The frontend bakes `VITE_OPS_INGEST_TOKEN` into the bundle and sends it as `x-ops-token`; if the Convex-side `OPS_INGEST_TOKEN` is unset or mismatched, `/ops/error` silently returns `204` and **drops every error report** — no crash/payment/backend alert ever reaches the Telegram `ops` channel.

**Quick set (dev):**
```bash
npx convex env set XENDIT_SECRET_KEY -- xnd_development_YOUR_KEY
npx convex env set XENDIT_CALLBACK_TOKEN -- your_callback_token_here
npx convex env set TELEGRAM_BOT_TOKEN -- 1234567890:YOUR_BOT_TOKEN
npx convex env set TELEGRAM_CHAT_ID -- -1001234567890
npx convex env set TELEGRAM_WEBHOOK_SECRET -- your_webhook_secret
npx convex env set POS_BASE_URL -- http://localhost:5173
npx convex env set OPS_INGEST_TOKEN -- your_ops_ingest_token_here
```

For **prod** (`savory-zebra-800`), add `--prod` flag:
```bash
npx convex env set --prod XENDIT_SECRET_KEY -- xnd_production_YOUR_KEY
# ... etc
```

### 5b. Frontend env vars (Vercel / `.env.local`)

These are `VITE_*` variables baked into the frontend bundle at build time.
Set in `.env.local` for local dev; inject as Vercel environment variables for preview/prod.

| Variable | Value (dev) | Value (prod) |
|---|---|---|
| `VITE_CONVEX_URL` | `https://helpful-grasshopper-46.convex.cloud` | `https://savory-zebra-800.convex.cloud` |
| `VITE_OPS_INGEST_TOKEN` | (match `OPS_INGEST_TOKEN` on dev — §5a) | (match `OPS_INGEST_TOKEN` on prod — §5a) |

Baked into the bundle and sent as the `x-ops-token` header on `POST /ops/error` — a low-assurance spam guard, not a secret. **Must equal the Convex-side `OPS_INGEST_TOKEN` (§5a) for the matching deployment, set before the FE deploy**, else `/ops/error` silently `204`s and no error reports land.

`.env.local` (dev):
```
VITE_CONVEX_URL=https://helpful-grasshopper-46.convex.cloud
VITE_OPS_INGEST_TOKEN=your_ops_ingest_token_here
```

---

## 6. Webhook registration

### Xendit invoice webhook

Point Xendit's invoice webhook callback at the Convex HTTP action endpoint.

| Deployment | Webhook URL |
|---|---|
| Dev | `https://helpful-grasshopper-46.convex.site/payments/webhook` |
| Prod | `https://savory-zebra-800.convex.site/payments/webhook` |

In the Xendit dashboard (or via the Xendit API):
- **URL:** as above
- **Header:** `x-callback-token: <value of XENDIT_CALLBACK_TOKEN>`
- The webhook handler returns `200` on success and on duplicate delivery (Xendit retries on non-2xx).

### Telegram webhook (POC)

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://helpful-grasshopper-46.convex.site/telegram-webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

---

## 7. Prod cutover

**Deferred to v1.0.**

Prod deployment: `savory-zebra-800`
- Convex client/WS: `https://savory-zebra-800.convex.cloud`
- HTTP actions: `https://savory-zebra-800.convex.site`

When deploying to prod:
1. Run `npx convex deploy` to push schema + functions to `savory-zebra-800`.
2. Run `npx convex run --prod seed:bootstrap` to create the Lucas manager account.
3. Inject `VITE_CONVEX_URL=https://savory-zebra-800.convex.cloud` into the Vercel production build environment.
4. Set all Convex env vars against prod (§5a with `--prod` flag).
5. Register Xendit + Telegram webhooks against the `.convex.site` prod URLs.

The `seed:reset` prod-guard will block accidental data wipes on `savory-zebra-800`.

---

## 8. Booth operations (prod) — v1.0 launch

Prod deployment: `savory-zebra-800` · App: https://frollie-pos.vercel.app · Logs: Convex dashboard → prod → Logs.

### 8.1 Daily flow
- Buka PWA dari home screen (bukan browser tab). Cek titik koneksi di header: hijau = live.
- Pagi / setiap terima kiriman dari dapur: hitung stok fisik → **Stock check → Hitung ulang stok** (recount, ADR-041). Recount adalah satu-satunya jalur restock v1 — TIDAK ada layar "stock in" (kembali di v0.5.2b). Manajer otomatis dapat notifikasi recount via Telegram.
- Tutup shift: **Lock + handoff**.

### 8.2 Pembayaran tidak terkonfirmasi (QR sudah discan, layar tidak berubah)
1. Tunggu ±30 detik — konfirmasi datang dari webhook Xendit, bukan dari device.
2. Cek titik koneksi. Kalau offline: pembayaran yang sudah discan TETAP diproses; layar update begitu koneksi kembali.
3. Masih stuck dan pelanggan menunggu: panggil manajer → **manual override** (PIN di booth, atau link `/approve` di grup Telegram Manajer untuk manajer di luar booth).
4. JANGAN minta pelanggan scan ulang sebelum manajer memeriksa — risiko bayar dobel.

### 8.3 Device mati / hilang
1. Manajer kirim `/activatepos` di grup Telegram **Frollie · Managers** → dapat kode 6 digit + link aktivasi (berlaku 1 jam).
2. Buka link di HP pengganti → masukkan kode → login PIN → lanjut jualan.
3. Kalau tidak ada HP pengganti: catat penjualan di buku (fallback minggu pertama), lalu recount stok setelah device kembali. Pembayaran TIDAK bisa diterima tanpa device (QRIS per-transaksi).

### 8.4 Telegram down
- Approval jatuh ke jalur PIN manajer di booth (manual override tetap jalan).
- Ringkasan founders & alert stok skip otomatis (ter-audit, tidak ada retry storm). Tidak ada tindakan.

### 8.5 Xendit / pembayaran down total
- Tidak ada pembayaran digital = tidak ada penjualan via POS (by design, ADR-006: no cash).
- Eskalasi ke Lucas. Opsi darurat ditentukan manajer (mis. catat IOU di buku).

### 8.6 Eskalasi
- Kontak: Lucas (S-0001).
- Logs: Convex dashboard prod → Logs (cari `qr.payment` untuk webhook pembayaran).
- Bot/Telegram ops: lihat `docs/RUNBOOK-telegram.md`.

### 8.7 Prod data setup (re-seeding order — manager only)
1. Katalog (SKU + produk): `npx convex run --prod seed/internal:_seedLaunchCatalog_internal` — one-shot, mengisi SKU `dubai` + `water` dan 4 produk (Dubai Chewy Cookie Single/Triple/Eight + Mineral Water, harga 45rb/125rb/320rb/5rb). Menolak jalan kalau katalog sudah ada (`catalog_already_populated`).
2. Perubahan katalog selanjutnya: `/mgr/products` (PIN — `createInventorySku` / `createProduct`).
3. Stok awal: `/stock/recount` (hitung fisik; recount movement men-set on_hand).
4. Staf: `/mgr/staff` (PIN — manajer SET PIN awal saat create; staf WAJIB ganti PIN via "Change PIN" saat login pertama).
5. Voucher (opsional): `/mgr/vouchers` (PIN).

---

## 9. Live-run ops & hot-fix (v1.0.1)

Launch-day observability: a client+backend error pipe (`POST /ops/error` → deduped/storm-capped `pos_error_reports` → `system_error` alert to the Telegram **ops** role) and a silent live sales ticker to the **Managers** group on every paid sale. Set both ops tokens (§5a/§5b) before the FE deploy.

### 9.1 Pre-run smoke (tonight + tomorrow AM)
1. Bind the Telegram **ops** role → a new "Frollie · Ops" group (self-registration; see [`RUNBOOK-telegram.md`](./RUNBOOK-telegram.md)).
2. Login on the booth device; run ONE real QRIS sale end-to-end → confirm the ticker lands in the **Managers** group.
3. Recount one SKU.
4. Trigger a deliberate test error (e.g. a throwaway route that throws) → confirm it lands in the **Ops** group.

### 9.2 What to watch
- **Ops** Telegram channel (push — crashes / payment / backend failures).
- **Managers** channel (live sales ticker; silent notifications).
- Convex prod Logs → filter `qr.payment` (payment webhook) + function errors.

### 9.3 Hot-fix protocol (sanctioned fast lane — an EXPLICIT deviation, not a skipped step)
1. Branch off `main`.
2. `npm run typecheck` + the single most-relevant test.
3. Deploy: `vercel` (FE) / `npx convex deploy` (BE).
4. Verify on the booth device.
5. Open a follow-up issue to backfill the normal triple-review for the hot-fix.

### 9.4 Rollback
- FE: Vercel instant-rollback to the prior deployment.
- BE: `npx convex deploy` of the prior commit.

### 9.5 Turn the ticker off (launch kill-switch)
- **Launch path (v1.0.1):** edit the `pos_settings` singleton in the Convex dashboard — set `txn_ticker_enabled` to `false` (read-time default is `true` when absent). Takes effect on the next paid sale; no deploy needed.
- A manager-facing in-app toggle (`/mgr/...` settings, manager-session write) is deferred to **v1.0.2** — the v1.0.1 backend only *reads* this field.
