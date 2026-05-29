import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("withIdempotency — action-level commit pattern", () => {
  it("when called from an action via runMutation, cache row exists after mutation commits", async () => {
    const t = convexTest(schema);
    const key = "action-key-write-through";

    // Before first call: no cache row
    const cached1 = await t.query(internal.idempotency.internal._lookup_internal, { key });
    expect(cached1).toBeNull();

    // First call: executes handler, writes cache row atomically
    const result = await t.mutation(internal.idempotency.internal.__test_echo_actionStyle, {
      idempotencyKey: key,
      value: 42,
    });
    expect(result).toEqual({ echoed: 42 });

    // After first call: cache row must exist
    const cached2 = await t.query(internal.idempotency.internal._lookup_internal, { key });
    expect(cached2).not.toBeNull();
    // _lookup_internal returns the raw response_blob JSON string
    expect(JSON.parse(cached2!)).toEqual({ echoed: 42 });
  });

  it("retry of action-style mutation returns cached response without re-executing", async () => {
    const t = convexTest(schema);
    const key = "action-key-replay";

    // First call: handler runs with value=100
    const r1 = await t.mutation(internal.idempotency.internal.__test_echo_actionStyle, {
      idempotencyKey: key,
      value: 100,
    });
    // Second call (retry): value=999 is ignored — cached response returned
    const r2 = await t.mutation(internal.idempotency.internal.__test_echo_actionStyle, {
      idempotencyKey: key,
      value: 999,
    });
    expect(r1).toEqual({ echoed: 100 });
    expect(r2).toEqual({ echoed: 100 }); // not 999
  });

  it("cache row is written atomically with state changes — throwing handler leaves no cache row", async () => {
    const t = convexTest(schema);
    const key = "action-key-tx-rollback";

    // Handler throws after value > 0 — whole transaction rolls back (cache row included)
    await expect(
      t.mutation(internal.idempotency.internal.__test_echo_actionStyle_throws, {
        idempotencyKey: key,
        value: 7,
      }),
    ).rejects.toThrow();

    // Cache row must NOT exist — rollback means no partial commit
    const cached = await t.query(internal.idempotency.internal._lookup_internal, { key });
    expect(cached).toBeNull();
  });
});
