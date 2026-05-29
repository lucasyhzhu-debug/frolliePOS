import { httpRouter } from "convex/server";
import { telegramWebhook } from "./telegram/webhook";
import { xenditWebhook } from "./payments/webhook";

const http = httpRouter();

// Telegram delivers updates as JSON POSTs. The path here MUST match the URL
// you pass to setWebhook in Task 6.
http.route({
  path: "/telegram-webhook",
  method: "POST",
  handler: telegramWebhook,
});

// Xendit payment webhook — signature verified via constant-time x-callback-token check.
http.route({
  path: "/payments/webhook",
  method: "POST",
  handler: xenditWebhook,
});

export default http;
