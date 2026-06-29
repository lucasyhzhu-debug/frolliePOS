import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Guards the root cause of the "booth stuck on an old version" incident: the
// in-app version label is `package.json.version` (injected as `__APP_VERSION__`),
// and it had silently drifted to 1.2.1 while 1.3.x shipped because nobody bumped
// it. This test makes that drift a CI failure — the newest CHANGELOG entry's
// version MUST equal package.json, so shipping a build forces both to move
// together. See CLAUDE.md "Versioning" + docs/CHANGELOG.md header.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const changelog = readFileSync(join(repoRoot, "docs/CHANGELOG.md"), "utf8");

// The first `## …` heading carrying a `vX.Y[.Z]` token is the latest release.
// Matches both "— v1.4.0: …" and "v2.0 Two-level …" heading styles.
function latestChangelogVersion(md) {
  for (const line of md.split("\n")) {
    const m = /^##\s+.*\bv(\d+\.\d+(?:\.\d+)?)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

describe("version sync", () => {
  it("package.json version matches the latest CHANGELOG entry", () => {
    const latest = latestChangelogVersion(changelog);
    expect(latest).not.toBeNull();
    expect(pkg.version).toBe(latest);
  });
});
