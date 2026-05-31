import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import rule from "../idempotency-required.js";

// vitest globals compatibility for ESLint 9 RuleTester
RuleTester.it = it;
RuleTester.describe = describe;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (name) => readFileSync(join(__dirname, "fixtures/idempotency", name), "utf8");

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2022, sourceType: "module" } },
});

tester.run("idempotency-required", rule, {
  valid: [
    { filename: "/x/convex/foo/public.ts", code: fix("passing.ts") },
    { filename: "/x/convex/foo/internal.ts", code: fix("exempt-internal.ts") },
    { filename: "/x/src/lib/whatever.ts", code: fix("missing-wrap.ts") }, // out-of-scope file
    { filename: "/x/convex/foo/public.ts", code: fix("passing-authcheck-ref.ts") },
  ],
  invalid: [
    {
      filename: "/x/convex/foo/public.ts",
      code: fix("missing-key.ts"),
      errors: [{ messageId: "missingIdempotencyKey" }],
    },
    {
      filename: "/x/convex/foo/public.ts",
      code: fix("missing-wrap.ts"),
      errors: [{ messageId: "missingWithIdempotency" }],
    },
    {
      filename: "/x/convex/foo/public.ts",
      code: fix("missing-authcheck.ts"),
      errors: [{ messageId: "missingAuthCheck" }],
    },
    {
      filename: "/x/convex/foo/bar/public.ts",
      code: fix("nested-public.ts"),
      errors: [{ messageId: "missingAuthCheck" }],
    },
  ],
});
