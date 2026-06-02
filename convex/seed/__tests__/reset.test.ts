import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("seed/_reset_internal — dev device pre-registration", () => {
  it("seeds exactly one active registered_devices row for dev-booth-device", async () => {
    const t = convexTest(schema);

    // Drive the V8 mutation directly with dummy hashes (no argon2 action needed).
    await t.mutation(internal.seed.internal._reset_internal, {
      staffPinHash: "dummy-staff-hash",
      mgrPinHash: "dummy-mgr-hash",
      staffNames: ["Bayu", "Citra", "Dewi", "Eka"],
    });

    const devices = await t.run((ctx) =>
      ctx.db
        .query("registered_devices")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect(),
    );

    expect(devices.length).toBe(1);
    expect(devices[0].device_id).toBe("dev-booth-device");
    expect(devices[0].label).toBe("Dev Booth Device");

    // activated_by must reference the seeded manager (Lucas).
    const manager = await t.run((ctx) => ctx.db.get(devices[0].activated_by));
    expect(manager?.role).toBe("manager");
    expect(manager?.name).toBe("Lucas");
  });

  it("re-running reset leaves exactly one device row (no duplicates)", async () => {
    const t = convexTest(schema);
    const args = {
      staffPinHash: "h1",
      mgrPinHash: "h2",
      staffNames: ["Bayu", "Citra", "Dewi", "Eka"],
    };
    await t.mutation(internal.seed.internal._reset_internal, args);
    await t.mutation(internal.seed.internal._reset_internal, args);

    const devices = await t.run((ctx) =>
      ctx.db.query("registered_devices").collect(),
    );
    expect(devices.length).toBe(1);
    expect(devices[0].device_id).toBe("dev-booth-device");
  });
});
