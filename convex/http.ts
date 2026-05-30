import { httpRouter } from "convex/server";
import { buildHandleTelegramWebhook } from "./telegram/webhook";
import { buildRegistryCommands } from "./telegram/registryCommands";
import { xenditWebhook } from "./payments/webhook";

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

export default http;
