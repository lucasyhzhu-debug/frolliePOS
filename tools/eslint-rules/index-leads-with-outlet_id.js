/**
 * ESLint rule: index-leads-with-outlet_id
 *
 * NARROW DESIGN (v2.0 Stream 8) — enforces that any Convex query against an
 * OUTLET_SCOPED table using a `by_outlet*` index MUST lead its callback with
 * `.eq("outlet_id", <value>)` as the first field in the chain.
 *
 * WHY NARROW (not the spec's broad "flag any non-by_outlet / non-GLOBAL_UNIQUE
 * index" design):
 *   The broad design would false-flag legitimately-kept single-key indexes such
 *   as `by_staff`, `by_token`, `by_staff_active`, `by_staff_started` — queries
 *   that are correct and do not need an outlet_id prefix because they already
 *   anchor to a unique or per-staff dimension. Flagging those would make lint
 *   red before Task 9 migrates readers, turning the fence into noise.
 *
 *   The narrow check is exactly the Task-9 completeness oracle: "every
 *   by_outlet_* query leads with outlet_id." Completeness ("no un-migrated
 *   readers remain") is covered separately by Task 9's grep enumeration + Task
 *   12's old-index DROP (which turns any stale-index reader into a typecheck
 *   error). So no GLOBAL_UNIQUE allowlist is needed.
 *
 * Behaviour:
 *   - On `.withIndex("<name>", cb)` where `<name>` matches `/^by_outlet/` AND
 *     the enclosing `.query("<table>")` table is in `scopedTables`, assert that
 *     the first `.eq(...)` call inside `cb` has `"outlet_id"` as its first arg.
 *   - Index names that do NOT match `/^by_outlet/` are silently ignored,
 *     regardless of whether the table is outlet-scoped.
 *   - Allowlisted caller modules (e.g. "migrations", "seed") skip the check
 *     entirely — migrations need to read old layout, and seed doesn't represent
 *     production coupling.
 *
 * Options:
 *   - scopedTables: string[]  — tables that must be queried with outlet scope.
 *   - allowlist: string[]     — caller module names exempt from the rule.
 *
 * Caller-module derivation mirrors no-cross-module-db-access.js exactly:
 *   convex/<module>/...  → module is "<module>"
 *   convex/<file>.ts     → root file, exempt (treated as orchestration)
 *   outside convex/      → not checked
 *
 * NOTE: This is a CUSTOM rule (not no-restricted-syntax). ESLint flat config's
 * last-wins hazard only applies to the no-restricted-syntax rule whose selector
 * arrays are replaced rather than merged across matching config blocks. Custom
 * plugin rules accumulate normally — no ordering concern here.
 */

