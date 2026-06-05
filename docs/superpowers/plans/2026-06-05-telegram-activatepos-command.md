# `/activatepos` Telegram Device-Activation Command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an off-booth manager mint a 6-digit device setup code by sending `/activatepos` in the managers Telegram chat; the bot replies with the code so a new phone/browser can be activated on the fly.

**Architecture:** A new Telegram command, gated to the chat bound to the `managers` role, schedules an `internalAction` that issues a code through a shared single-writer helper (`issueDeviceSetupCode`) also used by the existing booth path. Issuer attribution is recorded via an `issued_via` discriminant; `issued_by`/`activated_by` become optional, and the audit log uses the existing `"system"` actor sentinel for Telegram-sourced rows.

**Tech Stack:** Convex (internalAction / internalMutation / plain helper fns, `convex-test` + vitest), TypeScript, Telegram Bot API (`sendTelegramHtml`).

**Spec:** `docs/superpowers/specs/2026-06-05-telegram-activatepos-command-design.md`
**Staffreview (spec):** `docs/reviews/staffreview-activatepos-spec-2026-06-05.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `convex/auth/schema.ts` | `pending_device_setups` + `registered_devices` shape | Modify — optional `issued_by`/`activated_by`, add `issued_via` + `issued_by_telegram` |
| `convex/staff/internal.ts` | Device-setup write logic (domain owner) | Modify — add `issueDeviceSetupCode` plain fn + constants + `_issueDeviceSetupCodeFromTelegram_internal` wrapper |
| `convex/staff/public.ts` | Booth-session code issuance + `activateDevice` | Modify — `generateDeviceSetupCode` delegates to shared fn; `activateDevice` tolerates absent `issued_by` |
| `convex/telegram/activatePos.ts` | `/activatepos` command factory + chat-gated action + reply | Create |
| `convex/http.ts` | Webhook command registry | Modify — register `buildActivatePosCommand` |
| `convex/telegram/__tests__/activatePos.test.ts` | Command tests | Create |
| `docs/SCHEMA.md`, `docs/API_REFERENCE.md`, `docs/RUNBOOK-telegram.md`, `CLAUDE.md`, `docs/CHANGELOG.md` | Docs | Modify |

**Naming used consistently across tasks** (self-review checked):
- Plain fn: `issueDeviceSetupCode(ctx, opts)`
- Telegram mutation wrapper: `_issueDeviceSetupCodeFromTelegram_internal`
- Action: `handleActivatePos`; factory: `buildActivatePosCommand`
- Command name (no slash): `activatepos`
- New schema fields: `issued_via`, `issued_by_telegram: { from_id?, chat_title }`

---

## Task 1: Schema — optional issuer fields + Telegram discriminant

**Files:**
- Modify: `convex/auth/schema.ts:54-61` (`pending_device_setups`), `:43-52` (`registered_devices`)
- Test: `convex/auth/__tests__/deviceSetupSchema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `convex/auth/__tests__/deviceSetupSchema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";

describe("pending_device_setups schema — issuance paths", () => {
  it("accepts a Telegram-issued row with no issued_by and an optional from_id", async () => {
    const t = convexTest(schema);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("pending_device_setups", {
        setup_code: "123456",
        issued_via: "telegram",
        issued_by_telegram: { chat_title: "Frollie · Managers" }, // from_id absent (anonymous admin)
        expires_at: Date.now() + 3_600_000,
        consumed_at: null,
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.issued_via).toBe("telegram");
    expect(row?.issued_by).toBeUndefined();
    expect(row?.issued_by_telegram?.from_id).toBeUndefined();
    expect(row?.issued_by_telegram?.chat_title).toBe("Frollie · Managers");
  });

  it("still accepts a legacy booth-issued row with issued_by set and no issued_via", async () => {
    const t = convexTest(schema);
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "M", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      }),
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("pending_device_setups", {
        setup_code: "654321",
        issued_by: staffId,
        expires_at: Date.now() + 3_600_000,
        consumed_at: null,
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.issued_by).toBe(staffId);
    expect(row?.issued_via).toBeUndefined();
  });

  it("accepts a registered_devices row with no activated_by", async () => {
    const t = convexTest(schema);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("registered_devices", {
        device_id: "dev-x", label: "Counter", activated_at: Date.now(), active: true,
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.activated_by).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/auth/__tests__/deviceSetupSchema.test.ts`
Expected: FAIL — schema validation rejects the inserts (`issued_via` unknown field, `issued_by`/`activated_by` required).

