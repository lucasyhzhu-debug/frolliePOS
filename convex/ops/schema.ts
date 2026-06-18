import { defineTable } from "convex/server";
import { v } from "convex/values";

// Append-only launch-ops telemetry. NOT audit_log (ADR-007) — this is
// error/crash telemetry with dedup + storm-cap, not a business audit trail.
export const opsTables = {
  pos_error_reports: defineTable({
    kind: v.union(
      v.literal("crash"),      // RouteErrorBoundary trip
      v.literal("unhandled"),  // window.onerror / unhandledrejection
      v.literal("payment"),    // payment-path failure (FE or BE)
      v.literal("mutation"),   // sale-flow mutation failure (FE)
      v.literal("backend"),    // BE action/webhook processing failure
    ),
    message: v.string(),           // truncated server-side to MESSAGE_MAX
    stack: v.optional(v.string()), // truncated server-side to STACK_MAX
    route: v.optional(v.string()),
    staff_code: v.optional(v.string()),
    device_id: v.optional(v.string()),
    online: v.optional(v.boolean()),
    app_version: v.optional(v.string()),
    signature: v.string(),         // pure hash(kind + route + normalized message)
    alerted: v.boolean(),          // did this row trigger a Telegram send?
    created_at: v.number(),        // server time (ADR-031)
  })
    .index("by_signature_created", ["signature", "created_at"])
    .index("by_created", ["created_at"])
    // Storm-cap lookup: newest alerted row. Composite avoids scanning the
    // (potentially large) prefix of suppressed alerted:false rows during a storm.
    .index("by_alerted_created", ["alerted", "created_at"]),
};
