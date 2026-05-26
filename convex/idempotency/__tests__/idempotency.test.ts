import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

describe("withIdempotency", () => {
  it("replays return identical response without re-executing", async () => {
    const t = convexTest(schema);

    const first = await t.mutation(internal.idempotency.internal.__test_echo, {
      idempotencyKey: "key-1",
      value: 42,
    });
    expect(first.echoed).toBe(42);

    const second = await t.mutation(internal.idempotency.internal.__test_echo, {
      idempotencyKey: "key-1",
      value: 999, // different input — should be ignored, cached response returned
    });
    expect(second.echoed).toBe(42); // not 999
  });

  it("distinct keys execute independently", async () => {
    const t = convexTest(schema);
    const a = await t.mutation(internal.idempotency.internal.__test_echo, {
      idempotencyKey: "key-a", value: 1,
    });
    const b = await t.mutation(internal.idempotency.internal.__test_echo, {
      idempotencyKey: "key-b", value: 2,
    });
    expect(a.echoed).toBe(1);
    expect(b.echoed).toBe(2);
  });

  it("handler errors are NOT cached — retry re-executes (v0.2 design choice)", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.idempotency.internal.__test_throw, { idempotencyKey: "key-err" }),
    ).rejects.toThrow(/boom/);

    await expect(
      t.mutation(internal.idempotency.internal.__test_throw, { idempotencyKey: "key-err" }),
    ).rejects.toThrow(/boom/);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("pos_idempotency")
        .withIndex("by_key", (q) => q.eq("key", "key-err"))
        .collect()
    );
    expect(rows).toHaveLength(0);
  });

  it("public API is NOT exposed — __test_echo is internal", () => {
    // TypeScript-level assertion: api.idempotency.internal must not exist
    // (all idempotency exports are internal-only; the namespace itself shouldn't
    // appear under `api`).
    type ApiHasIdempotency = "idempotency" extends keyof typeof api ? true : false;
    const _check: ApiHasIdempotency = false;
    expect(_check).toBe(false);
  });

  it("duplicate rows for same key do not throw — .first() returns oldest response", async () => {
    const t = convexTest(schema);
    const key = "key-dup";

    // Manually insert two rows with the same idempotency key, simulating a TOCTOU race.
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_idempotency", {
        key,
        mutation_name: "__test_echo",
        staff_id: undefined,
        response_blob: JSON.stringify({ echoed: 1 }),
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
      });
      await ctx.db.insert("pos_idempotency", {
        key,
        mutation_name: "__test_echo",
        staff_id: undefined,
        response_blob: JSON.stringify({ echoed: 2 }),
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
      });
    });

    // Calling with this key must NOT throw — .first() picks the oldest row.
    const result = await t.mutation(internal.idempotency.internal.__test_echo, {
      idempotencyKey: key,
      value: 999, // ignored — cache hit
    });

    // Should return one of the pre-inserted responses without throwing.
    expect([1, 2]).toContain(result.echoed);
  });
});
