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

describe("getByToken", () => {
  it("returns request projection by raw token", async () => {
    const t = convexTest(schema);
    await seedStaffAndRequest(t, { rawToken: "raw-token-xyz" });

    const r = await t.query(api.approvals.public.getByToken, {
      rawToken: "raw-token-xyz",
    });

    expect(r).not.toBeNull();
    expect(r!.kind).toBe("staff_pin_reset");
    expect(r!.subject_staff_name).toBe("Lucy");
    expect(r!.subject_staff_code).toBe("S-0042");
    expect(r!.status).toBe("pending");

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
