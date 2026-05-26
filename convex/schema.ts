import { defineSchema } from "convex/server";
import { authTables } from "./auth/schema";
import { catalogTables } from "./catalog/schema";
import { idempotencyTables } from "./idempotency/schema";
import { auditTables } from "./audit/schema";
import { telegramTables } from "./telegram/schema";

export default defineSchema({
  ...authTables,
  ...catalogTables,
  ...idempotencyTables,
  ...auditTables,
  ...telegramTables,
});
