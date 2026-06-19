// src/lib/i18n/dictionaries/en.ts
// en is the SOURCE OF TRUTH for keys. `as const` makes keyof typeof en the literal union.
// Plural keys come in _one/_other pairs; callers reference the _other variant + pass {count}.
export const en = {
  // common (shared verbs — dedup target during extraction)
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.confirm": "Confirm",
  "common.loading": "Loading…",
  // home
  "home.newSale": "New sale",
  "home.startCart": "start a cart",
  "home.changePin": "Change PIN",
  "home.changePinHint": "change your PIN",
  "home.group.sell": "SELL",
  "home.group.stock": "STOCK",
  "home.group.you": "YOU",
  "home.group.mgr": "MANAGER",
  "home.catalogSummary_one": "{count} product · {skus} SKUs",
  "home.catalogSummary_other": "{count} products · {skus} SKUs",
  "home.endShift": "End shift",
  "home.lockHandoff": "Lock and hand off",
  "home.recountNudge": "Time to recount stock — tap to start",
  "home.awaitingPayment_one": "{count} payment unfinished — tap to continue",
  "home.awaitingPayment_other": "{count} payments unfinished — tap to continue",
  // locale toggle
  "locale.english": "English",
  "locale.bahasa": "Bahasa",
  "locale.toggleLabel": "Language: {current}. Tap to switch to {next}.",
  "locale.saveFailed": "Couldn't save language. Try again.",
} as const;
