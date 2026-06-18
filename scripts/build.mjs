// Cross-platform build entry, invoked by `npm run build`.
//
// On a Vercel PRODUCTION deploy, deploy the Convex backend FIRST (so backend +
// frontend ship atomically — a mutation↔action rename is deploy-skew-fatal in
// both directions; see CLAUDE.md "Convex deployment"), then build the frontend.
// On preview/local builds, only codegen + build the frontend — a preview must
// NEVER deploy to prod.
//
// Why this lives in the build script (not just vercel.json): a Build Command set
// in the Vercel dashboard OVERRIDES vercel.json's buildCommand. Putting the gated
// logic inside `npm run build` makes it correct no matter how the build is
// invoked. Requires CONVEX_DEPLOY_KEY (a prod deploy key) in the Vercel project's
// Production env for the deploy step.
import { execSync } from "node:child_process";

const isVercelProd = process.env.VERCEL_ENV === "production";
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

if (isVercelProd) {
  // `convex deploy` pushes the prod backend (uses CONVEX_DEPLOY_KEY), regenerates
  // convex/_generated, injects VITE_CONVEX_URL, then runs the FE build via --cmd.
  // The inner `convex codegen` is belt-and-suspenders so tsc always sees
  // _generated even if the deploy's own codegen ever changes shape.
  sh(
    'npx convex deploy --cmd "npx convex codegen && tsc -b && vite build" --cmd-url-env-var-name VITE_CONVEX_URL',
  );
} else {
  // Preview / local: FE-only. codegen first so tsc -b finds convex/_generated.
  sh("npx convex codegen && tsc -b && vite build");
}
