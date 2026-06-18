import { httpRouter } from "convex/server";
import { buildHandleTelegramWebhook } from "./telegram/webhook";
import { buildRegistryCommands } from "./telegram/registryCommands";
import { buildActivatePosCommand } from "./telegram/activatePos";
import { xenditWebhook } from "./payments/webhook";
import { handleReceiptRoute } from "./receipts/http";
import { opsErrorRoute } from "./ops/http";
import { handleTransactionsRoute } from "./api/v1/transactions";
import { handleRefundsRoute } from "./api/v1/refunds";

const http = httpRouter();

// Telegram delivers updates as JSON POSTs. The path here MUST match the URL
// you pass to setWebhook in Task 6.
// v0.4: command-registry webhook (replaces POC callback handler).
// trackLastSeen wires non-command messages to touchChatLastSeen so the mgr UI
// shows live "last seen" stamps.
http.route({
  path: "/telegram-webhook",
  method: "POST",
  handler: buildHandleTelegramWebhook(
    (scheduler) => [
      ...buildRegistryCommands(scheduler),
      ...buildActivatePosCommand(scheduler),
    ],
    { trackLastSeen: true },
  ),
});

// Xendit payment webhook — signature verified via constant-time x-callback-token check.
http.route({
  path: "/payments/webhook",
  method: "POST",
  handler: xenditWebhook,
});

// Public receipt URL — token in path segment is the capability per ADR-021.
http.route({
  pathPrefix: "/r/",
  method: "GET",
  handler: handleReceiptRoute,
});

// Error ingest — token-gated, always returns 2xx (204=bad/missing token, 200=ok).
http.route({ path: "/ops/error", method: "POST", handler: opsErrorRoute });

// External API — Frollie Pro consumer.
http.route({
  path: "/api/v1/transactions",
  method: "GET",
  handler: handleTransactionsRoute,
});

http.route({ path: "/api/v1/refunds", method: "GET", handler: handleRefundsRoute });

export default http;
