// src/lib/i18n/dictionaries/id.ts
import { en } from "./en";

// Typed against en's keys: a missing OR mistyped key is a tsc error (excess-property + missing both caught).
export const id: Record<keyof typeof en, string> = {
  "common.cancel": "Batal",
  "common.save": "Simpan",
  "common.confirm": "Konfirmasi",
  "common.loading": "Memuat…",
  "home.newSale": "Penjualan baru",
  "home.startCart": "mulai keranjang",
  "home.changePin": "Ubah PIN",
  "home.changePinHint": "ubah PIN Anda",
  "home.group.sell": "JUAL",
  "home.group.stock": "STOK",
  "home.group.you": "ANDA",
  "home.group.mgr": "MANAJER",
  "home.catalogSummary_one": "{count} produk · {skus} SKU",
  "home.catalogSummary_other": "{count} produk · {skus} SKU",
  "home.recountNudge": "Saatnya menghitung ulang stok — ketuk untuk mulai",
  "home.awaitingPayment_one": "{count} pembayaran belum selesai — ketuk untuk lanjutkan",
  "home.awaitingPayment_other": "{count} pembayaran belum selesai — ketuk untuk lanjutkan",
  "locale.english": "English",
  "locale.bahasa": "Bahasa",
  "locale.toggleLabel": "Bahasa: {current}. Ketuk untuk ganti ke {next}.",
  "locale.saveFailed": "Gagal menyimpan bahasa. Coba lagi.",
};
