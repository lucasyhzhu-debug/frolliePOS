import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export type SettingsOverrides = Partial<{
  receipt_business_name: string; receipt_address: string; receipt_contact: string;
  receipt_instagram_handle: string; receipt_footer_text: string;
  manual_bca_enabled: boolean; manual_bca_bank_name: string;
  manual_bca_account_name: string; manual_bca_account_number: string;
  founders_summary_enabled: boolean; txn_ticker_enabled: boolean;
}>;

export async function cloneSettingsRow(
  ctx: MutationCtx,
  { sourceOutletId, targetOutletId, now, ownerStaffId, overrides }:
  { sourceOutletId: Id<"outlets">; targetOutletId: Id<"outlets">; now: number; ownerStaffId: Id<"staff">; overrides: SettingsOverrides },
): Promise<void> {
  const src = await ctx.db.query("pos_settings").withIndex("by_outlet", (q) => q.eq("outlet_id", sourceOutletId)).first();
  // receipt_logo_storage_id reused by value; updated_*/outlet_id replaced; founders default true.
  const base = src
    ? (() => { const { _id, _creationTime, outlet_id, updated_at, updated_by, ...rest } = src; return rest; })()
    : { founders_summary_enabled: true };
  // Strip explicit `undefined` values from overrides so they don't clobber
  // the cloned source values (Object.assign and spread treat key:undefined as
  // a write that shadows the base value, which is wrong for optional fields).
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  );
  await ctx.db.insert("pos_settings", {
    ...base, ...cleanOverrides,
    outlet_id: targetOutletId, updated_at: now, updated_by: ownerStaffId,
  } as any);
}

export async function seedSettingsRow(
  ctx: MutationCtx,
  { targetOutletId, now, ownerStaffId, values }:
  { targetOutletId: Id<"outlets">; now: number; ownerStaffId: Id<"staff">; values: SettingsOverrides },
): Promise<void> {
  await ctx.db.insert("pos_settings", {
    founders_summary_enabled: values.founders_summary_enabled ?? true,
    ...values, outlet_id: targetOutletId, updated_at: now, updated_by: ownerStaffId,
  } as any);
}
