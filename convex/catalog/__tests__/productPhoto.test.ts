import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";
import type { Id } from "../../_generated/dataModel";

// _helpers exports ONLY seedManagerSession → { managerId, sessionId, deviceId }
// (manager PIN "9999"). Seed a non-manager inline for the rejection test.
async function seedStaffSession(t: ReturnType<typeof convexTest>) {
  const staffId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
    name: "Sari",
    pin: "1111",
    role: "staff",
  });
  const outletId = await t.run(async (ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    } as any)
  ) as any;
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "staff-device",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any),
  );
  return { staffId, sessionId };
}

// Create a product via the real PIN-gated action (manager PIN "9999" from
// seedManagerSession). createProduct → { productId }.
async function makeProduct(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"staff_sessions">,
  key: string,
): Promise<Id<"pos_products">> {
  const { productId } = await t.action(api.catalog.actions.createProduct, {
    idempotencyKey: key,
    sessionId,
    managerPin: "9999",
    sku_family: "dubai",
    code: "DUBAI_8PC",
    name: "Dubai 8pcs",
    pack_label: "8 pcs",
    price_idr: 120000,
    tax_rate: 0,
    sort_order: 0,
  });
  return productId;
}

describe("generateProductPhotoUploadUrl", () => {
  test("manager session returns an upload url", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const res = await t.mutation(api.catalog.public.generateProductPhotoUploadUrl, {
      idempotencyKey: "k1",
      sessionId,
    });
    expect(typeof res.uploadUrl).toBe("string");
    expect(res.uploadUrl.length).toBeGreaterThan(0);
  });

  test("non-manager session is rejected", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedStaffSession(t);
    await expect(
      t.mutation(api.catalog.public.generateProductPhotoUploadUrl, {
        idempotencyKey: "k2",
        sessionId,
      }),
    ).rejects.toThrow();
  });
});

describe("updateProductMeta photo semantics", () => {
  test("setting a photo id persists it", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const productId = await makeProduct(t, sessionId, "cp1");
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "image/webp" })),
    );
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m1", sessionId, productId,
      name: "Dubai 8pcs", pack_label: "8 pcs", sort_order: 0,
      photo_storage_id: storageId,
    });
    const prod = await t.run((ctx) => ctx.db.get(productId));
    expect(prod?.photo_storage_id).toBe(storageId);
  });

  test("omitting photo_storage_id preserves the existing photo (name-only edit)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const productId = await makeProduct(t, sessionId, "cp2");
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "image/webp" })),
    );
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m2", sessionId, productId,
      name: "A", pack_label: "8 pcs", sort_order: 0, photo_storage_id: storageId,
    });
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m3", sessionId, productId,
      name: "Renamed", pack_label: "8 pcs", sort_order: 0, // photo omitted
    });
    const prod = await t.run((ctx) => ctx.db.get(productId));
    expect(prod?.photo_storage_id).toBe(storageId); // preserved
    expect(prod?.name).toBe("Renamed");
  });

  test("null removes the photo (field deleted)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const productId = await makeProduct(t, sessionId, "cp3");
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "image/webp" })),
    );
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m4", sessionId, productId,
      name: "A", pack_label: "8 pcs", sort_order: 0, photo_storage_id: storageId,
    });
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m5", sessionId, productId,
      name: "A", pack_label: "8 pcs", sort_order: 0, photo_storage_id: null,
    });
    const prod = await t.run((ctx) => ctx.db.get(productId));
    expect(prod?.photo_storage_id).toBeUndefined();
  });
});
