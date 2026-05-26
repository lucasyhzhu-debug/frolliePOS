# Telegram POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working POC that proves Convex ↔ Telegram bot round-trip messaging via a three-template playground UI (manager approval with buttons, founders shift summary, free-form custom) and a webhook that records button presses and edits the original message. Includes a Vitest + convex-test suite as a first-class deliverable.

**Architecture:** First-Convex-code-in-repo bootstrap. Single Convex action `sendTemplate({kind, payload})` POSTs to `api.telegram.org`; a Convex `httpAction` at `/telegram-webhook` receives `callback_query` updates, verifies the `X-Telegram-Bot-Api-Secret-Token` header, dedupes by `update_id`, then `answerCallbackQuery` + `editMessageText`. One `telegram_log` table backs a reactive UI list at `/dev/telegram`. Test suite covers pure functions (HTML escape, template renderers) and Convex integration (webhook security + dedupe via `convex-test`).

**Tech Stack:** Convex 1.31.7, React 19 + Vite, react-router 7, Tailwind 4, `@radix-ui/react-tabs` (already in deps), `parse_mode: "HTML"` for Telegram messages, **Vitest + convex-test + @edge-runtime/vm** for testing.

**Spec reference:** `docs/superpowers/specs/2026-05-25-telegram-poc-design.md`

---

## File Structure

**Create (production code):**
- `convex/schema.ts` — `telegram_log` table
- `convex/lib/telegramHtml.ts` — pure functions: HTML escape + three template renderers
- `convex/telegram/send.ts` — `sendTemplate` action (outbound)
- `convex/telegram/webhook.ts` — `httpAction` (inbound) + `recordCallback` mutation
- `convex/telegram/queries.ts` — `listRecentLog` query for the UI feed
- `convex/http.ts` — Convex HTTP router, mounts `POST /telegram-webhook`
- `src/routes/dev/telegram.tsx` — playground UI (3-tab message composer + live feed)

**Create (test code):**
- `vitest.config.ts` — Vitest configuration with `edge-runtime` environment
- `convex/lib/telegramHtml.test.ts` — pure-function tests for escape + renderers
- `convex/telegram/webhook.test.ts` — integration tests using `convex-test` (secret verification, dedupe)

**Modify:**
- `package.json` — add `test` and `test:run` scripts + Vitest/convex-test devDependencies
- `src/router.tsx` — add lazy import + `/dev/telegram` route
- `docs/CHANGELOG.md` — POC entry

**Auto-generated (do not write by hand):**
- `convex/_generated/*` — created by `npx convex dev` on first run

---

## Task 1: Bootstrap Convex schema + dev deployment

**Files:**
- Create: `convex/schema.ts`

