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
// Enforces React hook call-site rules (rules-of-hooks) and dep-array hygiene
// (exhaustive-deps) across all src/ components and hooks.
import reactHooks from "eslint-plugin-react-hooks";

import noCrossModuleDbAccess from "./tools/eslint-rules/no-cross-module-db-access.js";
import idempotencyRequired from "./tools/eslint-rules/idempotency-required.js";
import indexLeadsWithOutletId from "./tools/eslint-rules/index-leads-with-outlet_id.js";

// ADR-049 i18n selectors — declared once here because flat config does NOT merge
// no-restricted-syntax arrays; the last matching config's array replaces earlier
// ones. The v1.2 #12 block must re-include these so files in both registries
// (i18n + inline-messaging) still get the i18n fence.
const I18N_JSX_TEXT_SELECTOR = {
  selector: "JSXText[value=/[A-Za-z]{3,}/]",
  message:
    "Converted file: user-facing text must go through t(...) (ADR-049), not a hardcoded JSX literal.",
};
const I18N_TEXT_PROP_SELECTOR = {
  selector:
    "JSXAttribute[name.name=/^(label|placeholder|title|aria-label)$/] > Literal[value=/[A-Za-z]{3,}/]",
  message:
    "Converted file: text props must use t(...) (ADR-049).",
};

// Single source of truth for table ownership. When a new module + table pair
// lands, add the mapping here. Tables not present here are unpoliced.
const OWNERSHIP = {
  // auth module
  staff: "auth",
  staff_sessions: "auth",
  pos_auth_attempts: "auth",
  registered_devices: "auth",
  pending_device_setups: "auth",
  pos_device_activation_attempts: "auth", // SEC-04; written by allowlisted `staff` module
  // v2.0 multi-outlet: outlets + staff_outlet_access (deferred from Task 5)
  outlets: "outlets",
  staff_outlet_access: "auth",

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
  // receipts module
  pos_receipt_html_cache: "receipts",
  // refunds module
  pos_refunds: "refunds",
  // vouchers module
  pos_vouchers: "vouchers",
  pos_voucher_redemptions: "vouchers",
  // approvals module
  pos_approval_requests: "approvals",
  // shifts module
  pos_shift_events: "shifts",
  // idempotency module
  pos_idempotency: "idempotency",
  // audit module
  audit_log: "audit",
  // telegram module
  telegram_log: "telegram",
};

// v2.0 outlet-scope fence: tables that must be queried through a by_outlet*
// index (or an explicitly-kept outlet-agnostic index). The BROAD rule
// (index-leads-with-outlet_id) flags ANY non-by_outlet/non-kept index on these
// tables, making it a true completeness oracle (full defense-in-depth, user
// decision 2026-06-22). See rule header for rationale.
const OUTLET_SCOPED = [
  "staff_sessions",
  "pos_auth_attempts",
  "registered_devices",
  "pos_inventory_skus",
  "pos_products",
  "pos_product_components",
  "pos_transactions",
  "pos_transaction_lines",
  "pos_xendit_invoices",
  "pos_receipt_html_cache",
  "pos_refunds",
  "pos_stock_movements",
  "pos_stock_levels",
  "pos_low_stock_alerts",
  "pos_stock_drift_log",
  "pos_recount_state",
  "pos_vouchers",
  "pos_voucher_redemptions",
  "pos_approval_requests",
  "pos_shift_events",
  "pos_settings",
  "pos_error_reports",
  "pos_receipt_counters",
];

// Caller modules exempt from the outlet-scope fence. "migrations" is forward-safe
// (the module doesn't exist yet but will run full-table scans during data
// migrations). "seed" is exempt because seeding doesn't represent production
// coupling.
const OUTLET_FENCE_ALLOWLIST = ["migrations", "seed"];

// Non-by_outlet indexes that are LEGITIMATELY allowed on outlet-scoped tables:
// GLOBAL_UNIQUE lookups (the value is globally unique → outlet-agnostic) plus
// per-staff/token lookups that anchor to a business-level dimension. Any index
// NOT here and NOT matching /^by_outlet/ on a scoped table is an un-migrated
// reader (lint error). Deliberate cross-outlet readers (Public API feeds) use a
// per-line eslint-disable with a reason instead.
const OUTLET_KEPT_INDEXES = [
  // GLOBAL_UNIQUE (value globally unique)
  "by_token_hash",
  "by_xendit_invoice_id",
  "by_device_id",
  "by_receipt_token",
  "by_receipt_number",
  "by_line_and_sku",
  "by_signature_created",
  // per-staff / token (business-level dimensions, not outlet-scoped)
  "by_staff_active", // staff_sessions — staff is business-level
  "by_staff", // pos_auth_attempts — lockout is per-staff
  "by_staff_started", // pos_shift_events — kept per spec
  "by_token", // pos_receipt_html_cache — token globally unique
];

