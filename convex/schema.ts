import { defineSchema } from "convex/server";
import { opsTables } from "./ops/schema";
import { authTables } from "./auth/schema";
import { catalogTables } from "./catalog/schema";
import { idempotencyTables } from "./idempotency/schema";
import { auditTables } from "./audit/schema";
import { telegramTables } from "./telegram/schema";
import { transactionsTables } from "./transactions/schema";
import { receiptsTables } from "./receipts/schema";
import { refundsTables } from "./refunds/schema";
import { paymentsTables } from "./payments/schema";
import { inventoryTables } from "./inventory/schema";
import { vouchersTables } from "./vouchers/schema";
import { approvalsTables } from "./approvals/schema";
import { settingsTables } from "./settings/schema";
import { settlementsTables } from "./settlements/schema";

export default defineSchema({
  ...opsTables,
  ...authTables,
  ...catalogTables,
  ...idempotencyTables,
  ...auditTables,
  ...telegramTables,
  ...transactionsTables,
  ...receiptsTables,
  ...refundsTables,
  ...paymentsTables,
  ...inventoryTables,
  ...vouchersTables,
  ...approvalsTables,
  ...settingsTables,
  ...settlementsTables,
});
