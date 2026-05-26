/**
 * ESLint rule: no-cross-module-db-access
 *
 * Enforces ADR-034 — deep modules + surface APIs. A Convex module may only
 * call `ctx.db.<method>("<table>", ...)` against tables it OWNS. To read
 * another module's data, route through that module's public/internal
 * functions (its "surface API"). This guardrail must land BEFORE the flat
 * convex/ layout is split into modules; otherwise mid-migration leaks are
 * invisible.
 *
 * Options:
 *   - ownership: { [tableName: string]: ownerModuleName }
 *   - allowlist: string[] of module names that are exempt (e.g., "audit",
 *     "idempotency", "auth", "seed").
 *
 * Caller-module derivation:
 *   - convex/<module>/...        → module is "<module>"
 *   - convex/<file>.ts           → root file, exempt (treated as orchestration)
 *   - anything outside convex/   → not checked
 *
 * Path normalisation handles Windows backslashes and resolves the LAST
 * "/convex/" segment so a parent directory called "convex" (e.g. local clone
 * paths) doesn't fool the anchor.
 */

"use strict";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent direct ctx.db.* access to tables owned by another Convex module (ADR-034).",
    },
    schema: [
      {
        type: "object",
        properties: {
          ownership: {
            type: "object",
            additionalProperties: { type: "string" },
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
      crossModule:
        "Module '{{caller}}' must not access table '{{table}}' directly — owned by module '{{owner}}'. Route through {{owner}}'s public/internal API (ADR-034).",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const ownership = options.ownership || {};
    const allowlist = new Set(options.allowlist || []);

    const rawFilename = context.filename || context.getFilename?.() || "";
    const normalised = rawFilename.replace(/\\/g, "/");

    // Find the LAST "/convex/" segment, or a leading "convex/" if the path is
    // relative. This is robust against parent directories that also happen to
    // be named "convex".
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

    // If we couldn't derive a module, or it's allow-listed, skip.
    const shouldCheck =
      callerModule !== null && !allowlist.has(callerModule);

    if (!shouldCheck) {
      return {};
    }

    return {
      CallExpression(node) {
        // Match `ctx.db.<method>("table", ...)`
        const callee = node.callee;
        if (!callee || callee.type !== "MemberExpression") return;

        const dbAccess = callee.object;
        if (
          !dbAccess ||
          dbAccess.type !== "MemberExpression" ||
          dbAccess.property?.type !== "Identifier" ||
          dbAccess.property.name !== "db"
        ) {
          return;
        }

        // The ctx side: any identifier or member that ends with `.db` qualifies.
        // We don't gate on the identifier name being literally "ctx" because
        // helpers sometimes destructure or rename.

        const firstArg = node.arguments[0];
        if (!firstArg) return;
        if (firstArg.type !== "Literal" || typeof firstArg.value !== "string") {
          return;
        }

        const table = firstArg.value;
        const owner = ownership[table];
        if (!owner) return; // unknown table — not policed
        if (owner === callerModule) return; // self-owned access

        context.report({
          node,
          messageId: "crossModule",
          data: {
            table,
            owner,
            caller: callerModule,
          },
        });
      },
    };
  },
};

export default rule;
