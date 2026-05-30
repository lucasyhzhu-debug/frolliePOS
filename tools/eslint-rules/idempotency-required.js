/**
 * ESLint rule: idempotency-required
 *
 * For every `export const X = mutation({...})` in convex/<module>/public.ts:
 *   (a) `args` must include `idempotencyKey: v.string()`
 *   (b) `handler` must be a call to `withIdempotency(...)`
 *   (c) the third arg of `withIdempotency` must be an object with an `authCheck` property
 *
 * Scope: convex/<module>/public.ts ONLY. Other files exempt.
 *
 * See ADR-013 + v0.5.0 spec §6.
 */

"use strict";

const PUBLIC_TS_REGEX = /[\\/]convex[\\/](?:[^\\/]+[\\/])+public\.ts$/;

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Enforce idempotencyKey + withIdempotency + authCheck on public mutations." },
    schema: [],
    messages: {
      missingIdempotencyKey:
        "Public mutation '{{name}}' must accept `idempotencyKey: v.string()` (ADR-013).",
      missingWithIdempotency:
        "Public mutation '{{name}}' handler must be wrapped in `withIdempotency(...)` (ADR-013).",
      missingAuthCheck:
        "Public mutation '{{name}}' must wire an `authCheck` in the `withIdempotency` options object (v0.5.0 strict rule).",
    },
  },

  create(context) {
    const filename = (context.filename || context.getFilename?.() || "").replace(/\\/g, "/");
    if (!PUBLIC_TS_REGEX.test(filename)) return {};

    return {
      ExportNamedDeclaration(node) {
        if (!node.declaration || node.declaration.type !== "VariableDeclaration") return;
        for (const decl of node.declaration.declarations) {
          if (!decl.init || decl.init.type !== "CallExpression") continue;
          const callee = decl.init.callee;
          if (!callee || callee.type !== "Identifier" || callee.name !== "mutation") continue;

          const mutationName = decl.id?.type === "Identifier" ? decl.id.name : "<anonymous>";
          const arg0 = decl.init.arguments[0];
          if (!arg0 || arg0.type !== "ObjectExpression") continue;

          const argsProp = arg0.properties.find(
            (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "args",
          );
          const handlerProp = arg0.properties.find(
            (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "handler",
          );

          // Assertion (a): args has idempotencyKey: v.string()
          const argsObj = argsProp && argsProp.value.type === "ObjectExpression" ? argsProp.value : null;
          const hasIdemKey =
            argsObj &&
            argsObj.properties.some(
              (p) =>
                p.type === "Property" &&
                p.key.type === "Identifier" &&
                p.key.name === "idempotencyKey" &&
                p.value.type === "CallExpression" &&
                p.value.callee.type === "MemberExpression" &&
                p.value.callee.object.type === "Identifier" &&
                p.value.callee.object.name === "v" &&
                p.value.callee.property.type === "Identifier" &&
                p.value.callee.property.name === "string",
            );
          if (!hasIdemKey) {
            context.report({ node: decl, messageId: "missingIdempotencyKey", data: { name: mutationName } });
          }

          // Assertion (b): handler is a call to withIdempotency(...)
          const handlerVal = handlerProp?.value;
          const isWithIdem =
            handlerVal &&
            handlerVal.type === "CallExpression" &&
            ((handlerVal.callee.type === "Identifier" && handlerVal.callee.name === "withIdempotency") ||
              // tolerate `withIdempotency<T,R>(...)` — TS parser leaves callee as Identifier still
              false);
          if (!isWithIdem) {
            context.report({ node: decl, messageId: "missingWithIdempotency", data: { name: mutationName } });
            continue; // can't check authCheck if there's no withIdempotency call
          }

          // Assertion (c): withIdempotency's 3rd arg has an authCheck property
          const optionsArg = handlerVal.arguments[2];
          const hasAuthCheck =
            optionsArg &&
            optionsArg.type === "ObjectExpression" &&
            optionsArg.properties.some(
              (p) =>
                p.type === "Property" &&
                p.key.type === "Identifier" &&
                p.key.name === "authCheck",
            );
          if (!hasAuthCheck) {
            context.report({ node: decl, messageId: "missingAuthCheck", data: { name: mutationName } });
          }
        }
      },
    };
  },
};

export default rule;
