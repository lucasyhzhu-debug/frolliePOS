// Tests for the index-leads-with-outlet_id ESLint rule.
//
// Narrow design: only by_outlet* indexes on outlet-scoped tables are checked.
// Non-by_outlet indexes are ignored regardless of table. Allowlisted modules
// (migrations, seed) skip the check entirely.

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

import rule from "../index-leads-with-outlet_id.js";

// vitest globals compatibility for ESLint 9 RuleTester
RuleTester.it = it;
RuleTester.describe = describe;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const OPTIONS = [
  {
    scopedTables: ["pos_transactions", "pos_auth_attempts", "pos_receipt_html_cache"],
    allowlist: ["migrations", "seed"],
  },
];

ruleTester.run("index-leads-with-outlet_id", rule, {
  valid: [
    {
      name: "by_outlet_status_created on pos_transactions with outlet_id leading — PASS",
      filename: "convex/transactions/public.ts",
      code: `
        export const list = async (ctx, args) => {
          const oid = args.outletId;
          return await ctx.db
            .query("pos_transactions")
            .withIndex("by_outlet_status_created", (q) =>
              q.eq("outlet_id", oid).eq("status", "paid")
            )
            .collect();
        };
      `,
      options: OPTIONS,
    },
    {
      // Narrow design: non-by_outlet indexes on outlet-scoped tables are ignored.
      // by_staff on pos_auth_attempts is a legitimate single-key index for
      // per-staff lockout lookups — no outlet_id needed there.
      name: "by_staff index on pos_auth_attempts (non-by_outlet) — ignored by narrow design",
      filename: "convex/auth/internal.ts",
      code: `
        export const check = async (ctx, args) => {
          return await ctx.db
            .query("pos_auth_attempts")
            .withIndex("by_staff", (q) => q.eq("staff_id", args.staffId))
            .collect();
        };
      `,
      options: OPTIONS,
    },
    {
      // Narrow design: by_token on pos_receipt_html_cache is a unique-key index —
      // not a by_outlet_* name, so the rule ignores it entirely.
      name: "by_token index on pos_receipt_html_cache (non-by_outlet) — ignored by narrow design",
      filename: "convex/receipts/internal.ts",
      code: `
        export const get = async (ctx, args) => {
          return await ctx.db
            .query("pos_receipt_html_cache")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .first();
        };
      `,
      options: OPTIONS,
    },
    {
      // Allowlisted module: migrations/internal.ts may use by_outlet_* indexes
      // without leading with outlet_id (e.g. full-table migration scans).
      name: "allowlisted module (migrations) using by_outlet_* without outlet_id — PASS",
      filename: "convex/migrations/internal.ts",
      code: `
        export const migrate = async (ctx) => {
          return await ctx.db
            .query("pos_transactions")
            .withIndex("by_outlet_status_created", (q) => q.eq("status", "paid"))
            .collect();
        };
      `,
      options: OPTIONS,
    },
    {
      // Allowlisted module: seed/internal.ts is also exempt.
      name: "allowlisted module (seed) using by_outlet_* without outlet_id — PASS",
      filename: "convex/seed/internal.ts",
      code: `
        export const seed = async (ctx) => {
          return await ctx.db
            .query("pos_transactions")
            .withIndex("by_outlet_status_created", (q) => q.eq("status", "paid"))
            .collect();
        };
      `,
      options: OPTIONS,
    },
  ],
  invalid: [
    {
      name: "by_outlet_status_created on pos_transactions missing outlet_id — ERROR",
      filename: "convex/transactions/public.ts",
      code: `
        export const list = async (ctx, args) => {
          return await ctx.db
            .query("pos_transactions")
            .withIndex("by_outlet_status_created", (q) => q.eq("status", "paid"))
            .collect();
        };
      `,
      options: OPTIONS,
      errors: [
        {
          messageId: "mustLeadOutlet",
          data: { table: "pos_transactions", index: "by_outlet_status_created" },
        },
      ],
    },
  ],
});
