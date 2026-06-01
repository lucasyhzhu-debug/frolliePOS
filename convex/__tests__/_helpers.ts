// convex/__tests__/_helpers.ts
//
// Shared test helpers for convex tests. Extracted in v0.5.2 from inventory + transactions
// test files that all installed the same Telegram fetch stub + drainScheduled helper.
//
// The fetch stub is necessary because state-changing paths (sale confirm, recount,
// low-stock alert) schedule a Telegram dispatch via runAfter(0). Without an offline
// fetch stub + env vars, those scheduled actions would attempt real Telegram HTTP
// calls in CI. With this stub, the actions resolve cleanly so we can drain the
// scheduler in teardown without unhandled-rejection noise.

import { beforeEach, afterEach } from "vitest";
import type { convexTest } from "convex-test";

/**
 * Install the Telegram fetch stub + env vars for the enclosing describe.
 * Wires beforeEach/afterEach itself — callers just invoke it at the top of
 * their describe block (or at module scope to apply to all tests in the file).
 */
export function setupTelegramStub(): void {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    process.env.TELEGRAM_CHAT_ID = "-1001234567";
    process.env.POS_BASE_URL = "https://pos.dev";
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("telegram")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => "{}",
        } as unknown as Response;
      }
      return realFetch(url as RequestInfo);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
}

/**
 * Yield to the event loop so runAfter(0) jobs move from pending → inProgress,
 * then drain. Same idiom as convex/auth/__tests__/auth.test.ts. Use in any test
 * that triggers a scheduled Telegram dispatch so it doesn't fire after teardown.
 */
export async function drainScheduled(t: ReturnType<typeof convexTest>): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await t.finishInProgressScheduledFunctions();
}
