import { execSync } from "node:child_process";

export default async function globalSetup(): Promise<void> {
  // Reset the dev Convex deployment to its seeded state. Per-spec fixtures also
  // call this so specs are independent; this is the "cold-start" version that
  // makes the first spec deterministic.
  execSync("npx convex run seed/actions:reset", { stdio: "inherit" });
}
