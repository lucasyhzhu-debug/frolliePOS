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

    // activated_by must reference the seeded manager (Lucas). The booth seed
    // always sets it; v0.5.7 made the field optional (Telegram-issued codes have
    // no staff issuer), so narrow before the lookup.
    const activatedBy = devices[0].activated_by;
    expect(activatedBy).toBeDefined();
    const manager = await t.run((ctx) => ctx.db.get(activatedBy!));
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

describe("seed/_reset_internal — ADR-053 booth state (open outlet + shift holder)", () => {
  const baseArgs = {
    staffPinHash: "h1",
    mgrPinHash: "h2",
    staffNames: ["Bayu", "Citra", "Dewi", "Eka"],
  };

  it("opens the seeded outlet and seats Lucas as the default active holder", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._reset_internal, baseArgs);

    const outlet = await t.run(async (ctx) => (await ctx.db.query("outlets").collect())[0]);
    expect(outlet.is_open).toBe(true);
    expect(outlet.opened_via).toBe("sop");

    const shifts = await t.run((ctx) => ctx.db.query("pos_shifts").collect());
    expect(shifts.length).toBe(1);
    expect(shifts[0].ended_at).toBeNull();
    expect(shifts[0].device_id).toBe("dev-booth-device");
    const holder = await t.run((ctx) => ctx.db.get(shifts[0].staff_id));
    expect(holder?.name).toBe("Lucas");
  });

  it("holderStaffName seats the named staff as holder (e2e signedInAsStaff)", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._reset_internal, {
      ...baseArgs,
      holderStaffName: "Bayu",
    });

    const shifts = await t.run((ctx) => ctx.db.query("pos_shifts").collect());
    expect(shifts.length).toBe(1);
    const holder = await t.run((ctx) => ctx.db.get(shifts[0].staff_id));
    expect(holder?.name).toBe("Bayu");
    expect(holder?.role).toBe("staff");
  });

  it("rejects an unknown holder name", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.seed.internal._reset_internal, {
        ...baseArgs,
        holderStaffName: "Nobody",
      }),
    ).rejects.toThrow("SEED_UNKNOWN_HOLDER");
  });

  it("re-running reset leaves exactly one active holder (pos_shifts is wiped)", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.seed.internal._reset_internal, baseArgs);
    await t.mutation(internal.seed.internal._reset_internal, {
      ...baseArgs,
      holderStaffName: "Bayu",
    });

    const shifts = await t.run((ctx) => ctx.db.query("pos_shifts").collect());
    expect(shifts.length).toBe(1);
    const holder = await t.run((ctx) => ctx.db.get(shifts[0].staff_id));
    expect(holder?.name).toBe("Bayu");
  });
});
