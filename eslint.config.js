// ESLint flat config — Frollie POS (v0.2.1+).
//
// Wires the custom `no-cross-module-db-access` rule from
// `tools/eslint-rules/` so it runs on every `npm run lint`. This MUST land
// before the flat `convex/` layout is split into modules (ADR-034); without
// it, cross-module reads introduced mid-migration would be invisible.
//
// Today the flat layout has only root-level files like `convex/staff.ts`,
// which the rule treats as exempt orchestration. The first time a file lands
// at `convex/<module>/...` and reaches into another module's table via
// `ctx.db.*`, lint will fail.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

import noCrossModuleDbAccess from "./tools/eslint-rules/no-cross-module-db-access.js";
import idempotencyRequired from "./tools/eslint-rules/idempotency-required.js";

// Single source of truth for table ownership. When a new module + table pair
// lands, add the mapping here. Tables not present here are unpoliced.
const OWNERSHIP = {
  // auth module
  staff: "auth",
  staff_sessions: "auth",
  pos_auth_attempts: "auth",
  registered_devices: "auth",
  pending_device_setups: "auth",
  // catalog module
  pos_inventory_skus: "catalog",
  pos_products: "catalog",
  pos_product_components: "catalog",
  // inventory module — pos_stock_levels moved from catalog to inventory in v0.3 (ADR-034)
  pos_stock_levels: "inventory",
  pos_stock_movements: "inventory",
  // transactions module
  pos_transactions: "transactions",
  pos_transaction_lines: "transactions",
  pos_receipt_counters: "transactions",
  // payments module
  pos_xendit_invoices: "payments",
  // vouchers module
  pos_vouchers: "vouchers",
  pos_voucher_redemptions: "vouchers",
  // approvals module
  pos_approval_requests: "approvals",
  // idempotency module
  pos_idempotency: "idempotency",
  // audit module
  audit_log: "audit",
  // telegram module
  telegram_log: "telegram",
};

// Modules exempt from the rule. These tend to be infrastructure-y crosscuts
// (audit, idempotency) or single-file root utilities (seed) that legitimately
// touch multiple tables. `staff` is exempt because device CRUD and staff CRUD
// span the auth-owned tables (`staff`, `registered_devices`, `pending_device_setups`)
// per the ADR-034 ownership map — the staff module is a thin facade over those.
// `_codes` is exempt because its conformance tests deliberately read every
// table that owns a stable `code` identifier (staff, pos_inventory_skus,
// pos_products) to assert format invariants per ADR-034.
const ALLOWLIST = ["auth", "idempotency", "audit", "seed", "staff", "_codes"];

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "convex/_generated/**",
      "**/*.config.{js,ts,mjs}",
      "tools/eslint-rules/__tests__/fixtures/**",
      // Node-side build/maintenance scripts have their own conventions and
      // global expectations (`process`, `console`); not in scope for the
      // v0.2.1 module-boundary work.
      "scripts/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Project-wide TS tweaks
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `src/lib/format.ts` deliberately includes non-breaking + narrow
      // non-breaking spaces in a regex character class to normalise IDR
      // formatter output across ICU versions. Allow in strings/comments/regex.
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipComments: true, skipRegExps: true },
      ],
    },
  },

  {
    // Module-boundary rule — only meaningful inside convex/
    // __tests__ directories are exempt: test setup helpers legitimately seed
    // rows across module boundaries to build fixtures; that's test infra, not
    // production cross-module coupling.
    files: ["convex/**/*.ts"],
    ignores: ["convex/**/__tests__/**"],
    plugins: {
      "frollie-internal": {
        rules: {
          "no-cross-module-db-access": noCrossModuleDbAccess,
          "idempotency-required": idempotencyRequired,
        },
      },
    },
    rules: {
      "frollie-internal/idempotency-required": "warn", // flipped to "error" in Wave 2 final commit
      "frollie-internal/no-cross-module-db-access": [
        "error",
        {
          ownership: OWNERSHIP,
          allowlist: ALLOWLIST,
        },
      ],
    },
  },
];