- [ ] **Step 3: Edit the schema**

In `convex/auth/schema.ts`, change `registered_devices.activated_by` and the whole `pending_device_setups` table:

```typescript
  registered_devices: defineTable({
    device_id: v.string(),
    label: v.string(),
    activated_by: v.optional(v.id("staff")), // optional v0.6: Telegram-issued codes have no staff issuer
    activated_at: v.number(),
    last_seen_at: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_device_id", ["device_id"])
    .index("by_active", ["active"]),

  pending_device_setups: defineTable({
    setup_code: v.string(),
    issued_by: v.optional(v.id("staff")), // optional v0.6: absent for Telegram-issued codes
    issued_via: v.optional(
      v.union(v.literal("booth_inline"), v.literal("telegram")),
    ), // absent = booth (legacy rows)
    issued_by_telegram: v.optional(
      v.object({
        from_id: v.optional(v.number()), // optional: Telegram omits `from` for anonymous admins / channel posts
        chat_title: v.string(),
      }),
    ),
    expires_at: v.number(),
    consumed_at: v.union(v.number(), v.null()),
  })
    .index("by_code", ["setup_code"])
    .index("by_expires", ["expires_at"]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/auth/__tests__/deviceSetupSchema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (Existing code that reads `issued_by`/`activated_by` may now see `T | undefined` — Tasks 2-3 fix the consumers; if typecheck flags `activateDevice` here, that's expected and resolved in Task 3. If it blocks, proceed to Task 3 before committing.)

- [ ] **Step 6: Commit**

```bash
git add convex/auth/schema.ts convex/auth/__tests__/deviceSetupSchema.test.ts
git commit -m "feat(schema): optional device-setup issuer + issued_via discriminant"
```

---

## Task 2: Shared `issueDeviceSetupCode` helper + booth refactor

Extract the code-gen/collision/insert/audit logic into a single writer in `staff/internal.ts`; point the booth mutation at it.

**Files:**
- Modify: `convex/staff/internal.ts` (add imports, constants, helper)
- Modify: `convex/staff/public.ts:9-17` (remove moved constants/generator), `:113-157` (refactor `generateDeviceSetupCode`)
- Test: `convex/staff/__tests__/staff.test.ts` (existing `generateDeviceSetupCode` test must still pass) + new helper assertions

- [ ] **Step 1: Write the failing test**

Append to `convex/staff/__tests__/staff.test.ts` (inside the existing `describe("device registration", ...)` block, or a new `describe`):

```typescript
import { internal } from "../../_generated/api";

