import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { sha256Hex } from "../../lib/sha256"; // V8-safe async (PL-1) — await it

test("_redeemBinding_internal redeems a valid bind token and writes telegram_user_id", async () => {
  const t = convexTest(schema);
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "O",
      code: "S-9001",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as any),
  );
  const raw = "rawtoken123";
  const tokenHash = await sha256Hex(raw);
  await t.run((ctx) =>
    ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: staffId,
      token_hash: tokenHash,
      expires_at: Date.now() + 6e5,
      redeemed_at: null,
      created_at: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.runMutation(internal.auth.ownerInternal._redeemBinding_internal, {
      tokenHash,
      fromId: 4242,
      chatType: "private",
    }),
  );
  const staff = await t.run((ctx) => ctx.db.get(staffId));
  expect((staff as any).telegram_user_id).toBe(4242);
});

test("group-chat redeem is rejected (OTP must never land in a group)", async () => {
  const t = convexTest(schema);
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "O",
      code: "S-9002",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as any),
  );
  const raw = "grouptoken";
  const tokenHash = await sha256Hex(raw);
  await t.run((ctx) =>
    ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: staffId,
      token_hash: tokenHash,
      expires_at: Date.now() + 6e5,
      redeemed_at: null,
      created_at: Date.now(),
    }),
  );
  await expect(
    t.run((ctx) =>
      ctx.runMutation(internal.auth.ownerInternal._redeemBinding_internal, {
        tokenHash,
        fromId: 1,
        chatType: "group",
      }),
    ),
  ).rejects.toThrow("BIND_PRIVATE_ONLY");
});

test("duplicate telegram_user_id is rejected (one account per telegram user)", async () => {
  const t = convexTest(schema);
  const raw = "dup";
  const tokenHash = await sha256Hex(raw);
  await t.run(async (ctx) => {
    await ctx.db.insert("staff", {
      name: "A",
      code: "S-1",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
      telegram_user_id: 4242,
    } as any);
    const b = await ctx.db.insert("staff", {
      name: "B",
      code: "S-2",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as any);
    await ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: b,
      token_hash: tokenHash,
      expires_at: Date.now() + 6e5,
      redeemed_at: null,
      created_at: Date.now(),
    });
  });
  await expect(
    t.run((ctx) =>
      ctx.runMutation(internal.auth.ownerInternal._redeemBinding_internal, {
        tokenHash,
        fromId: 4242,
        chatType: "private",
      }),
    ),
  ).rejects.toThrow("TELEGRAM_ALREADY_BOUND");
});

test("invalid / expired / already-redeemed token is rejected with BIND_INVALID", async () => {
  const t = convexTest(schema);
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "O",
      code: "S-9004",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as any),
  );
  // expired token
  const expiredHash = await sha256Hex("expired");
  await t.run((ctx) =>
    ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: staffId,
      token_hash: expiredHash,
      expires_at: Date.now() - 1000,
      redeemed_at: null,
      created_at: Date.now() - 2000,
    }),
  );
  await expect(
    t.run((ctx) =>
      ctx.runMutation(internal.auth.ownerInternal._redeemBinding_internal, {
        tokenHash: expiredHash,
        fromId: 5,
        chatType: "private",
      }),
    ),
  ).rejects.toThrow("BIND_INVALID");

  // unknown token
  const unknownHash = await sha256Hex("never-minted");
  await expect(
    t.run((ctx) =>
      ctx.runMutation(internal.auth.ownerInternal._redeemBinding_internal, {
        tokenHash: unknownHash,
        fromId: 5,
        chatType: "private",
      }),
    ),
  ).rejects.toThrow("BIND_INVALID");
});

test("_lookupBinding_internal resolves a minted binding by token_hash", async () => {
  const t = convexTest(schema);
  const raw = "lookup-me";
  const tokenHash = await sha256Hex(raw);
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "O",
      code: "S-9005",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as any),
  );
  await t.run((ctx) =>
    ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: staffId,
      token_hash: tokenHash,
      expires_at: Date.now() + 6e5,
      redeemed_at: null,
      created_at: Date.now(),
    }),
  );
  const found = await t.run((ctx) =>
    ctx.runQuery(internal.auth.ownerInternal._lookupBinding_internal, { tokenHash }),
  );
  expect(found?.staff_id).toBe(staffId);
});
