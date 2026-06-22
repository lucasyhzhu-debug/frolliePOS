// Tests for the index-leads-with-outlet_id ESLint rule.
//
// Broad design (full defense-in-depth): on outlet-scoped tables, by_outlet*
// indexes must lead with outlet_id; non-by_outlet indexes are an ERROR UNLESS
// they're in keptIndexes (GLOBAL_UNIQUE + per-staff/token). Allowlisted modules
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
    keptIndexes: ["by_staff", "by_token"],
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
      // Broad design: by_staff is in keptIndexes → allowed on a scoped table.
      // per-staff lockout lookups anchor to a business-level dimension.
      name: "by_staff index on pos_auth_attempts (kept) — allowed",
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
      // Broad design: by_token is in keptIndexes (token globally unique) → allowed.
      name: "by_token index on pos_receipt_html_cache (kept) — allowed",
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
    {
      // Broad design: a non-by_outlet, non-kept index on a scoped table is an
      // un-migrated reader → ERROR (this is what makes the fence a completeness
      // oracle).
      name: "by_status_paid_at on pos_transactions (non-by_outlet, non-kept) — ERROR",
      filename: "convex/transactions/internal.ts",
      code: `
        export const list = async (ctx) => {
          return await ctx.db
            .query("pos_transactions")
            .withIndex("by_status_paid_at", (q) => q.eq("status", "paid"))
            .collect();
        };
      `,
      options: OPTIONS,
      errors: [
        {
          messageId: "mustScopeByOutlet",
          data: { table: "pos_transactions", index: "by_status_paid_at" },
        },
      ],
    },
  ],
});
