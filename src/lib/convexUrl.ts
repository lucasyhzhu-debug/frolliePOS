// Single source for the Convex `.cloud` (WS/client) → `.site` (HTTP routing)
// origin swap. VITE_CONVEX_URL is the bare `.convex.cloud` WS origin; httpAction
// surfaces (receipt `/r/<token>`, ops `/ops/error`) live on `.convex.site`.
// The split is a known footgun (CLAUDE.md, memory `convex-deployments`) — keep
// the swap in exactly one place so a future deployment-shape change is one edit.
export function convexSiteOrigin(convexUrl: string): string {
  return convexUrl.replace(/\/$/, "").replace(/\.convex\.cloud$/, ".convex.site");
}