describe("issueDeviceSetupCode shared helper (via Telegram wrapper)", () => {
  it("issues a telegram-attributed code with issued_via + audit source telegram_approval", async () => {
    const t = convexTest(schema);
    const { code, expiresAt } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers", fromId: 4242 },
    );
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", code))
        .unique(),
    );
    expect(row?.issued_via).toBe("telegram");
    expect(row?.issued_by).toBeUndefined();
    expect(row?.issued_by_telegram).toEqual({ from_id: 4242, chat_title: "Frollie · Managers" });

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "device.setup_code_issued"))
        .collect(),
    );
    const telegramRow = audit.find((a) => a.source === "telegram_approval");
    expect(telegramRow).toBeDefined();
    expect(telegramRow?.actor_id).toBe("system");
    // audit metadata is a JSON string (v0.5.5 lesson)
    expect(JSON.parse(telegramRow!.metadata as string)).toMatchObject({
      issued_via: "telegram",
      telegram_from_id: 4242,
      chat_title: "Frollie · Managers",
    });
  });

  it("issues a code when fromId is undefined (anonymous admin)", async () => {
    const t = convexTest(schema);
    const { code } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers" },
    );
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("pending_device_setups")
        .withIndex("by_code", (q) => q.eq("setup_code", code))
        .unique(),
    );
    expect(row?.issued_by_telegram?.from_id).toBeUndefined();
    expect(row?.issued_by_telegram?.chat_title).toBe("Frollie · Managers");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/staff/__tests__/staff.test.ts -t "shared helper"`
Expected: FAIL — `internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal` does not exist.

- [ ] **Step 3: Add the helper + wrapper to `convex/staff/internal.ts`**

Add imports at top (extend the existing import block):

```typescript
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession } from "../auth/sessions";
```

Add the constants + generator + shared fn + wrapper (anywhere after imports):

```typescript
const SETUP_CODE_TTL_MS = 60 * 60 * 1000; // 1h per strategic-foundations §6
const MAX_CODE_COLLISION_RETRIES = 5;

function generateSecureSetupCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Map to [100_000, 999_999]. Modulo bias negligible at this range.
  return String(100_000 + (buf[0] % 900_000)).padStart(6, "0");
}

/**
 * Single writer for `pending_device_setups`. Plain async fn (NOT an
 * internalMutation) so the booth mutation can call it inside its own
 * transaction — same pattern as `logAudit` (ADR-034). Both issuance paths
 * (booth-session + managers-Telegram) funnel through here so the collision
 * loop and audit shape never drift (v0.5.5 canonical-insert lesson).
 */
