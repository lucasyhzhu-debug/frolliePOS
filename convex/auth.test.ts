import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

export async function seedStaff(
  t: ReturnType<typeof convexTest>,
  name: string,
  pin: string,
  role: "staff" | "manager" = "staff",
) {
  // Tests reuse the same hashing routine as production (no parallel
  // hashing impl). Route through the Node action so jsdom doesn't try
  // to evaluate it.
  return await t.action(internal.authActions._seedHashedStaff_internal, {
    name, pin, role,
  });
}

describe("getActiveStaff", () => {
  it("returns active staff only, name+role+_id (no pin_hash)", async () => {
    const t = convexTest(schema, modules);
    await seedStaff(t, "Citra", "1234");
    await seedStaff(t, "Bayu", "5678");
    await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "Old", pin_hash: "x", role: "staff", active: false, created_at: 0,
      })
    );

    const rows = await t.query(api.auth.getActiveStaff, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty("pin_hash");
    expect(rows.map((s: { name: string }) => s.name).sort()).toEqual(["Bayu", "Citra"]);
  });
});

describe("getSession", () => {
  it("returns the active session shape", async () => {
    const t = convexTest(schema, modules);
    const staffId = await seedStaff(t, "Citra", "1234");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-1",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      })
    );
    const s = await t.query(api.auth.getSession, { sessionId });
    expect(s).not.toBeNull();
    expect(s!.staff.name).toBe("Citra");
  });

  it("returns null for ended sessions", async () => {
    const t = convexTest(schema, modules);
    const staffId = await seedStaff(t, "Citra", "1234");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-1",
        started_at: Date.now() - 60_000,
        ended_at: Date.now(),
        end_reason: "manual_lock",
      })
    );
    const s = await t.query(api.auth.getSession, { sessionId });
    expect(s).toBeNull();
  });

  it("returns null when staff has been deactivated", async () => {
    const t = convexTest(schema, modules);
    const staffId = await seedStaff(t, "Citra", "1234");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "dev-1",
        started_at: Date.now(), ended_at: null, end_reason: null,
      })
    );
    await t.run(async (ctx) => ctx.db.patch(staffId, { active: false }));
    const s = await t.query(api.auth.getSession, { sessionId });
    expect(s).toBeNull();
  });
});
