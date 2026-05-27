#!/usr/bin/env node
// packages/ceo-progress-report/bin/cli.mjs
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHtml } from "../src/index.mjs";

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

function cmdHelp() {
  console.log(`ceo-report — turn PROGRESS.md into an editorial build log.

  ceo-report init                Scaffold PROGRESS.md + config + CLAUDE.md + GH Action
  ceo-report build               Build progress.html from PROGRESS.md in CWD
    --src <path>                  Source PROGRESS.md (default: ./PROGRESS.md)
    --out <path>                  Output HTML (default: ./progress.html)
    --config <path>               Config file (default: ./buildlog.config.mjs)

  ceo-report --help              Show this help`);
}

try {
  if (cmd === "build") await cmdBuild();
  else if (cmd === "init") await cmdInit();
  else cmdHelp();
} catch (err) {
  console.error("✗", err.message);
  process.exit(1);
}