export async function issueDeviceSetupCode(
  ctx: MutationCtx,
  opts: {
    issuedVia: "booth_inline" | "telegram";
    issuedBy?: Id<"staff">;
    telegramIssuer?: { fromId?: number; chatTitle: string };
    deviceId?: string;
  },
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now();
  const expiresAt = now + SETUP_CODE_TTL_MS;

  let code: string | null = null;
  for (let i = 0; i < MAX_CODE_COLLISION_RETRIES; i++) {
    const candidate = generateSecureSetupCode();
    const collision = await ctx.db
      .query("pending_device_setups")
      .withIndex("by_code", (q) => q.eq("setup_code", candidate))
      .filter((q) => q.eq(q.field("consumed_at"), null))
      .filter((q) => q.gt(q.field("expires_at"), now))
      .unique();
    if (!collision) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("CODE_COLLISION");

  await ctx.db.insert("pending_device_setups", {
    setup_code: code,
    issued_by: opts.issuedBy,
    issued_via: opts.issuedVia,
    issued_by_telegram: opts.telegramIssuer
      ? { from_id: opts.telegramIssuer.fromId, chat_title: opts.telegramIssuer.chatTitle }
      : undefined,
    expires_at: expiresAt,
    consumed_at: null,
  });

  await logAudit(ctx, {
    actor_id: opts.issuedBy ?? "system",
    action: "device.setup_code_issued",
    entity_type: "device",
    source: opts.issuedVia === "telegram" ? "telegram_approval" : "booth_inline",
    device_id: opts.deviceId,
    metadata:
      opts.issuedVia === "telegram"
        ? {
            issued_via: "telegram",
            telegram_from_id: opts.telegramIssuer?.fromId,
            chat_title: opts.telegramIssuer?.chatTitle,
          }
        : { issued_via: "booth_inline" },
  });

  return { code, expiresAt };
}

/**
 * Telegram path wrapper. The `/activatepos` internalAction calls this via
 * ctx.runMutation (an action cannot touch the db directly). No idempotencyKey:
 * the webhook dedupes by Telegram update_id (`telegram/webhook.ts:recordIfNew`),
 * so dispatch fires at most once per command.
 */
export const _issueDeviceSetupCodeFromTelegram_internal = internalMutation({
  args: {
    chatTitle: v.string(),
    fromId: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    return await issueDeviceSetupCode(ctx, {
      issuedVia: "telegram",
      telegramIssuer: { fromId: args.fromId, chatTitle: args.chatTitle },
    });
  },
});
```

- [ ] **Step 4: Refactor the booth mutation in `convex/staff/public.ts`**

Remove the now-moved constants + generator from the top of `public.ts` (lines 9-17: `SETUP_CODE_TTL_MS`, `MAX_CODE_COLLISION_RETRIES`, `generateSecureSetupCode`). Add an import:

```typescript
import { issueDeviceSetupCode } from "./internal";
```

Replace the body of `generateDeviceSetupCode` (keep the wrapper/args/authCheck):

```typescript
export const generateDeviceSetupCode = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions"> },
    { code: string; expiresAt: number }
  >(
    "staff.generateDeviceSetupCode",
    async (ctx, args) => {
      const { staffId: mgrId, deviceId } = await requireManagerSession(ctx, args.sessionId);
      return await issueDeviceSetupCode(ctx, {
        issuedVia: "booth_inline",
        issuedBy: mgrId,
        deviceId,
      });
    },
    {
      staffIdFromArgs: (_a) => undefined,
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/staff/__tests__/staff.test.ts`
Expected: PASS — both the existing `generateDeviceSetupCode` test (booth path, now via the helper) and the two new helper tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS for `staff/internal.ts` and `staff/public.ts`. (`activateDevice` may still flag — fixed in Task 3.)

- [ ] **Step 7: Commit**

```bash
git add convex/staff/internal.ts convex/staff/public.ts convex/staff/__tests__/staff.test.ts
git commit -m "refactor(staff): single-writer issueDeviceSetupCode; booth path delegates"
```

---

## Task 3: `activateDevice` tolerates absent `issued_by`

**Files:**
- Modify: `convex/staff/public.ts:206-244` (`activateDevice` body: `activated_by` + audit `actor_id` + `activated_via` metadata)
- Test: `convex/staff/__tests__/staff.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `convex/staff/__tests__/staff.test.ts`:

```typescript
describe("activateDevice with a Telegram-issued code", () => {
  it("activates with no activated_by and audits as system + activated_via telegram", async () => {
    const t = convexTest(schema);
    const { code } = await t.mutation(
      internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
      { chatTitle: "Frollie · Managers", fromId: 99 },
    );

    const res = await t.mutation(api.staff.public.activateDevice, {
      idempotencyKey: "act-tg-1",
      code,
      deviceLabel: "New Phone",
      deviceId: "dev-tg-1",
    });
    expect(res.active).toBe(true);

    const device = await t.run(async (ctx) =>
      ctx.db
        .query("registered_devices")
        .withIndex("by_device_id", (q) => q.eq("device_id", "dev-tg-1"))
        .unique(),
    );
    expect(device?.activated_by).toBeUndefined();

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "device.activated"))
        .collect(),
    );
    expect(audit[0]?.actor_id).toBe("system");
    expect(JSON.parse(audit[0]!.metadata as string)).toMatchObject({
      activated_via: "telegram",
      label: "New Phone",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/staff/__tests__/staff.test.ts -t "Telegram-issued code"`
Expected: FAIL — currently `activated_by: pending.issued_by` is `undefined` (schema now allows it) but the audit `actor_id: pending.issued_by` is `undefined`, which `logAudit` rejects (`Id<"staff"> | "system"`), OR `activated_via` metadata is absent.

- [ ] **Step 3: Edit `activateDevice`**

In `convex/staff/public.ts`, derive the issuer once after loading `pending`, and use it in both write sites. Replace the patch/insert `activated_by` assignments and the audit call:

```typescript
      await ctx.db.patch(pending._id, { consumed_at: now });

      // v0.6: codes minted via Telegram have no staff issuer — fall back to the
      // "system" audit actor and carry the issuance channel into metadata.
      // NOTE: `source` stays "booth_inline" — activation is always a physical
      // booth act (code typed into the new device); only ISSUANCE came from
      // Telegram. Don't overload "telegram_approval" (the approval/token flow
      // source, CLAUDE.md rule #10). The channel lives in metadata.activated_via.
      const auditActor = pending.issued_by ?? ("system" as const);
      const activatedVia = pending.issued_via ?? "booth_inline";

      let deviceRowId: Id<"registered_devices">;
      let reactivated = false;

      if (existingRows.length > 0) {
        const sorted = [...existingRows].sort(
          (a, b) => (b.activated_at ?? 0) - (a.activated_at ?? 0),
        );
        const primary = sorted[0];
        deviceRowId = primary._id;
        await ctx.db.patch(primary._id, {
          active: true,
          label: args.deviceLabel,
          activated_by: pending.issued_by, // may be undefined (Telegram-issued)
          activated_at: now,
          last_seen_at: now,
        });
        for (const dup of sorted.slice(1)) {
          await ctx.db.delete(dup._id);
        }
        reactivated = true;
      } else {
        deviceRowId = await ctx.db.insert("registered_devices", {
          device_id: args.deviceId,
          label: args.deviceLabel,
          activated_by: pending.issued_by, // may be undefined (Telegram-issued)
          activated_at: now,
          last_seen_at: now,
          active: true,
        });
      }

      await logAudit(ctx, {
        actor_id: auditActor,
        action: "device.activated",
        entity_type: "device",
        entity_id: deviceRowId,
        source: "booth_inline", // activation is a physical booth act regardless of issuance channel
        device_id: args.deviceId,
        metadata: {
          activated_via_pending_id: pending._id,
          label: args.deviceLabel,
          reactivated,
          activated_via: activatedVia,
        },
      });
```

Note: `registered_devices.insert` requires `activated_by` to be omittable — Task 1 made it `v.optional`, so passing `undefined` is fine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/staff/__tests__/staff.test.ts`
Expected: PASS — new Telegram-activation test + existing booth activation tests (booth path: `activated_by` still set, `activated_via: "booth_inline"`).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no remaining `issued_by`/`activated_by` undefined errors).

- [ ] **Step 6: Commit**

```bash
git add convex/staff/public.ts convex/staff/__tests__/staff.test.ts
git commit -m "feat(staff): activateDevice tolerates Telegram-issued codes (system actor)"
```

---

## Task 4: `/activatepos` command factory + chat-gated action

**Files:**
- Create: `convex/telegram/activatePos.ts`
- Test: `convex/telegram/__tests__/activatePos.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `convex/telegram/__tests__/activatePos.test.ts`:

```typescript
import { convexTest } from "convex-test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { buildActivatePosCommand } from "../activatePos";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("POS_BASE_URL", "https://pos.example.com");
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 7 } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

async function seedManagersChat(t: ReturnType<typeof convexTest>, chatId: string) {
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId,
      chatType: "supergroup",
      title: "Frollie · Managers",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
}

describe("handleActivatePos", () => {
  it("issues a code and sends the reply when the command comes from the managers chat", async () => {
    const t = convexTest(schema);
    await seedManagersChat(t, "-100managers");

    await t.action(internal.telegram.activatePos.handleActivatePos, {
      chatId: "-100managers",
      chatTitle: "Frollie · Managers",
      fromId: 4242,
    });

    // a pending code row was written
    const rows = await t.run((ctx) => ctx.db.query("pending_device_setups").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].issued_via).toBe("telegram");
    const code = rows[0].setup_code;

    // the reply was sent to the managers chat with the code
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chat_id).toBe("-100managers");
    expect(body.text).toContain(code);
    expect(body.text).toContain("https://pos.example.com/activate");
  });

  it("does nothing when the command comes from a non-managers chat", async () => {
    const t = convexTest(schema);
    await seedManagersChat(t, "-100managers");

    await t.action(internal.telegram.activatePos.handleActivatePos, {
      chatId: "-100intruder",
      chatTitle: "Some Other Group",
      fromId: 1,
    });

    const rows = await t.run((ctx) => ctx.db.query("pending_device_setups").collect());
    expect(rows.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when no chat is bound to the managers role", async () => {
    const t = convexTest(schema); // no managers chat seeded
    await t.action(internal.telegram.activatePos.handleActivatePos, {
      chatId: "-100whoever",
      chatTitle: "Whoever",
      fromId: 1,
    });
    const rows = await t.run((ctx) => ctx.db.query("pending_device_setups").collect());
    expect(rows.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildActivatePosCommand", () => {
  it("registers a single 'activatepos' command that schedules the action", async () => {
    const scheduled: Array<unknown> = [];
    const fakeScheduler = {
      runAfter: vi.fn(async (_delay, _ref, args) => {
        scheduled.push(args);
      }),
    } as any;
    const cmds = buildActivatePosCommand(fakeScheduler);
    expect(cmds.map((c) => c.name)).toEqual(["activatepos"]);
    await cmds[0].dispatch({
      chatId: "-100managers",
      chatType: "supergroup",
      title: "Frollie · Managers",
      fromId: 4242,
      text: "/activatepos",
    });
    expect(fakeScheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(scheduled[0]).toEqual({
      chatId: "-100managers",
      chatTitle: "Frollie · Managers",
      fromId: 4242,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/telegram/__tests__/activatePos.test.ts`
Expected: FAIL — `../activatePos` module does not exist.

- [ ] **Step 3: Create `convex/telegram/activatePos.ts`**

```typescript
// convex/telegram/activatePos.ts
//
// `/activatepos` — managers mint a device setup code from Telegram. Gated to the
// chat bound to the "managers" role (the same chat that receives /approve cards).
// Mirrors the buildRegistryCommands factory shape; the chat-role gate lives in the
// action because dispatch has only a Scheduler (no query ctx).

import type { Scheduler } from "convex/server";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { CommandRegistration } from "./commands";
import { sendTelegramHtml, escapeHtml } from "../lib/telegramHtml";
import { formatWibDateTime } from "../lib/time";

export function buildActivatePosCommand(scheduler: Scheduler): CommandRegistration[] {
  return [
    {
      name: "activatepos",
      dispatch: async (msg) => {
        await scheduler.runAfter(0, internal.telegram.activatePos.handleActivatePos, {
          chatId: msg.chatId,
          chatTitle: msg.title,
          fromId: msg.fromId,
        });
      },
    },
  ];
}

export const handleActivatePos = internalAction({
  args: {
    chatId: v.string(),
    chatTitle: v.string(),
    fromId: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

    // Chat-role gate: only the chat bound to "managers" may mint codes.
    // Narrow catch (mirrors dispatch.ts:42-51): treat ONLY an unbound role as a
    // silent no-op; rethrow anything else so transient failures surface in the
    // Convex dashboard instead of looking like an auth rejection.
    let managersChatId: string;
    try {
      managersChatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "managers" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) return; // unbound — silent
      throw err; // unexpected — surface it
    }
    if (managersChatId !== args.chatId) return;

    try {
      const { code, expiresAt } = await ctx.runMutation(
        internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
        { chatTitle: args.chatTitle, fromId: args.fromId },
      );
      const baseUrl = process.env.POS_BASE_URL;
      const until = escapeHtml(formatWibDateTime(expiresAt));
      const where = baseUrl
        ? `On the new phone/browser, open ${escapeHtml(baseUrl)}/activate and enter the code.`
        : `On the new phone/browser, open the POS /activate page and enter the code.`;
      const html = [
        `🔓 Device setup code: <b>${code}</b>`,
        `Valid until ${until} (1 hour).`,
        where,
      ].join("\n");
      await sendTelegramHtml(token, args.chatId, html);
    } catch (err) {
      // Issuance or send failed (collision exhaustion, network) — never leave
      // the manager with silence.
      console.warn("[telegram] /activatepos issuance failed", err);
      try {
        await sendTelegramHtml(
          token,
          args.chatId,
          "⚠️ Couldn't generate a setup code — please try again.",
        );
      } catch {
        /* best-effort */
      }
    }
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/telegram/__tests__/activatePos.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/telegram/activatePos.ts convex/telegram/__tests__/activatePos.test.ts
git commit -m "feat(telegram): /activatepos chat-gated device-setup-code command"
```

---

## Task 5: Wire the command into the webhook registry

**Files:**
- Modify: `convex/http.ts:2-23`
- Test: covered by Task 4's `buildActivatePosCommand` test + a matcher assertion below

- [ ] **Step 1: Write the failing test**

Append to `convex/telegram/__tests__/activatePos.test.ts`:

```typescript
import { buildCommandMatcher } from "../commands";
import { buildRegistryCommands } from "../registryCommands";

describe("webhook registry includes /activatepos", () => {
  it("matches /activatepos and /activatepos@Bot, rejects trailing args", () => {
    const fakeScheduler = { runAfter: vi.fn() } as any;
    const registrations = [
      ...buildRegistryCommands(fakeScheduler),
      ...buildActivatePosCommand(fakeScheduler),
    ];
    const matcher = buildCommandMatcher(registrations);
    expect(matcher("/activatepos")?.command.name).toBe("activatepos");
    expect(matcher("/activatepos@FrolliePOS_Bot")?.command.name).toBe("activatepos");
    expect(matcher("/activatepos 123")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/telegram/__tests__/activatePos.test.ts -t "webhook registry"`
Expected: PASS already for matcher logic IF imports resolve — but this test documents the registry composition. It fails only if `buildActivatePosCommand` isn't wired in `http.ts` for production. Proceed to wire it (Step 3) so prod actually registers the command.

- [ ] **Step 3: Wire it in `convex/http.ts`**

Add the import and spread it into the registry array:

```typescript
import { buildHandleTelegramWebhook } from "./telegram/webhook";
import { buildRegistryCommands } from "./telegram/registryCommands";
import { buildActivatePosCommand } from "./telegram/activatePos";
```

```typescript
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run convex/telegram/__tests__/activatePos.test.ts && npm run typecheck`
Expected: PASS (5 tests total in file) + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add convex/http.ts convex/telegram/__tests__/activatePos.test.ts
git commit -m "feat(telegram): register /activatepos in the webhook command registry"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/SCHEMA.md`, `docs/API_REFERENCE.md`, `docs/RUNBOOK-telegram.md`, `CLAUDE.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: `docs/SCHEMA.md`** — update `pending_device_setups` and `registered_devices`:
  - `pending_device_setups.issued_by` → optional; note "absent for Telegram-issued codes".
  - Add rows: `issued_via` (`"booth_inline" | "telegram"`, absent = booth), `issued_by_telegram` (`{ from_id?, chat_title }`, Telegram issuer attribution).
  - `registered_devices.activated_by` → optional; note "absent when activated via a Telegram-issued code".
  - Under the audit-verb section, note `device.setup_code_issued` / `device.activated` now emit with `actor_id: "system"` + `source: "telegram_approval"` for the Telegram path.

- [ ] **Step 2: `docs/API_REFERENCE.md`** — add under `staff/`: `issueDeviceSetupCode` (plain helper, single writer) and `_issueDeviceSetupCodeFromTelegram_internal` (internalMutation). Under `telegram/`: `activatePos.ts` — `buildActivatePosCommand` factory + `handleActivatePos` internalAction.

- [ ] **Step 3: `docs/RUNBOOK-telegram.md`** — add a `/activatepos` entry: managers-chat-gated, replies with a 6-digit device setup code (1h TTL); requires a chat bound to the `managers` role; `POS_BASE_URL` env used for the activation link. **Operational gotcha (staffreview Imp-3):** the managers chat is a supergroup, and Telegram bot **privacy mode is ON by default** — a bare `/activatepos` in the group is NOT delivered to the bot. Either (a) BotFather → `/setprivacy` → **Disable** (then remove & re-add the bot to the group), or (b) managers must type `/activatepos@<bot_username>` (the matcher accepts the `@Bot` suffix). Register via BotFather `/setcommands` as `activatepos - mint a device setup code` so it autocompletes with the `@Bot` form.

- [ ] **Step 4: `CLAUDE.md`** — in the Telegram section command list, add `/activatepos` (managers role → device setup code). Add a one-line business-rule note that device-setup codes now have two issuance paths: booth manager-session (`generateDeviceSetupCode`) and managers-Telegram (`/activatepos` → `issueDeviceSetupCode`, `issued_via` discriminant).

- [ ] **Step 5: `docs/CHANGELOG.md`** — add an entry:

```markdown
## 2026-06-05 — /activatepos Telegram device activation
- Managers can mint a 6-digit device setup code by sending `/activatepos` in the
  managers Telegram chat (chat-role gated). Activates a new phone/browser on the fly.
- Schema: `pending_device_setups.issued_via` discriminant + optional `issued_by` /
  `issued_by_telegram`; `registered_devices.activated_by` now optional. Telegram-issued
  codes audit with the `"system"` actor + `telegram_approval` source.
- Single-writer `issueDeviceSetupCode` helper shared by booth + Telegram paths.
```

- [ ] **Step 6: Commit**

```bash
git add docs/SCHEMA.md docs/API_REFERENCE.md docs/RUNBOOK-telegram.md CLAUDE.md docs/CHANGELOG.md
git commit -m "docs: /activatepos schema, API, runbook, changelog"
```

---

## Task 7: Full verification

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: PASS — all suites, including the new schema, staff, and activatePos tests.

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS. (No public mutation added, so the idempotency ESLint rule is N/A — the new mutation is internal.)

---

## Success Criteria

- `npm run typecheck`, `npm run build`, `npm run lint`, `npx vitest run` all pass.
- Sending `/activatepos` in the managers chat returns a 6-digit code + WIB expiry + activate link; the code activates a device via the existing `/activate` flow.
- Non-managers chats get no response; no managers chat bound → silent no-op.
- Telegram-issued codes carry `issued_via: "telegram"`, audit with `actor_id: "system"` + `source: "telegram_approval"`; booth path unchanged.

## Rollback / Deployment

- **Deploy order:** backend (`npx convex deploy`) before any prod use — the schema change is **additive and back-compatible** (optional fields; existing rows valid), so no migration and no downtime. Frontend unaffected (no UI change).
- **Post-deploy:** ensure a chat is bound to the `managers` role (already required for approvals) and `POS_BASE_URL` is set on the deployment. **Telegram privacy mode (Imp-3):** in a supergroup the bot won't see a bare `/activatepos` unless privacy is disabled via BotFather `/setprivacy`; otherwise managers must use `/activatepos@<bot_username>`. Register the command via `/setcommands` as `activatepos - mint a device setup code` so the `@Bot` form autocompletes.
- **Rollback:** revert the PR. The optional schema fields can remain (harmless) or be reverted once no Telegram-issued rows exist. Removing them while such rows exist would orphan data — leave them if unsure.

## Edge cases covered

- `fromId` undefined (anonymous admin / channel post) → code still issued (Task 2 test).
- No managers chat bound → `getChatIdByRole` throws → caught, silent (Task 4 test).
- Non-managers chat → gate rejects, no write, no send (Task 4 test).
- `POS_BASE_URL` unset → code-only reply, no throw (Task 4 action code).
- Collision-loop exhaustion / send failure → "try again" reply (Task 4 action code).
- Existing booth-issued pending rows and registered devices remain valid (Task 1 legacy-row test).
