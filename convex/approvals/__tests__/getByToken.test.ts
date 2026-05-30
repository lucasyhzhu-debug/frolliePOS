import { describe, it, expect, vi, afterEach } from "vitest";
import { convexTest } from "convex-test";
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

// SHA-256 hex using node:crypto — for test seeding only.
// The implementation uses crypto.subtle (V8 runtime); both produce identical output.
function sha256HexNode(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function seedStaffAndRequest(
  t: ReturnType<typeof convexTest>,
  opts: {
    rawToken: string;
    tokenExpiresAt?: number;
  },
): Promise<{
  staffId: Id<"staff">;
  requestId: Id<"pos_approval_requests">;
}> {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Lucy",
      code: "S-0042",
      pin_hash: "hashed-pin",
      role: "staff",
      active: true,
      created_at: Date.now(),
    });

    const now = Date.now();
    const tokenHash = sha256HexNode(opts.rawToken);
    const requestId = await ctx.db.insert("pos_approval_requests", {
      kind: "staff_pin_reset",
      subject_staff_id: staffId,
      triggered_by_event: "auth_lockout",
      triggered_at: now,
      token_hash: tokenHash,
      token_expires_at: opts.tokenExpiresAt ?? now + 60 * 60 * 1000,
      status: "pending",
    });

    return { staffId, requestId };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getByToken — manual_payment_override", () => {
  it("getByToken returns manual_payment display fields", async () => {
    const t = convexTest(schema);
    const { rawToken } = await t.run(async (ctx) => {
      const token_hash = sha256HexNode("tok-1");
      await ctx.db.insert("pos_approval_requests", {
        kind: "manual_payment_override",
        entity_type: "pos_transactions",
        entity_id: "t1",
        context: { txn_id: "t1", amount_idr: 50000, reason: "BCA cleared" },
        reason: "BCA cleared",
        triggered_by_event: "manual_payment_request",
        triggered_at: Date.now(),
        token_hash,
        token_expires_at: Date.now() + 3600_000,
        status: "pending",
      });
      return { rawToken: "tok-1" };
    });

    const res = await t.query(api.approvals.public.getByToken, { rawToken });
    expect(res?.kind).toBe("manual_payment_override");
    // Narrow to manual_payment_override branch before accessing `display`
    if (res?.kind !== "manual_payment_override") throw new Error("expected manual_payment_override");
    expect(res.display).toMatchObject({ amount_idr: 50000, reason: "BCA cleared" });
  });
});

describe("getByToken", () => {
  it("returns request projection by raw token", async () => {
    const t = convexTest(schema);
    await seedStaffAndRequest(t, { rawToken: "raw-token-xyz" });

    const r = await t.query(api.approvals.public.getByToken, {
      rawToken: "raw-token-xyz",
    });

    expect(r).not.toBeNull();
    expect(r!.kind).toBe("staff_pin_reset");
    // Narrow to staff_pin_reset branch before accessing its fields
    if (r?.kind !== "staff_pin_reset") throw new Error("expected staff_pin_reset");
    expect(r.subject_staff_name).toBe("Lucy");
    expect(r.subject_staff_code).toBe("S-0042");
    expect(r.status).toBe("pending");

    // token_hash MUST NOT be leaked
    expect((r as any).token_hash).toBeUndefined();
  });

  it("returns null for unknown raw token", async () => {
    const t = convexTest(schema);

    const r = await t.query(api.approvals.public.getByToken, {
      rawToken: "nope",
    });

    expect(r).toBeNull();
  });

  it("effective status: pending before expiry, expired at exactly expiry (staffreview T1 TTL boundary)", async () => {
    vi.useFakeTimers();

    const t = convexTest(schema);
    const expiry = Date.now() + 60 * 60 * 1000; // 1h from fake-timer start

    await seedStaffAndRequest(t, {
      rawToken: "ttl-test-token",
      tokenExpiresAt: expiry,
    });

    // At expiry - 1: still pending
    vi.setSystemTime(expiry - 1);
    const rBefore = await t.query(api.approvals.public.getByToken, {
      rawToken: "ttl-test-token",
    });
    expect(rBefore).not.toBeNull();
    expect(rBefore!.status).toBe("pending");

    // At exactly expiry: expired (DB row stays pending; effective status computed)
    vi.setSystemTime(expiry);
    const rAt = await t.query(api.approvals.public.getByToken, {
      rawToken: "ttl-test-token",
    });
    expect(rAt).not.toBeNull();
    expect(rAt!.status).toBe("expired");
  });
});
