import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

describe("withIdempotency", () => {
  it("replays return identical response without re-executing", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.idempotency.__test_echo, {
      idempotencyKey: "key-1",
      value: 42,
    });
    expect(first.echoed).toBe(42);

    const second = await t.mutation(internal.idempotency.__test_echo, {
      idempotencyKey: "key-1",
      value: 999, // different input — should be ignored, cached response returned
    });
    expect(second.echoed).toBe(42); // not 999
  });

  it("distinct keys execute independently", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(internal.idempotency.__test_echo, {
      idempotencyKey: "key-a", value: 1,
    });
    const b = await t.mutation(internal.idempotency.__test_echo, {
      idempotencyKey: "key-b", value: 2,
    });
    expect(a.echoed).toBe(1);
    expect(b.echoed).toBe(2);
  });

  it("handler errors are NOT cached — retry re-executes (v0.2 design choice)", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.idempotency.__test_throw, { idempotencyKey: "key-err" }),
    ).rejects.toThrow(/boom/);

    await expect(
      t.mutation(internal.idempotency.__test_throw, { idempotencyKey: "key-err" }),
    ).rejects.toThrow(/boom/);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("pos_idempotency")
        .withIndex("by_key", (q) => q.eq("key", "key-err"))
        .collect()
    );
    expect(rows).toHaveLength(0);
  });

  it("public API is NOT exposed — __test_echo is internal", () => {
    // TypeScript-level assertion: api.idempotency.__test_echo must not exist.
    type ApiHasTestEcho = "__test_echo" extends keyof typeof api.idempotency ? true : false;
    const _check: ApiHasTestEcho = false;
    expect(_check).toBe(false);
  });
});