// Modules exempt from the rule. These tend to be infrastructure-y crosscuts
// (audit, idempotency) or single-file root utilities (seed) that legitimately
// touch multiple tables. `staff` is exempt because device CRUD and staff CRUD
// span the auth-owned tables (`staff`, `registered_devices`, `pending_device_setups`)
// per the ADR-034 ownership map — the staff module is a thin facade over those.
// `_codes` is exempt because its conformance tests deliberately read every
// table that owns a stable `code` identifier (staff, pos_inventory_skus,
// pos_products) to assert format invariants per ADR-034.
// (receipts used to live in this list while it joined pos_transactions /
// pos_transaction_lines / pos_xendit_invoices inline; v0.5.1 PR A review
// pulled it back inside ADR-034 boundaries — reads now route through
// transactions/internal + payments/internal aggregate helpers.)
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
      // Frozen in-tree snapshot of ceo-progress-report npm package (Node.js CJS/ESM).
      // Linted independently in its own package; not part of the POS app lint surface.
      "packages/**",
      // Reference implementation docs — not production code, not linted here.
      "docs/**",
      // Vendored Claude Code skills (browser-runtime JS with window/document
      // globals) and the npm-install canvas stub (CJS) — not POS app code.
      ".claude/**",
      "tools/stub-canvas/**",
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
    // React hooks hygiene — scoped to src/ where React components/hooks live.
    // rules-of-hooks: error — conditional/loop hook calls are real bugs.
    // exhaustive-deps: warn — surface stale-closure risks; existing intentional
    // single-shot effects with useRef guards carry focused disable comments.
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
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
      // NOTE: This is a CUSTOM rule plugin — not no-restricted-syntax. ESLint
      // flat config's last-wins hazard only applies to no-restricted-syntax
      // (whose selector arrays are replaced by later matching config blocks).
      // Custom plugin rules accumulate normally; no ordering concern here.
      "frollie-internal": {
        rules: {
          "no-cross-module-db-access": noCrossModuleDbAccess,
          "idempotency-required": idempotencyRequired,
          "index-leads-with-outlet_id": indexLeadsWithOutletId,
        },
      },
    },
    rules: {
      "frollie-internal/idempotency-required": "error",
      "frollie-internal/no-cross-module-db-access": [
        "error",
        {
          ownership: OWNERSHIP,
          allowlist: ALLOWLIST,
        },
      ],
      "frollie-internal/index-leads-with-outlet_id": [
        "error",
        {
          scopedTables: OUTLET_SCOPED,
          keptIndexes: OUTLET_KEPT_INDEXES,
          allowlist: OUTLET_FENCE_ALLOWLIST,
        },
      ],
    },
  },

  {
    // v1.2 #1 — i18n migration registry. Files here route user-facing copy through
    // t(); this fence stops regressions to hardcoded JSX text literals and string
    // literals in text props. Brand-name JSXText should be wrapped as {"Brand"} to
    // keep it out of the JSXText node type. Append files as later #1 slices convert
    // them; Task 7 will add the remaining routes. ADR-049.
    files: [
      "src/routes/home.tsx",
      "src/components/pos/LocaleToggle.tsx",
      "src/components/auth/StaffListItem.tsx",
      "src/routes/sale/charge-success.tsx",
      "src/routes/sale/charge.tsx",
      "src/routes/sale/drafts.tsx",
      "src/routes/sale/index.tsx",
      "src/routes/sale/voucher-reject-banner.tsx",
      "src/routes/sale/voucher.tsx",
      "src/routes/mgr/audit.tsx",
      "src/routes/mgr/dashboard.tsx",
      "src/routes/mgr/device-setup.tsx",
      "src/routes/mgr/home.tsx",
      "src/routes/mgr/products.tsx",
      "src/routes/mgr/receipt.tsx",
      "src/routes/mgr/refunds-pending.tsx",
      "src/routes/mgr/spoilage.tsx",
      "src/routes/mgr/staff.tsx",
      "src/routes/mgr/stock.tsx",
      "src/routes/mgr/telegram-chats.tsx",
      "src/routes/mgr/vouchers.tsx",
      "src/components/pos/AbandonCartDialog.tsx",
      "src/components/pos/ApprovalPending.tsx",
      "src/components/pos/CountStep.tsx",
      "src/components/pos/DayPicker.tsx",
      "src/components/pos/ManagerPickerOverlay.tsx",
      "src/components/pos/NumericKeypad.tsx",
      "src/components/pos/PinSheet.tsx",
      "src/components/pos/PrinterSheet.tsx",
      "src/components/pos/RefundLineSelector.tsx",
      "src/components/pos/ShiftWizard.tsx",
      "src/components/layout/AppHeader.tsx",
      "src/components/layout/ConnDot.tsx",
      "src/components/layout/DeviceActivation.tsx",
      "src/components/layout/RootLayout.tsx",
      "src/components/layout/Stub.tsx",
      "src/routes/account.tsx",
      "src/routes/lock.tsx",
      "src/routes/login.tsx",
      "src/routes/settlements.tsx",
      "src/routes/approve/index.tsx",
      "src/routes/history/$txnId.tsx",
      "src/routes/history/index.tsx",
      "src/routes/refund/detail.tsx",
      "src/routes/refund/index.tsx",
      "src/routes/shift/end.tsx",
      "src/routes/shift/handover.tsx",
      "src/routes/shift/start.tsx",
      "src/routes/stock/$skuId.tsx",
      "src/routes/stock/index.tsx",
      "src/routes/stock/recount.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        I18N_JSX_TEXT_SELECTOR,
        I18N_TEXT_PROP_SELECTOR,
      ],
    },
  },

  {
    // v1.2 #12 — inline-messaging migration registry. Files here have had their
    // sync form-validation toasts converted to <FieldMessage>; this fence stops
    // regressions to literal-arg toast.error/toast.warning. Heuristic: string-
    // literal first arg = sync validation (must be inline); dynamic first arg
    // (toast.error(humanizeX(err))) = server/async, stays legal; toast.success
    // stays legal. Append files here as later #12 slices convert them. ADR-048.
    // NOTE: flat config does NOT merge no-restricted-syntax; the last matching
    // config's array REPLACES earlier ones, so this block must re-include the
    // i18n selectors for files that appear in both registries.
    files: [
      "src/routes/mgr/products.tsx",
      "src/routes/mgr/vouchers.tsx",
      "src/routes/login.tsx",
      "src/routes/settlements.tsx",
      "src/routes/mgr/staff.tsx",
      "src/components/layout/DeviceActivation.tsx",
      "src/routes/mgr/receipt.tsx",
      "src/routes/mgr/stock.tsx",
      "src/routes/stock/$skuId.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        I18N_JSX_TEXT_SELECTOR,
        I18N_TEXT_PROP_SELECTOR,
        {
          selector:
            "CallExpression[callee.object.name='toast'][callee.property.name='error'][arguments.0.type='Literal']",
          message:
            'Sync form-validation must use <FieldMessage>, not toast.error("literal"). Dynamic server errors (toast.error(humanizeX(err))) stay legal. See ADR-048.',
        },
        {
          selector:
            "CallExpression[callee.object.name='toast'][callee.property.name='error'][arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0]",
          message:
            "Sync form-validation must use <FieldMessage>, not a literal toast.error(`...`). See ADR-048.",
        },
        {
          selector:
            "CallExpression[callee.object.name='toast'][callee.property.name='warning'][arguments.0.type='Literal']",
          message:
            'Sync form-validation must use <FieldMessage>, not toast.warning("literal"). See ADR-048.',
        },
        {
          selector:
            "CallExpression[callee.object.name='toast'][callee.property.name='error'][arguments.0.type='CallExpression'][arguments.0.callee.name='t']",
          message:
            "Sync form-validation must use <FieldMessage>, not toast.error(t(...)). Server/async toasts route through humanize*Error(err,t) or a local variable (const msg = t(...); toast.error(msg)). See ADR-048.",
        },
        {
          selector:
            "CallExpression[callee.object.name='toast'][callee.property.name='warning'][arguments.0.type='CallExpression'][arguments.0.callee.name='t']",
          message:
            "Sync form-validation must use <FieldMessage>, not toast.warning(t(...)). See ADR-048.",
        },
      ],
    },
  },
];
