#!/usr/bin/env node
// packages/ceo-progress-report/bin/cli.mjs
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync, watch as fsWatch } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHtml } from "../src/index.mjs";
import { parseProgressMarkdown } from "../src/parse.mjs";
import { runChecks } from "../src/check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

// Per staffreview Improvement 4 — Windows-safe dynamic import via pathToFileURL.
// Brittle string concat with "/" + path will fail on Windows (C:\foo\config.mjs
// needs file:///C:/foo/config.mjs for dynamic import to resolve).
async function loadConfig(cwd) {
  const flagged = flag("config");
  const configPath = flagged
    ? resolve(cwd, flagged)
    : resolve(cwd, "buildlog.config.mjs");
  if (!existsSync(configPath)) return {};
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default || {};
}

async function cmdBuild() {
  const cwd = process.cwd();
  const src = flag("src", resolve(cwd, "PROGRESS.md"));
  const out = flag("out", resolve(cwd, "progress.html"));
  if (!existsSync(src)) {
    console.error(`✗ source not found: ${src}`);
    process.exit(1);
  }
  const md = await readFile(src, "utf8");
  const config = await loadConfig(cwd);
  const html = await buildHtml(md, config);
  await writeFile(out, html, "utf8");
  console.log(`✓ wrote ${out}`);
}

async function cmdInit() {
  const cwd = process.cwd();
  const templates = resolve(PKG_ROOT, "templates");
  const targets = [
    ["PROGRESS.md", resolve(cwd, "PROGRESS.md")],
    ["buildlog.config.mjs", resolve(cwd, "buildlog.config.mjs")],
    ["CLAUDE.md", resolve(cwd, "CLAUDE.md")],
    [".github/workflows/ceo-report.yml", resolve(cwd, ".github/workflows/ceo-report.yml")],
  ];
  for (const [src, dst] of targets) {
    if (existsSync(dst)) {
      console.log(`⊘ ${dst} already exists, skipping`);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    await cp(resolve(templates, src), dst);
    console.log(`✓ wrote ${dst}`);
  }
  console.log(`\nNext: edit PROGRESS.md, then run: npx ceo-report build`);
}

async function cmdWatch() {
  const cwd = process.cwd();
  const src = flag("src", resolve(cwd, "PROGRESS.md"));
  const out = flag("out", resolve(cwd, "progress.html"));
  const configPath = flag("config", resolve(cwd, "buildlog.config.mjs"));

  async function doBuild() {
    const t = Date.now();
    if (!existsSync(src)) {
      console.error(`⊘ ${src} not found — waiting for it to appear`);
      return;
    }
    try {
      const md = await readFile(src, "utf8");
      const config = await loadConfig(cwd);
      const html = await buildHtml(md, config);
      await writeFile(out, html, "utf8");
      const now = new Date().toISOString().slice(11, 19);
      console.log(`✓ rebuilt at ${now} (${Date.now() - t}ms)`);
    } catch (err) {
      console.error(`✗ build failed: ${err.message}`);
    }
  }

  await doBuild();
  console.log(`Watching ${src} (Ctrl-C to stop)`);

  let timer = null;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(doBuild, 150); };

  const watchers = [];
  const srcDir = dirname(src);
  const srcBase = basename(src);
  watchers.push(fsWatch(srcDir, (_, fn) => { if (!fn || fn === srcBase) debounced(); }));

  if (existsSync(configPath)) {
    const configDir = dirname(configPath);
    const configBase = basename(configPath);
    watchers.push(fsWatch(configDir, (_, fn) => { if (!fn || fn === configBase) debounced(); }));
  }

  process.on("SIGINT", () => {
    watchers.forEach(w => w.close());
    console.log("\n✓ stopped");
    process.exit(0);
  });
}

async function cmdCheck() {
  const cwd = process.cwd();
  const src = flag("src", resolve(cwd, "PROGRESS.md"));
  if (!existsSync(src)) {
    console.error(`✗ source not found: ${src}`);
    process.exit(1);
  }
  const md = await readFile(src, "utf8");
  const config = await loadConfig(cwd);
  const doc = parseProgressMarkdown(md, { lanes: config.lanes });
  const findings = runChecks(doc);

  if (findings.length === 0) {
    console.log("\x1b[32m✓ All checks pass — ready to share with founders.\x1b[0m");
    return;
  }

  const buckets = { BLOCKER: [], FIX: [], POLISH: [] };
  for (const f of findings) buckets[f.severity].push(f);

  // ANSI: red for BLOCKER, yellow for FIX, dim/grey for POLISH.
  // We respect NO_COLOR / non-TTY so CI logs stay clean.
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red    = (s) => c("31", s);
  const yellow = (s) => c("33", s);
  const dim    = (s) => c("2",  s);

  const print = (label, items, paint) => {
    if (items.length === 0) return;
    console.log(`\n${paint(label)} (${items.length})`);
    for (const f of items) {
      const prefix = f.phase ? `[${f.phase}] ` : "";
      console.log(`  ${paint("•")} ${prefix}${f.message}`);
    }
  };

  print("❌ BLOCKER", buckets.BLOCKER, red);
  print("⚠ FIX",     buckets.FIX,     yellow);
  print("→ POLISH",  buckets.POLISH,  dim);

  console.log(
    `\n${buckets.BLOCKER.length} blocker(s), ${buckets.FIX.length} fix(es), ${buckets.POLISH.length} polish.`
  );

  if (buckets.BLOCKER.length > 0) process.exit(1);
}

function cmdHelp() {
  console.log(`ceo-report — turn PROGRESS.md into an editorial build log.

  ceo-report init                Scaffold PROGRESS.md + config + CLAUDE.md + GH Action
  ceo-report build               Build progress.html from PROGRESS.md in CWD
    --src <path>                  Source PROGRESS.md (default: ./PROGRESS.md)
    --out <path>                  Output HTML (default: ./progress.html)
    --config <path>               Config file (default: ./buildlog.config.mjs)

  ceo-report watch               Rebuild progress.html on every change to PROGRESS.md
    --src <path>                  Source PROGRESS.md (default: ./PROGRESS.md)
    --out <path>                  Output HTML (default: ./progress.html)
    --config <path>               Config file (default: ./buildlog.config.mjs)

  ceo-report check               Lint PROGRESS.md for missing Targets, orphan deps, etc.
    --src <path>                  Source PROGRESS.md (default: ./PROGRESS.md)
    --config <path>               Config file (default: ./buildlog.config.mjs)

  ceo-report --help              Show this help`);
}

try {
  if (cmd === "build") await cmdBuild();
  else if (cmd === "init") await cmdInit();
  else if (cmd === "watch") await cmdWatch();
  else if (cmd === "check") await cmdCheck();
  else cmdHelp();
} catch (err) {
  console.error("✗", err.message);
  process.exit(1);
}