- [ ] **Step 1: Create `convex/schema.ts`**

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// POC: telegram_log is intentionally NOT prefixed with `pos_` — sandbox table
// that gets replaced (or absorbed into pos_approval_requests) if/when the POC
// graduates. See docs/superpowers/specs/2026-05-25-telegram-poc-design.md.
export default defineSchema({
  telegram_log: defineTable({
    direction: v.union(v.literal("out"), v.literal("in")),
    template_kind: v.optional(v.string()),
    payload_json: v.string(),
    update_id: v.optional(v.number()),
    callback_data: v.optional(v.string()),
    from_user: v.optional(v.string()),
    message_id: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_update_id", ["update_id"])
    .index("by_created_at", ["created_at"]),
});
```

- [ ] **Step 2: Run `npx convex dev` for the first time**

Run: `npx convex dev`

Expected on first run: a browser opens for Convex auth → CLI asks "Use existing deployment?" → pick `helpful-grasshopper-46` (the dev deployment) → CLI syncs `convex/schema.ts`, generates `convex/_generated/`, and watches for changes.

Leave this running in its own terminal window for the rest of the plan — it auto-deploys every save.

- [ ] **Step 3: Verify schema landed in the Convex dashboard**

Open `https://dashboard.convex.dev/d/helpful-grasshopper-46/data`. Confirm `telegram_log` table exists (empty). If you don't see it, check the terminal running `npx convex dev` for type errors.

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts convex.json
git commit -m "feat(telegram-poc): bootstrap convex schema with telegram_log table"
```

Note: `convex/_generated/` is typically gitignored — those files are deterministic from `schema.ts`.

---

## Task 2: Install + configure Vitest + convex-test

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install dev dependencies**

Run:
```bash
npm install -D vitest@^2 convex-test @edge-runtime/vm
```

Expected: three packages added under `devDependencies` in `package.json`. The `@edge-runtime/vm` package gives Vitest a V8-isolate-like environment that matches Convex's runtime semantics (needed because convex-test simulates the Convex runtime).

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

// convex-test runs your functions in a simulated Convex runtime; the
// edge-runtime environment is the closest match to Convex's actual V8
// isolates. Don't switch to jsdom or node — convex-test docs require this.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // Convex generates code into convex/_generated/ — include it so tests can
    // import { api, internal }.
    include: ["convex/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 3: Add test scripts to `package.json`**

Modify `package.json` — in the `"scripts"` block, alongside `dev`, `build`, etc., add:

```json
    "test": "vitest",
    "test:run": "vitest run",
```

The result should look like (showing the scripts block only):

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview --host",
  "lint": "eslint .",
  "typecheck": "tsc --noEmit",
  "deploy": "vercel --prod",
  "test": "vitest",
  "test:run": "vitest run"
},
```

- [ ] **Step 4: Smoke-test the harness with a trivial test**

Create a temporary file `convex/_smoke.test.ts`:

```ts
import { describe, expect, test } from "vitest";

describe("vitest smoke test", () => {
  test("the harness is wired", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm run test:run`

Expected output includes:
```
 ✓ convex/_smoke.test.ts (1 test)
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

If you see "Could not resolve @edge-runtime/vm" or "environment not found", re-check the install in Step 1 and the `environment: "edge-runtime"` line in Step 2.

- [ ] **Step 5: Delete the smoke file and commit infra**

```bash
rm convex/_smoke.test.ts
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(telegram-poc): add vitest + convex-test infrastructure"
```

---

## Task 3: HTML escape helper + template renderers (TDD)

**Files:**
- Create: `convex/lib/telegramHtml.ts`
- Create: `convex/lib/telegramHtml.test.ts`

- [ ] **Step 1: Write failing tests in `convex/lib/telegramHtml.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  formatIdr,
  renderApproval,
  renderShiftSummary,
  renderCustom,
  makeNonce,
} from "./telegramHtml";

describe("escapeHtml", () => {
  test("escapes ampersand first to avoid double-encoding", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  test("escapes less-than and greater-than", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("leaves other characters alone (single quotes, double quotes, slashes, unicode)", () => {
    expect(escapeHtml("It's \"fine\" — Citra/Bayu — ✅")).toBe(
      "It's \"fine\" — Citra/Bayu — ✅",
    );
  });

  test("escapes combined edge case", () => {
    expect(escapeHtml("<a href=\"x\">&copy;</a>")).toBe(
      "&lt;a href=\"x\"&gt;&amp;copy;&lt;/a&gt;",
    );
  });
});

describe("formatIdr", () => {
  test("formats integers with id-ID thousands separator (dots)", () => {
    expect(formatIdr(50000)).toBe("50.000");
    expect(formatIdr(4275000)).toBe("4.275.000");
  });

  test("rounds non-integers", () => {
    expect(formatIdr(49999.7)).toBe("50.000");
  });
});

describe("renderApproval", () => {
  test("includes escaped reason and Approve/Deny buttons with shared nonce", () => {
    const result = renderApproval(
      { action_type: "refund", amount_idr: 50000, reason: "<bad> & evil" },
      "deadbeef",
    );
    expect(result.text).toContain("Refund approval");
    expect(result.text).toContain("Rp 50.000");
    expect(result.text).toContain("&lt;bad&gt; &amp; evil");
    expect(result.inline_keyboard).toEqual([
      [
        { text: "Approve ✅", callback_data: "approve:deadbeef" },
        { text: "Deny ❌", callback_data: "deny:deadbeef" },
      ],
    ]);
  });

  test("uses correct action label for manual_pay and neg_stock", () => {
    expect(
      renderApproval({ action_type: "manual_pay", amount_idr: 1, reason: "x" }, "n").text,
    ).toContain("Manual payment override");
    expect(
      renderApproval({ action_type: "neg_stock", amount_idr: 1, reason: "x" }, "n").text,
    ).toContain("Negative stock acknowledgment");
  });
});

describe("renderShiftSummary", () => {
  test("produces formatted text and NO inline_keyboard (one-way)", () => {
    const result = renderShiftSummary({
      staff_name: "Citra",
      sales_idr: 4275000,
      txn_count: 42,
      hours: 8,
    });
    expect(result.text).toContain("Citra · shift closed");
    expect(result.text).toContain("Rp 4.275.000");
    expect(result.text).toContain("42");
    expect(result.text).toContain("8.0");
    expect(result.inline_keyboard).toBeUndefined();
  });

  test("escapes the staff name", () => {
    const result = renderShiftSummary({
      staff_name: "<bobby>",
      sales_idr: 1,
      txn_count: 1,
      hours: 1,
    });
    expect(result.text).toContain("&lt;bobby&gt;");
    expect(result.text).not.toContain("<bobby>");
  });
});

describe("renderCustom", () => {
  test("escapes text and omits buttons when include_buttons is false", () => {
    const result = renderCustom({ text: "<x>", include_buttons: false }, "n");
    expect(result.text).toBe("&lt;x&gt;");
    expect(result.inline_keyboard).toBeUndefined();
  });

  test("attaches test buttons when include_buttons is true", () => {
    const result = renderCustom({ text: "hi", include_buttons: true }, "abc");
    expect(result.inline_keyboard).toEqual([
      [
        { text: "Test A", callback_data: "test_a:abc" },
        { text: "Test B", callback_data: "test_b:abc" },
      ],
    ]);
  });
});

describe("makeNonce", () => {
  test("produces 8-character lowercase hex", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  test("is non-deterministic across calls", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm run test:run`
Expected: All tests FAIL with errors like "Cannot find module './telegramHtml'" or "escapeHtml is not a function".

- [ ] **Step 3: Implement `convex/lib/telegramHtml.ts`**

```ts
// Pure functions used by convex/telegram/send.ts to render Telegram messages.
// All user-supplied fields must pass through escapeHtml() because we use
// parse_mode: "HTML" — unescaped <, >, & will either crash the API parser
// (HTTP 400) or render as broken markup.

export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type RenderedMessage = {
  text: string;
  inline_keyboard?: InlineKeyboardButton[][];
};

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>]/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

// Indonesian Rupiah formatter — integer only, dot thousands separator.
// Matches src/lib/format.ts convention (see ADR-015).
export function formatIdr(amount: number): string {
  return new Intl.NumberFormat("id-ID").format(Math.round(amount));
}

export type ApprovalPayload = {
  action_type: "refund" | "manual_pay" | "neg_stock";
  amount_idr: number;
  reason: string;
};

const ACTION_LABELS: Record<ApprovalPayload["action_type"], string> = {
  refund: "Refund",
  manual_pay: "Manual payment override",
  neg_stock: "Negative stock acknowledgment",
};

export function renderApproval(payload: ApprovalPayload, nonce: string): RenderedMessage {
  const text =
    `<b>${escapeHtml(ACTION_LABELS[payload.action_type])} approval</b>\n` +
    `<b>Amount:</b> Rp ${formatIdr(payload.amount_idr)}\n` +
    `<b>Reason:</b> <i>${escapeHtml(payload.reason)}</i>\n\n` +
    `Tap a button below.`;

  return {
    text,
    inline_keyboard: [
      [
        { text: "Approve ✅", callback_data: `approve:${nonce}` },
        { text: "Deny ❌", callback_data: `deny:${nonce}` },
      ],
    ],
  };
}

export type ShiftSummaryPayload = {
  staff_name: string;
  sales_idr: number;
  txn_count: number;
  hours: number;
};

export function renderShiftSummary(payload: ShiftSummaryPayload): RenderedMessage {
  const text =
    `<b>${escapeHtml(payload.staff_name)} · shift closed</b>\n` +
    `<b>Sales:</b> Rp ${formatIdr(payload.sales_idr)}\n` +
    `<b>Txns:</b> ${payload.txn_count}\n` +
    `<b>Hours:</b> ${payload.hours.toFixed(1)}`;

  return { text };
}

export type CustomPayload = {
  text: string;
  include_buttons: boolean;
};

export function renderCustom(payload: CustomPayload, nonce: string): RenderedMessage {
  const message: RenderedMessage = {
    text: escapeHtml(payload.text),
  };
  if (payload.include_buttons) {
    message.inline_keyboard = [
      [
        { text: "Test A", callback_data: `test_a:${nonce}` },
        { text: "Test B", callback_data: `test_b:${nonce}` },
      ],
    ];
  }
  return message;
}

// Crypto-random hex nonce. 8 chars = 4 bytes = ~4 billion values — plenty for POC.
// callback_data is limited to 64 bytes by Telegram so we keep the prefix short.
export function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npm run test:run`
Expected: All tests in `convex/lib/telegramHtml.test.ts` PASS (~20 assertions across 13 tests). Zero failures.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/telegramHtml.ts convex/lib/telegramHtml.test.ts
git commit -m "feat(telegram-poc): html escape helper + template renderers with vitest coverage"
```

---

## Task 4: `sendTemplate` action

**Files:**
- Create: `convex/telegram/send.ts`

No automated tests for this task — the action makes external HTTP calls to `api.telegram.org`. Mocking `fetch` adds complexity without much value for a POC; we verify via real round-trip in Task 5 step 3 + Task 9.

- [ ] **Step 1: Create `convex/telegram/send.ts`**

```ts
import { v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  renderApproval,
  renderShiftSummary,
  renderCustom,
  makeNonce,
  type RenderedMessage,
} from "../lib/telegramHtml";

// Convex actions run in a Node-like runtime and can make external HTTP calls
// via the standard fetch API. Mutations cannot — that's why this is an action.

export const sendTemplate = action({
  args: {
    kind: v.union(
      v.literal("approval"),
      v.literal("shift_summary"),
      v.literal("custom"),
    ),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      throw new Error(
        "Telegram env vars missing. Run `npx convex env set TELEGRAM_BOT_TOKEN ...` and `... TELEGRAM_CHAT_ID -- ...`.",
      );
    }

    let rendered: RenderedMessage;
    const nonce = makeNonce();
    switch (args.kind) {
      case "approval":
        rendered = renderApproval(args.payload, nonce);
        break;
      case "shift_summary":
        rendered = renderShiftSummary(args.payload);
        break;
      case "custom":
        rendered = renderCustom(args.payload, nonce);
        break;
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: rendered.text,
      parse_mode: "HTML",
    };
    if (rendered.inline_keyboard) {
      body.reply_markup = { inline_keyboard: rendered.inline_keyboard };
    }

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const responseJson = await response.json();

    // Capture message_id so a later editMessageText (from the webhook) can target it.
    const messageId: number | undefined = responseJson?.result?.message_id;

    await ctx.runMutation(internal.telegram.send.logOutbound, {
      template_kind: args.kind,
      payload_json: JSON.stringify({ request: body, response: responseJson }),
      message_id: messageId,
    });

    if (!response.ok || !responseJson?.ok) {
      throw new Error(
        `Telegram sendMessage failed: ${response.status} ${JSON.stringify(responseJson)}`,
      );
    }

    return { message_id: messageId, ok: true };
  },
});

export const logOutbound = internalMutation({
  args: {
    template_kind: v.string(),
    payload_json: v.string(),
    message_id: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("telegram_log", {
      direction: "out",
      template_kind: args.template_kind,
      payload_json: args.payload_json,
      message_id: args.message_id,
      created_at: Date.now(),
    });
  },
});
```

- [ ] **Step 2: Verify action is registered + invokable**

The `npx convex dev` watcher should pick up the new file and report "Convex functions ready!" with no errors.

Now invoke it from the CLI to send a real Telegram message:

```bash
npx convex run telegram:send:sendTemplate '{"kind":"custom","payload":{"text":"hello from convex","include_buttons":false}}'
```

Expected:
- CLI returns `{ "message_id": <number>, "ok": true }` within ~1s
- A plain text message "hello from convex" appears in your dev Telegram group
- A row appears in the `telegram_log` table in the Convex dashboard with `direction: "out"`, `template_kind: "custom"`

If the message doesn't arrive: re-check the three Convex env vars via `npx convex env list`.

- [ ] **Step 3: Commit**

```bash
git add convex/telegram/send.ts
git commit -m "feat(telegram-poc): sendTemplate action + logOutbound mutation"
```

---

## Task 5: Webhook httpAction + HTTP router (TDD)

**Files:**
- Create: `convex/telegram/webhook.ts`
- Create: `convex/telegram/webhook.test.ts`
- Create: `convex/http.ts`

- [ ] **Step 1: Write failing tests in `convex/telegram/webhook.test.ts`**

```ts
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

// We don't want the test suite to fire real HTTP calls to api.telegram.org for
// answerCallbackQuery / editMessageText. Stub global fetch to return success.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    ),
  );
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "-1");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
});

describe("telegram webhook security", () => {
  test("returns 401 when secret header is missing", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("returns 401 when secret header is wrong", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "WRONG",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("returns 400 on malformed JSON", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("telegram webhook callback handling", () => {
  test("inserts an inbound log row on valid callback_query", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 42,
        callback_query: {
          id: "cbq-1",
          from: { id: 99, username: "tester" },
          message: { message_id: 7, chat: { id: -1 } },
          data: "approve:abc123",
        },
      }),
    });
    expect(response.status).toBe(200);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("telegram_log").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "in",
      update_id: 42,
      callback_data: "approve:abc123",
      from_user: "@tester",
      message_id: 7,
    });
  });

  test("dedupes a duplicate update_id (Telegram retry)", async () => {
    const t = convexTest(schema);
    const headers = {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-secret",
    };
    const body = JSON.stringify({
      update_id: 100,
      callback_query: {
        id: "cbq-2",
        from: { id: 99, username: "tester" },
        message: { message_id: 8, chat: { id: -1 } },
        data: "deny:xyz",
      },
    });

    const r1 = await t.fetch("/telegram-webhook", { method: "POST", headers, body });
    const r2 = await t.fetch("/telegram-webhook", { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("telegram_log")
        .withIndex("by_update_id", (q) => q.eq("update_id", 100))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("uses first_name fallback when username is absent", async () => {
    const t = convexTest(schema);
    await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 200,
        callback_query: {
          id: "cbq-3",
          from: { id: 99, first_name: "Sari" },
          message: { message_id: 9, chat: { id: -1 } },
          data: "approve:nn",
        },
      }),
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("telegram_log")
        .withIndex("by_update_id", (q) => q.eq("update_id", 200))
        .collect(),
    );
    expect(rows[0].from_user).toBe("Sari");
  });
});

describe("recordCallback mutation direct (mutation-level dedupe)", () => {
  test("the second call with the same update_id is a no-op", async () => {
    const t = convexTest(schema);
    const args = {
      update_id: 555,
      callback_data: "approve:x",
      from_user: "@x",
      message_id: 1,
      payload_json: "{}",
    };
    await t.mutation(internal.telegram.webhook.recordCallback, args);
    await t.mutation(internal.telegram.webhook.recordCallback, args);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("telegram_log")
        .withIndex("by_update_id", (q) => q.eq("update_id", 555))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm run test:run`
Expected: All tests in `convex/telegram/webhook.test.ts` FAIL — most with "Cannot find module './webhook'" or "Function 'telegram/webhook' not found." This is fine; we haven't written it yet.

- [ ] **Step 3: Create `convex/telegram/webhook.ts`**

```ts
import { httpAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

// Telegram-delivered callback shape we care about.
// Full schema: https://core.telegram.org/bots/api#update
type TelegramCallbackQuery = {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
};

export const telegramWebhook = httpAction(async (ctx, request) => {
  // 1. Verify the secret token — Telegram echoes whatever we passed to setWebhook
  //    back in this header on every delivery. Reject anything else as spoofed.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Parse body. If we can't parse it, 400 — telegram won't retry on 4xx.
  let update: TelegramCallbackQuery;
  try {
    update = (await request.json()) as TelegramCallbackQuery;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // 3. Only handle callback_query updates in the POC. allowed_updates filter
  //    on setWebhook should prevent anything else from arriving, but be defensive.
  const cq = update.callback_query;
  if (!cq) {
    return new Response("ignored", { status: 200 });
  }

  // 4. Dedupe by update_id. Telegram retries on non-200 responses for up to
  //    24h; without dedupe, a single press could create many log rows.
  await ctx.runMutation(internal.telegram.webhook.recordCallback, {
    update_id: update.update_id,
    callback_data: cq.data,
    from_user: cq.from.username ? `@${cq.from.username}` : cq.from.first_name ?? "unknown",
    message_id: cq.message?.message_id,
    payload_json: JSON.stringify(update),
  });

  // 5. Always acknowledge the callback so Telegram stops the spinner on the
  //    user's button. Failure to call answerCallbackQuery leaves the spinner
  //    running indefinitely (visible UX bug).
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cq.id }),
  });

  // 6. Edit the original message to reflect the action. Strip the buttons by
  //    sending an empty inline_keyboard.
  if (cq.message && cq.data) {
    const isApprove = cq.data.startsWith("approve:");
    const isDeny = cq.data.startsWith("deny:");
    const verb = isApprove ? "✅ Approved" : isDeny ? "❌ Denied" : "👉 Selected";
    const userLabel = cq.from.username ? `@${cq.from.username}` : cq.from.first_name ?? "unknown";

    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `${verb} by ${userLabel}`,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  }

  return new Response("ok", { status: 200 });
});

export const recordCallback = internalMutation({
  args: {
    update_id: v.number(),
    callback_data: v.optional(v.string()),
    from_user: v.string(),
    message_id: v.optional(v.number()),
    payload_json: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotency: if we've seen this update_id before, do nothing.
    const existing = await ctx.db
      .query("telegram_log")
      .withIndex("by_update_id", (q) => q.eq("update_id", args.update_id))
      .first();
    if (existing) return;

    await ctx.db.insert("telegram_log", {
      direction: "in",
      payload_json: args.payload_json,
      update_id: args.update_id,
      callback_data: args.callback_data,
      from_user: args.from_user,
      message_id: args.message_id,
      created_at: Date.now(),
    });
  },
});
```

- [ ] **Step 4: Create `convex/http.ts`**

```ts
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
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npm run test:run`
Expected: All tests across `convex/lib/telegramHtml.test.ts` and `convex/telegram/webhook.test.ts` PASS. ~20 tests total. Zero failures.

If you get "Function telegram/webhook:telegramWebhook not found": the `npx convex dev` watcher must regenerate `_generated/api.d.ts` before the test imports resolve. Save the schema file once to trigger a regen, then re-run tests.

- [ ] **Step 6: Verify the live route is registered (sanity check, not a test)**

In the `npx convex dev` terminal, look for a line like:
```
HTTP Actions:
  POST /telegram-webhook
```

The full URL is `https://helpful-grasshopper-46.convex.site/telegram-webhook` — note `.convex.site` (NOT `.convex.cloud`).

- [ ] **Step 7: Commit**

```bash
git add convex/telegram/webhook.ts convex/telegram/webhook.test.ts convex/http.ts
git commit -m "feat(telegram-poc): webhook httpAction + http router with convex-test coverage"
```

---

## Task 6: Register the webhook with Telegram

**Files:**
- None (one-shot CLI call)

- [ ] **Step 1: Call setWebhook**

Replace the token and secret with your actual values, then run in PowerShell:

```powershell
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" `
  -d "url=https://helpful-grasshopper-46.convex.site/telegram-webhook" `
  -d "secret_token=<SECRET>" `
  -d 'allowed_updates=["callback_query"]'
```

Expected response (single line):
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

- [ ] **Step 2: Verify with getWebhookInfo**

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Expected JSON includes:
- `"url": "https://helpful-grasshopper-46.convex.site/telegram-webhook"`
- `"pending_update_count": 0`
- `"allowed_updates": ["callback_query"]`
- (no `"last_error_message"` field, or empty)

- [ ] **Step 3: Round-trip smoke test (full wire)**

Send an approval message that has buttons:

```bash
npx convex run telegram:send:sendTemplate '{"kind":"approval","payload":{"action_type":"refund","amount_idr":50000,"reason":"customer says stale"}}'
```

In Telegram:
- The message appears with two buttons
- Tap "Approve ✅"
- Within ~1s the message text changes to "✅ Approved by @<your_username>" and the buttons disappear

In the Convex dashboard `telegram_log` table:
- One row with `direction: "out"`, `template_kind: "approval"`
- One row with `direction: "in"`, `callback_data: "approve:<nonce>"`, `from_user: "@<your_username>"`

If the buttons are present but tapping them does nothing: check `getWebhookInfo` for `last_error_message` — Telegram tells you exactly what's failing (wrong URL, TLS issue, 401, etc.).

- [ ] **Step 4: No commit (this task changes external Telegram state, not files)**

---

## Task 7: Reactive query for the activity feed

**Files:**
- Create: `convex/telegram/queries.ts`

- [ ] **Step 1: Create `convex/telegram/queries.ts`**

```ts
import { query } from "../_generated/server";

export const listRecentLog = query({
  args: {},
  handler: async (ctx) => {
    // by_created_at returns oldest-first; we want newest-first, capped at 30.
    return await ctx.db
      .query("telegram_log")
      .withIndex("by_created_at")
      .order("desc")
      .take(30);
  },
});
```

- [ ] **Step 2: Verify the query**

```bash
npx convex run telegram:queries:listRecentLog
```

Expected: an array of the log rows you've created so far (from Tasks 4 and 6), newest first.

- [ ] **Step 3: Commit**

```bash
git add convex/telegram/queries.ts
git commit -m "feat(telegram-poc): listRecentLog query for activity feed"
```

---

## Task 8: Playground UI route

**Files:**
- Create: `src/routes/dev/telegram.tsx`

- [ ] **Step 1: Create `src/routes/dev/telegram.tsx`**

```tsx
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import * as Tabs from "@radix-ui/react-tabs";
import { api } from "../../../convex/_generated/api";

// Three template tabs that mirror the spec's
// docs/superpowers/specs/2026-05-25-telegram-poc-design.md
// Approval | Shift summary | Custom.

export default function TelegramPocPage() {
  const send = useAction(api.telegram.send.sendTemplate);
  const log = useQuery(api.telegram.queries.listRecentLog) ?? [];

  return (
    <div className="mx-auto max-w-2xl p-4 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Telegram POC playground</h1>
        <p className="text-sm text-muted-foreground">
          Sends to the dev Telegram group via the bot. Activity feed updates live.
        </p>
      </header>

      <Tabs.Root defaultValue="approval" className="border rounded-lg p-3">
        <Tabs.List className="flex gap-2 border-b mb-3 pb-2">
          <Tabs.Trigger
            value="approval"
            className="px-3 py-1 rounded data-[state=active]:bg-stone-200 data-[state=active]:font-medium"
          >
            Approval
          </Tabs.Trigger>
          <Tabs.Trigger
            value="shift_summary"
            className="px-3 py-1 rounded data-[state=active]:bg-stone-200 data-[state=active]:font-medium"
          >
            Shift summary
          </Tabs.Trigger>
          <Tabs.Trigger
            value="custom"
            className="px-3 py-1 rounded data-[state=active]:bg-stone-200 data-[state=active]:font-medium"
          >
            Custom
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="approval">
          <ApprovalForm send={send} />
        </Tabs.Content>
        <Tabs.Content value="shift_summary">
          <ShiftSummaryForm send={send} />
        </Tabs.Content>
        <Tabs.Content value="custom">
          <CustomForm send={send} />
        </Tabs.Content>
      </Tabs.Root>

      <section className="border rounded-lg p-3">
        <h2 className="text-sm font-medium mb-2">Activity ({log.length})</h2>
        <ul className="space-y-1.5 text-xs font-mono">
          {log.map((row) => (
            <li
              key={row._id}
              className={`p-2 rounded border ${
                row.direction === "in"
                  ? "border-purple-300 bg-purple-50"
                  : "border-emerald-300 bg-emerald-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    row.direction === "in"
                      ? "bg-purple-200 text-purple-900"
                      : "bg-emerald-200 text-emerald-900"
                  }`}
                >
                  {row.direction.toUpperCase()}
                </span>
                <span>{new Date(row.created_at).toLocaleTimeString()}</span>
                {row.template_kind && <span>· {row.template_kind}</span>}
                {row.from_user && <span>· {row.from_user}</span>}
              </div>
              {row.callback_data && (
                <div className="mt-1 text-purple-900">{row.callback_data}</div>
              )}
              <div className="mt-1 text-stone-600 truncate">{row.payload_json.slice(0, 120)}</div>
            </li>
          ))}
          {log.length === 0 && (
            <li className="text-stone-500 italic">No activity yet — hit Send above.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

type SendFn = ReturnType<typeof useAction<typeof api.telegram.send.sendTemplate>>;

function ApprovalForm({ send }: { send: SendFn }) {
  const [actionType, setActionType] = useState<"refund" | "manual_pay" | "neg_stock">("refund");
  const [amount, setAmount] = useState("50000");
  const [reason, setReason] = useState("customer says cookie was stale");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await send({
            kind: "approval",
            payload: {
              action_type: actionType,
              amount_idr: Number(amount),
              reason,
            },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        Action type
        <select
          className="block w-full mt-1 border rounded px-2 py-1"
          value={actionType}
          onChange={(e) => setActionType(e.target.value as typeof actionType)}
        >
          <option value="refund">Refund</option>
          <option value="manual_pay">Manual payment override</option>
          <option value="neg_stock">Negative stock</option>
        </select>
      </label>
      <label className="block text-sm">
        Amount (IDR)
        <input
          type="number"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Reason
        <textarea
          className="block w-full mt-1 border rounded px-2 py-1"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send approval request"}
      </button>
    </form>
  );
}

function ShiftSummaryForm({ send }: { send: SendFn }) {
  const [staffName, setStaffName] = useState("Citra");
  const [sales, setSales] = useState("4275000");
  const [txns, setTxns] = useState("42");
  const [hours, setHours] = useState("8");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await send({
            kind: "shift_summary",
            payload: {
              staff_name: staffName,
              sales_idr: Number(sales),
              txn_count: Number(txns),
              hours: Number(hours),
            },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        Staff name
        <input
          className="block w-full mt-1 border rounded px-2 py-1"
          value={staffName}
          onChange={(e) => setStaffName(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Sales (IDR)
        <input
          type="number"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={sales}
          onChange={(e) => setSales(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Txn count
        <input
          type="number"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={txns}
          onChange={(e) => setTxns(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Hours
        <input
          type="number"
          step="0.5"
          className="block w-full mt-1 border rounded px-2 py-1 font-mono"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send shift summary"}
      </button>
    </form>
  );
}

function CustomForm({ send }: { send: SendFn }) {
  const [text, setText] = useState("hello from the playground");
  const [includeButtons, setIncludeButtons] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await send({
            kind: "custom",
            payload: { text, include_buttons: includeButtons },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block text-sm">
        Message
        <textarea
          className="block w-full mt-1 border rounded px-2 py-1"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeButtons}
          onChange={(e) => setIncludeButtons(e.target.checked)}
        />
        Include Test A / Test B buttons
      </label>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send custom message"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS with no errors. If `api.telegram.send.sendTemplate` is flagged as missing, it means `npx convex dev` hasn't re-generated `_generated/api.d.ts` yet — wait a few seconds for the watcher.

- [ ] **Step 3: Commit**

```bash
git add src/routes/dev/telegram.tsx
git commit -m "feat(telegram-poc): playground UI with 3 tabs and live activity feed"
```

---

## Task 9: Wire the route + verify in browser

**Files:**
- Modify: `src/router.tsx` (insert 2 lines)

- [ ] **Step 1: Add lazy import and route entry**

Modify `src/router.tsx`. First, add this lazy import alongside the other lazy imports (after the `Receipt` line, currently line 59):

```tsx
const DevTelegram = lazy(() => import("@/routes/dev/telegram"));
```

Then, inside the RootLayout `children` array (right after the `mgr/receipt` entry, currently around line 89), insert:

```tsx
      { path: "dev/telegram", element: <DevTelegram /> },
```

- [ ] **Step 2: Run the dev server**

Run: `npm run dev`
Expected: Vite starts on http://localhost:5173/.

- [ ] **Step 3: Open the page in the browser**

Navigate to: `http://localhost:5173/dev/telegram`

Expected:
- Page renders with header "Telegram POC playground" and three tabs (Approval / Shift summary / Custom).
- Activity feed below shows the OUT + IN rows from earlier tasks.

- [ ] **Step 4: Commit**

```bash
git add src/router.tsx
git commit -m "feat(telegram-poc): mount /dev/telegram playground route"
```

---

## Task 10: End-to-end verification against spec acceptance criteria

**Files:** None (manual verification + final commit)

Walk through each of the 8 acceptance criteria from the spec. For each, record PASS/FAIL.

- [ ] **Criterion 1: Approval round-trip — message + buttons appear in ~1s**

In the browser at `/dev/telegram`, on the Approval tab, change reason to `"e2e test 1"` and hit Send approval request. The message + 2 buttons should appear in your dev Telegram group within ~1s.

- [ ] **Criterion 2: Button press edits message**

In Telegram, tap "Approve ✅". The message text changes to "✅ Approved by @<your_username>" and the buttons disappear, within ~1s.

- [ ] **Criterion 3: Live UI feed updates without refresh**

Without refreshing the browser, the Activity feed shows the new OUT row immediately on send, then a new IN row appears the instant you tap the button. Both visible without manual reload.

- [ ] **Criterion 4: Shift summary renders without buttons**

Switch to the Shift summary tab, fill out the defaults, hit Send. The message arrives in Telegram as a formatted multi-line block (bold labels, etc.) with NO buttons attached. Activity feed shows a new OUT row, no IN follows.

- [ ] **Criterion 5: Custom with/without buttons**

Switch to the Custom tab. Send first WITHOUT the checkbox → plain text only. Then send WITH the checkbox → text + two test buttons. Buttons can be tapped; they produce IN rows but no edit (because the `data` doesn't start with `approve:` or `deny:`, the verb falls through to "👉 Selected by …").

- [ ] **Criterion 6: Forged webhook returns 401 (covered by automated test + live re-verify)**

Already verified by Vitest tests in Task 5. Re-run the live check just in case nothing has regressed in deployment:

```bash
curl -i -X POST "https://helpful-grasshopper-46.convex.site/telegram-webhook" -H "Content-Type: application/json" -d "{}"
```
Expected: HTTP/2 401, body `unauthorized`. No row written to `telegram_log`.

- [ ] **Criterion 7: Idempotency on duplicate update_id (covered by automated test)**

Already verified by the Vitest `dedupes a duplicate update_id` test in Task 5. No further action needed unless you want a live confirmation by invoking the internal mutation twice via the dashboard.

- [ ] **Criterion 8: HTML escape (covered by automated test + live re-verify)**

Already verified by the Vitest `escapeHtml` tests in Task 3. For a live confirmation: switch to the Custom tab, set message to `<script>alert("xss")</script> & co.`, send WITHOUT buttons. The message in Telegram should arrive as **literal text** showing `<script>...` and `& co.` — not as broken HTML or stripped content. If you instead see "Bad Request: can't parse entities" in the OUT row's payload_json, there's a regression.

- [ ] **Run the full test suite**

```bash
npm run test:run
```

Expected: All tests PASS. ~20+ assertions across `telegramHtml.test.ts` and `webhook.test.ts`. Zero failures, zero skipped.

- [ ] **Final step: Add CHANGELOG entry + commit**

Modify `docs/CHANGELOG.md` to add a new entry under an "Unreleased" section (create it if it doesn't exist):

```markdown
## Unreleased

- POC: Telegram bot integration playground at `/dev/telegram`. Sends approval / shift summary / custom messages via Convex action `telegram:send:sendTemplate`; receives button-press callbacks via `httpAction` at `/telegram-webhook`. Sandbox table `telegram_log`. Vitest + convex-test coverage for HTML escape, template renderers, and webhook (security + dedupe). Spec: `docs/superpowers/specs/2026-05-25-telegram-poc-design.md`. Does NOT replace ADR-027 / ADR-033 yet.
```

Then commit:

```bash
git add docs/CHANGELOG.md
git commit -m "docs(telegram-poc): changelog entry for v0.2.1 POC playground"
```

---

## Definition of done

- All 10 task checkboxes ticked
- All 8 acceptance criteria PASS in the walk (live or via automated test)
- `npm run test:run` passes (all tests green, zero failures)
- `npm run typecheck` passes
- `npm run lint` passes (no new errors)
- `git status` is clean
- The route `http://localhost:5173/dev/telegram` works end-to-end
- The Telegram bot in your dev group has working buttons that edit the original message
- Webhook returns 401 on forged requests (both in Vitest and live)