"use strict";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "On outlet-scoped tables, any withIndex('by_outlet*', cb) must lead cb with .eq('outlet_id', …) (v2.0 narrow fence).",
    },
    schema: [
      {
        type: "object",
        properties: {
          scopedTables: {
            type: "array",
            items: { type: "string" },
          },
          allowlist: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      mustLeadOutlet:
        "Query on '{{table}}' using index '{{index}}' must lead with .eq(\"outlet_id\", …) as the first field (v2.0 outlet-scoped index rule).",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const scopedTables = new Set(options.scopedTables || []);
    const allowlist = new Set(options.allowlist || []);

    // Derive caller module from filename — mirrors no-cross-module-db-access.js
    const rawFilename = context.filename || context.getFilename?.() || "";
    const normalised = rawFilename.replace(/\\/g, "/");

    let callerModule = null;
    const lastConvexIdx = normalised.lastIndexOf("/convex/");
    let afterConvex = null;
    if (lastConvexIdx !== -1) {
      afterConvex = normalised.slice(lastConvexIdx + "/convex/".length);
    } else if (normalised.startsWith("convex/")) {
      afterConvex = normalised.slice("convex/".length);
    }

    if (afterConvex !== null) {
      const firstSlash = afterConvex.indexOf("/");
      if (firstSlash === -1) {
        // convex/<file>.ts — root file, exempt
        callerModule = null;
      } else {
        callerModule = afterConvex.slice(0, firstSlash);
      }
    }

    // If we couldn't derive a module or it's allowlisted, skip entirely
    const shouldCheck = callerModule !== null && !allowlist.has(callerModule);
    if (!shouldCheck) {
      return {};
    }

    /**
     * Resolve the table name being queried by walking the `.withIndex(...)` call
     * expression's callee chain upward to find the `.query("<table>")` call.
     *
     * Handles chains like:
     *   ctx.db.query("pos_transactions").withIndex("by_outlet_*", cb)
     *   ctx.db.query("pos_transactions").withIndex(...).withIndex("by_outlet_*", cb)
     * Returns null if the pattern doesn't match.
     */
    function resolveQueryTable(withIndexNode) {
      // withIndexNode.callee is the MemberExpression `<chain>.withIndex`
      // withIndexNode.callee.object is the chain before `.withIndex`
      let chain = withIndexNode.callee.object;

      // Walk up through any intermediate chain steps (other .withIndex, .filter, etc.)
      while (
        chain &&
        chain.type === "CallExpression" &&
        chain.callee &&
        chain.callee.type === "MemberExpression"
      ) {
        const propName = chain.callee.property?.name;
        if (propName === "query") {
          // Found it: chain.arguments[0] should be the table name literal
          const tableArg = chain.arguments[0];
          if (tableArg && tableArg.type === "Literal" && typeof tableArg.value === "string") {
            return tableArg.value;
          }
          return null;
        }
        // Keep walking up
        chain = chain.callee.object;
      }
      return null;
    }

    /**
     * Find the first `.eq(...)` call inside the callback body chain.
     *
     * The callback parameter (`cb`) is typically `(q) => q.eq("a", x).eq("b", y)…`
     * We walk the outermost CallExpression chain of the body to find the leftmost
     * (first) `.eq` call. The "first" field in Convex's index chain is the
     * deepest `.eq` in the syntax tree — `.eq("a").eq("b")` has `.eq("b")` as
     * the outer call and `.eq("a")` nested inside.
     *
     * Strategy: collect ALL `.eq` calls in the chain bottom-up, then the last one
     * in the array is the innermost (first field in the index).
     */
    function findFirstEqInCallback(callbackNode) {
      // The body of the arrow function or function expression
      let body = null;
      if (callbackNode.type === "ArrowFunctionExpression" || callbackNode.type === "FunctionExpression") {
        body = callbackNode.body;
      } else {
        return null;
      }

      // If body is a block statement, look at return statement
      if (body.type === "BlockStatement") {
        for (const stmt of body.body) {
          if (stmt.type === "ReturnStatement" && stmt.argument) {
            body = stmt.argument;
            break;
          }
        }
        if (body.type === "BlockStatement") return null; // no return found
      }

      // Collect eq calls from outermost to innermost.
      // Range methods (gte, gt, lte, lt) may appear at the outer end of the
      // chain (after the eq fields in the index definition) — skip past them
      // before walking the eq chain.
      const rangeNames = new Set(["gte", "gt", "lte", "lt"]);
      const eqCalls = [];
      let current = body;
      // Skip any leading range methods (outermost calls)
      while (
        current &&
        current.type === "CallExpression" &&
        current.callee &&
        current.callee.type === "MemberExpression" &&
        rangeNames.has(current.callee.property?.name)
      ) {
        current = current.callee.object;
      }
      // Now collect the eq chain
      while (
        current &&
        current.type === "CallExpression" &&
        current.callee &&
        current.callee.type === "MemberExpression" &&
        current.callee.property?.name === "eq"
      ) {
        eqCalls.push(current);
        current = current.callee.object;
      }

      // The innermost (deepest) .eq is the FIRST field in the index chain
      if (eqCalls.length === 0) return null;
      return eqCalls[eqCalls.length - 1];
    }

    return {
      CallExpression(node) {
        // Match .withIndex("<name>", cb)
        const callee = node.callee;
        if (!callee || callee.type !== "MemberExpression") return;
        if (callee.property?.name !== "withIndex") return;

        // Check index name: must match /^by_outlet/ to be in scope
        const indexNameArg = node.arguments[0];
        if (!indexNameArg || indexNameArg.type !== "Literal" || typeof indexNameArg.value !== "string") {
          return; // non-literal index name — gracefully skip
        }
        const indexName = indexNameArg.value;
        if (!/^by_outlet/.test(indexName)) {
          return; // narrow design: non-by_outlet indexes are ignored
        }

        // Resolve the queried table
        const table = resolveQueryTable(node);
        if (!table) return; // can't determine table — gracefully skip
        if (!scopedTables.has(table)) return; // not an outlet-scoped table

        // Inspect the callback (2nd arg)
        const callbackArg = node.arguments[1];
        if (!callbackArg) return;

        const firstEq = findFirstEqInCallback(callbackArg);
        if (!firstEq) {
          // No .eq calls at all — definitely missing outlet_id
          context.report({
            node,
            messageId: "mustLeadOutlet",
            data: { table, index: indexName },
          });
          return;
        }

        // Check that the first .eq's first argument is the string literal "outlet_id"
        const firstEqField = firstEq.arguments[0];
        const leadsWithOutlet =
          firstEqField &&
          firstEqField.type === "Literal" &&
          firstEqField.value === "outlet_id";

        if (!leadsWithOutlet) {
          context.report({
            node,
            messageId: "mustLeadOutlet",
            data: { table, index: indexName },
          });
        }
      },
    };
  },
};

export default rule;
