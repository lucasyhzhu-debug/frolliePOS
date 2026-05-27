// test/cli.test.mjs — exercises bin/cli.mjs end-to-end via child_process
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "../bin/cli.mjs");

// Helper: run CLI synchronously; returns { stdout, stderr, status }
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? -1,
  };
}

// Helper: make a fresh temp dir with a minimal PROGRESS.md inside
function makeTempDir(suffix = "") {
  const dir = join(tmpdir(), `cpr-test-${Date.now()}${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMd(dir, content) {
  writeFileSync(join(dir, "PROGRESS.md"), content, "utf8");
}

const MINIMAL_MD = `**Mission.** Test run.

## v0.1 — bootstrap 📋 PLANNED
**Outcome:** Something boots.
**Target:** TBD

### Backend

- 📋 **[v01-be-boot]** Boots
`;

// ─── 1. --help exits 0 and prints "ceo-report" ───────────────────────────────

test("cli.mjs --help exits 0 and prints 'ceo-report'", () => {
  // --help is not a named command; falls through to cmdHelp() via the else branch
  const { stdout, status } = runCli(["--help"]);
  assert.equal(status, 0, "--help exits with code 0");
  assert.ok(stdout.includes("ceo-report"), "stdout contains 'ceo-report'");
});

// ─── 2. build with non-existent src exits 1 and prints error ─────────────────

test("cli.mjs build --src <nonexistent> exits 1 and prints source-not-found error", () => {
  const dir = makeTempDir("-nonexistent");
  const { stderr, status } = runCli(
    ["build", "--src", join(dir, "DOES_NOT_EXIST.md")],
    dir
  );
  assert.equal(status, 1, "exits with code 1");
  assert.ok(
    stderr.includes("source not found") || stderr.includes("✗"),
    `stderr mentions source error: ${stderr}`
  );
});

// ─── 3. build against a real PROGRESS.md produces progress.html ──────────────

test("cli.mjs build against a temp PROGRESS.md produces progress.html", async () => {
  const dir = makeTempDir("-build");
  writeMd(dir, MINIMAL_MD);
  const outPath = join(dir, "progress.html");

  const { stdout, stderr, status } = runCli(["build"], dir);

  assert.equal(
    status, 0,
    `build should exit 0; stderr: ${stderr}; stdout: ${stdout}`
  );
  assert.ok(existsSync(outPath), "progress.html created");

  // Basic sanity: produced HTML
  const html = readFileSync(outPath, "utf8");
  assert.ok(html.includes("<!doctype html>"), "output is HTML");
});

// ─── 4. --config <nonexistent> does NOT crash ────────────────────────────────

test("cli.mjs build --config <nonexistent> does not crash (loadConfig returns {})", () => {
  const dir = makeTempDir("-noconfig");
  writeMd(dir, MINIMAL_MD);

  const { stdout, stderr, status } = runCli(
    ["build", "--config", join(dir, "no-such-config.mjs")],
    dir
  );

  // loadConfig checks existsSync and returns {} when file is absent — no crash
  assert.equal(
    status, 0,
    `should exit 0 with missing config; stderr: ${stderr}; stdout: ${stdout}`
  );
});
