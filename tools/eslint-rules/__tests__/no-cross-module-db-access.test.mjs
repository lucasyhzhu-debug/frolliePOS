// Tests for the no-cross-module-db-access ESLint rule.
//
// Uses ESLint's RuleTester with vitest globals. The rule prevents one Convex
// module from touching another module's tables via ctx.db.* and is the
// enforcement mechanism for ADR-034 (deep modules + surface APIs).

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

import rule from "../no-cross-module-db-access.js";

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
    ownership: {
      pos_products: "catalog",
      pos_inventory_skus: "catalog",
      audit_log: "audit",
      pos_idempotency: "idempotency",
      staff: "auth",
    },
    allowlist: ["auth", "idempotency", "audit", "seed"],
  },
];

ruleTester.run("no-cross-module-db-access", rule, {
  valid: [
    {
      name: "catalog/public.ts reads pos_products (owns it)",
      filename: "convex/catalog/public.ts",
      code: `export const list = async (ctx) => { return await ctx.db.query("pos_products").collect(); };`,
      options: OPTIONS,
    },
    {
      name: "cart/public.ts calls logAudit helper (not direct ctx.db)",
      filename: "convex/cart/public.ts",
      code: `import { logAudit } from "../audit/internal"; export const handle = async (ctx, args) => { await logAudit(ctx, { action: "x" }); };`,
      options: OPTIONS,
    },
    {
      name: "convex/seed.ts (root) reads pos_products — exempt",
      filename: "convex/seed.ts",
      code: `export const run = async (ctx) => { return await ctx.db.query("pos_products").collect(); };`,
      options: OPTIONS,
    },
  ],
  invalid: [
    {
      name: "cart/public.ts queries cross-module pos_products",
      filename: "convex/cart/public.ts",
      code: `export const peek = async (ctx) => { return await ctx.db.query("pos_products").collect(); };`,
      options: OPTIONS,
      errors: [
        {
          messageId: "crossModule",
          data: { table: "pos_products", owner: "catalog", caller: "cart" },
        },
      ],
    },
    {
      name: "transactions/public.ts inserts into audit_log directly",
      filename: "convex/transactions/public.ts",
      code: `export const t = async (ctx) => { await ctx.db.insert("audit_log", {}); };`,
      options: OPTIONS,
      errors: [
        {
          messageId: "crossModule",
          data: { table: "audit_log", owner: "audit", caller: "transactions" },
        },
      ],
    },
    {
      name: "Windows-path cart/public.ts queries cross-module — verifies path normalisation",
      filename: "D:\\Claude\\FrolliePOS\\convex\\cart\\public.ts",
      code: `export const peek = async (ctx) => { return await ctx.db.query("pos_products").collect(); };`,
      options: OPTIONS,
      errors: [
        {
          messageId: "crossModule",
          data: { table: "pos_products", owner: "catalog", caller: "cart" },
        },
      ],
    },
  ],
});
