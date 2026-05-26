import { httpRouter } from "convex/server";
import { telegramWebhook } from "./telegram/webhook";

const http = httpRouter();

// Telegram delivers updates as JSON POSTs. The path here MUST match the URL
// you pass to setWebhook in Task 6.
http.route({
  path: "/telegram-webhook",
  method: "POST",
  handler: telegramWebhook,
});

export default http;
