import { defineSchema } from "convex/server";
import { authTables } from "./auth/schema";
import { catalogTables } from "./catalog/schema";
import { idempotencyTables } from "./idempotency/schema";
import { auditTables } from "./audit/schema";
import { telegramTables } from "./telegram/schema";
import { transactionsTables } from "./transactions/schema";
import { paymentsTables } from "./payments/schema";
import { inventoryTables } from "./inventory/schema";
import { vouchersTables } from "./vouchers/schema";
import { approvalsTables } from "./approvals/schema";

export default defineSchema({
  ...authTables,
  ...catalogTables,
  ...idempotencyTables,
  ...auditTables,
  ...telegramTables,
  ...transactionsTables,
  ...paymentsTables,
  ...inventoryTables,
  ...vouchersTables,
  ...approvalsTables,
});
