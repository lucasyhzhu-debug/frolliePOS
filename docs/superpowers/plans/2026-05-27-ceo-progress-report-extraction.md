# CEO Progress Report — Extraction Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the PROGRESS.md → progress.html renderer from `scripts/build-progress-html.mjs` into a standalone npm package + Claude Code plugin (`ceo-progress-report`), submittable to the community marketplace.

**Architecture:** Lift-and-shift the working ~1500-line renderer into a clean module layout (parse → compute → render, with helpers + CSS extracted). Wrap with a 4-command CLI (`init`, `build`). Bundle as a Claude Code plugin with 2 skills (`buildlog-author`, `buildlog-review`) that ship the writing-discipline IP and 2 slash commands (`build`, `init`) that wrap the CLI. The defensible differentiator is the voice/hierarchy skill prompts, not the renderer.

**Tech Stack:** Node.js 18+ ESM, zero runtime deps (pure stdlib). Plugin spec per `code.claude.com/docs/en/plugins-reference.md` — `.claude-plugin/plugin.json` manifest, `skills/<name>/SKILL.md` skills, `commands/<name>.md` slash commands.

---

## Pre-flight: decisions locked in advance

All open questions from the draft are resolved. Executor does NOT pause to ask:

| # | Decision | Resolution |
|---|---|---|
| 1 | Default lane labels | Keep Frollie's `Backend / Frontend / Cross-cutting` → `be/fe/xc`. Configurable via `lanes` arg to `parseProgressMarkdown` and `buildlog.config.mjs`. |
| 2 | Default theme | Ship Frollie palette (paper + stamp-red + seal-teal + Cormorant Garamond). It IS the differentiator. |
| 3 | Monogram | Derive from `config.title[0]` uppercase. If `config.monogram === false`, skip rendering the monogram element. |
| 4 | CSS strategy | Extract to `src/theme/default.css`. Read at render time, inline into `<style>` block. Zero external file dependency in output. |
| 5 | Plugin command namespacing | Accept `/ceo-progress-report:build` etc. — that's the spec; no aliases supported. |
| 6 | CLI surface (MVP) | `init` + `build` only. `watch` and `check` deferred to v0.2. |
| 7 | Config file location | Project root: `./buildlog.config.mjs`. Optional — sensible defaults work without it. |
| 8 | License | MIT. |
| 9 | Repo split | Stay in `packages/ceo-progress-report/` inside Frollie repo for this plan. Spin out via `git subtree split` AS A SEPARATE TASK after this plan ships. |
| 10 | Frollie migration | Out of scope. `scripts/build-progress-html.mjs` stays as-is. Migrate Frollie to the published package after v0.3 ships. |

---

## File structure (deliverable surface)

```
packages/ceo-progress-report/
├── .claude-plugin/
│   └── plugin.json                         # Plugin manifest
├── bin/
│   └── cli.mjs                             # CLI: init, build
├── commands/
│   ├── build.md                            # /ceo-progress-report:build
│   └── init.md                             # /ceo-progress-report:init
├── docs/
│   ├── SCHEMA.md                           # PROGRESS.md format contract
│   └── VOICE.md                            # The writing discipline
├── examples/
│   └── frollie-pos-PROGRESS.md             # Copy of live Frollie file for golden diff
├── skills/
│   ├── buildlog-author/
│   │   └── SKILL.md                        # Writing-discipline skill
│   └── buildlog-review/
│       └── SKILL.md                        # CEO-eye review skill
├── src/
│   ├── compute.mjs                         # Stats, % complete, critical path
│   ├── helpers.mjs                         # escapeHtml, renderInline, formatters [EXISTS]
│   ├── index.mjs                           # Public API entry: buildHtml(md, config)
│   ├── parse.mjs                           # PROGRESS.md → doc [EXISTS]
│   ├── render.mjs                          # All render functions + renderPage
│   └── theme/
│       └── default.css                     # The newspaper theme (extracted from inline <style>)
├── templates/
│   ├── PROGRESS.md                         # Starter template (used by `init`)
│   ├── buildlog.config.mjs                 # Empty config showing all knobs
│   ├── CLAUDE.md                           # Agent-instructions file
│   └── .github/
│       └── workflows/
│           └── ceo-report.yml              # GH Action: build + publish on push
├── LICENSE                                  # MIT
├── README.md                                # 60-second start
└── package.json                            # [EXISTS]
```

**Already created** (Phase 0, before this plan): `package.json`, `src/helpers.mjs`, `src/parse.mjs`, the directory scaffold.

---

## Phase A — Finish renderer + CLI extraction

**Outcome:** Running `node packages/ceo-progress-report/bin/cli.mjs build --src examples/frollie-pos-PROGRESS.md --out /tmp/cpr-test.html` produces a valid HTML file.

**Tool-call budget:** 18 calls (was 14; bumped after splitting A3 into 7 sub-steps per staffreview Improvement 1). Stop and reassess if exceeded.

### A1: Extract `src/compute.mjs`

**Files:**
- Create: `packages/ceo-progress-report/src/compute.mjs`
- Source: `scripts/build-progress-html.mjs:280-380` (the `computeStats` + `extractShippedDate` functions)

- [ ] **Step 1:** Read `scripts/build-progress-html.mjs` lines 280-380 to confirm the current `computeStats` shape.
- [ ] **Step 2:** Write `packages/ceo-progress-report/src/compute.mjs` exporting `computeStats(doc)` and `extractShippedDate(shippedLine)`. Pure functions; copy verbatim from source. Add ESM `export` keyword to each.
- [ ] **Step 3:** Run `node -e "import('./packages/ceo-progress-report/src/compute.mjs').then(m => console.log(Object.keys(m)))"`. Expected output: `[ 'computeStats', 'extractShippedDate' ]`.

### A2: Extract `src/theme/default.css`

**Files:**
- Create: `packages/ceo-progress-report/src/theme/default.css`
- Source: `scripts/build-progress-html.mjs` — the inline CSS inside the template literal in `renderPage`, between `<style>` and `</style>`

- [ ] **Step 1:** Locate the CSS block in `renderPage` (currently lines ~720-895 of the build script). Copy verbatim into `default.css`.
- [ ] **Step 2:** Remove the leading `<style>` and trailing `</style>` tags from the extracted CSS file (CSS file does not contain them; they're added by the renderer when inlining).
- [ ] **Step 3:** Verify CSS validity: `node -e "console.log(require('fs').readFileSync('packages/ceo-progress-report/src/theme/default.css','utf8').length, 'chars')"`. Expected: > 8000 chars.

### A3: Extract `src/render.mjs` (split into 7 small steps per staffreview Improvement 1)

**Files:**
- Create: `packages/ceo-progress-report/src/render.mjs`
- Source: `scripts/build-progress-html.mjs:398-700` (render functions: `renderStatusStrip`, `renderComingNext`, `renderDesk`, `renderChecklist`, `renderMilestoneLadder`, `renderSeal`, `renderEtaPill`, `renderRisks`, `renderLedgerTask`, `renderLanesForPhase`, `renderBuildTeam`, `renderCriticalPath`, `renderPage`)

- [ ] **A3.1 — Copy verbatim with export keywords**

  Read source lines 398-700 of `scripts/build-progress-html.mjs`. Copy them verbatim into `packages/ceo-progress-report/src/render.mjs`. Add `export` keyword to each top-level function declaration (every `function renderX(...)` becomes `export function renderX(...)`).

  Verify: file written, all 13 render functions present.

- [ ] **A3.2 — Add imports + path setup at top of file**

  Insert at the very top of `src/render.mjs` (before the function declarations):

  ```js
  import { readFile } from "node:fs/promises";
  import { fileURLToPath } from "node:url";
  import { resolve, dirname } from "node:path";
  import {
    escapeHtml, renderInline, numberWord, romanNumeral,
    formatLongDate, formatStampDate, formatHumanDate,
    formatShippedShort, formatTarget, relativeDaysAgo,
  } from "./helpers.mjs";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const DEFAULT_CSS_PATH = resolve(__dirname, "theme/default.css");
  ```

- [ ] **A3.3 — Change `renderPage` signature to async + config-aware**

  Find the current declaration:
  ```js
  function renderPage(doc, generatedAt) {
  ```

  Replace with:
  ```js
  export async function renderPage(doc, generatedAt, config = {}) {
    const {
      title = "Project",
      subtitle = "The Build Log.",
      monogram: monogramConfig,
      location = "",
      v1Label = "v1.0",
      cssPath = DEFAULT_CSS_PATH,
    } = config;
    const safeTitle = title || "Project";  // Refinement 2: guard against empty title
    const monogramLetter = monogramConfig === false
      ? null
      : (monogramConfig || safeTitle[0].toUpperCase());
    const css = await readFile(cssPath, "utf8");
  ```

  (The existing first line of the function body, which currently destructures `g`, `now`, `stampDate`, etc., stays — just append it below the new code.)

- [ ] **A3.4 — Swap 6 hardcoded Frollie strings in the masthead + caption HTML**

  Inside `renderPage`'s return template literal, find and replace exactly:

  | Find | Replace with |
  |---|---|
  | `Frollie POS<em>` (in `<h1 class="masthead-title">`) | `${escapeHtml(safeTitle)}<em>` |
  | `>The Build Log.</em>` (closing `em` of masthead-title) | `>${escapeHtml(subtitle)}</em>` |
  | `<span class="monogram-letter">F</span>` | `<span class="monogram-letter">${monogramLetter}</span>` |
  | `>Frollie · Build Log<` (inside `monogram-arc-top`) | `>${escapeHtml(safeTitle)} · Build Log<` |
  | `<div>Jakarta</div>` (inside `stamp` div) | `<div>${escapeHtml(location)}</div>` |
  | `to <em>v1.0</em>` (inside `percent-caption`) | `to <em>${escapeHtml(v1Label)}</em>` |

  Each replacement must be unique — if a match is non-unique, surface and add more context before replacing.

- [ ] **A3.5 — Inline CSS via file read instead of embedded template-literal block**

  Inside `renderPage`'s return template, locate the `<style>` block (between `<head>` and `</head>`). It currently contains the entire CSS as a multi-line template literal.

  Replace the entire CSS content between `<style>` and `</style>` with: `${css}`.

  Result: `<style>${css}</style>`. The CSS variable was assigned in A3.3 from `await readFile(cssPath, ...)`.

- [ ] **A3.6 — Make `.monogram` div conditional on `monogramLetter`**

  Find the masthead block:
  ```html
  <div class="monogram" aria-hidden="true">
    <span class="monogram-arc monogram-arc-top">${escapeHtml(safeTitle)} · Build Log</span>
    <span class="monogram-letter">${monogramLetter}</span>
  </div>
  ```

  Wrap with a conditional:
  ```js
  ${monogramLetter ? `<div class="monogram" aria-hidden="true">
    <span class="monogram-arc monogram-arc-top">${escapeHtml(safeTitle)} · Build Log</span>
    <span class="monogram-letter">${monogramLetter}</span>
  </div>` : ""}
  ```

  When `monogramLetter` is `null` (because `config.monogram === false`), the entire div is omitted from output. CSS grid in `.masthead` still works with 2 columns instead of 3 due to `grid-template-columns: auto 1fr auto` collapsing the absent first column.

- [ ] **A3.7 — Smoke import to confirm parse + exports**

  Run:
  ```bash
  node -e "import('./packages/ceo-progress-report/src/render.mjs').then(m => console.log(Object.keys(m).filter(k => k.startsWith('render'))))"
  ```

  Expected output: array including `renderPage`, `renderStatusStrip`, `renderComingNext`, `renderDesk`, `renderMilestoneLadder`, `renderRisks`, `renderBuildTeam`.

  If module import throws: most likely a syntax error introduced during A3.3-A3.6. Re-read the file, find the unbalanced bracket or stray template-literal close, fix, re-run.

### A4: Write `src/index.mjs` (public API)

**Files:**
- Create: `packages/ceo-progress-report/src/index.mjs`

- [ ] **Step 1:** Write the entry point:
  ```js
  // packages/ceo-progress-report/src/index.mjs
  import { parseProgressMarkdown } from "./parse.mjs";
  import { computeStats } from "./compute.mjs";
  import { renderPage } from "./render.mjs";

  export { parseProgressMarkdown, computeStats, renderPage };

  export async function buildHtml(md, config = {}) {
    const parsed = parseProgressMarkdown(md, { lanes: config.lanes });
    const doc = computeStats(parsed);
    const generatedAt = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
    return await renderPage(doc, generatedAt, config);
  }
  ```
- [ ] **Step 2:** Smoke-import: `node -e "import('./packages/ceo-progress-report/src/index.mjs').then(m => console.log('exports:', Object.keys(m)))"`. Expected: `[ 'parseProgressMarkdown', 'computeStats', 'renderPage', 'buildHtml' ]`.

### A5: Write `bin/cli.mjs`

**Files:**
- Create: `packages/ceo-progress-report/bin/cli.mjs`

- [ ] **Step 1:** Write the CLI:
  ```js
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
    return i >= 0 ? args[i + 1] : fallback;
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
  ```
- [ ] **Step 2:** Make executable (no-op on Windows but harmless): `chmod +x packages/ceo-progress-report/bin/cli.mjs 2>/dev/null || true`.
- [ ] **Step 3:** Run help: `node packages/ceo-progress-report/bin/cli.mjs --help`. Expected: prints usage block including `ceo-report init`, `ceo-report build`.

### Phase A verification gate

- [ ] **Gate A.1:** Copy Frollie PROGRESS.md into examples: `mkdir -p packages/ceo-progress-report/examples && cp docs/PROGRESS.md packages/ceo-progress-report/examples/frollie-pos-PROGRESS.md`.
- [ ] **Gate A.2:** Build it: `node packages/ceo-progress-report/bin/cli.mjs build --src packages/ceo-progress-report/examples/frollie-pos-PROGRESS.md --out /tmp/cpr-test.html`. Expected output: `✓ wrote /tmp/cpr-test.html`.
- [ ] **Gate A.3:** Verify HTML emits and is non-trivial: `node -e "const fs=require('fs');const html=fs.readFileSync('/tmp/cpr-test.html','utf8');console.log('size:',html.length,'has_status_strip:',html.includes('status-strip'),'has_coming_next:',html.includes('coming-next'),'has_ladder:',html.includes('milestone-section'));"`. Expected: size > 100000, all three booleans `true`.

**If Phase A gate fails:** stop, diagnose, fix before continuing. Common failures: missing `import` in render.mjs, config not threaded through to `renderPage`, CSS path resolution wrong on Windows.

---

## Phase B — Golden-diff verification (catches extraction regressions BEFORE building more)

**Outcome:** The OSS-package-built HTML is structurally identical to the in-tree script's output for the same Frollie PROGRESS.md.

**Tool-call budget:** 4 calls.

Why this phase comes before templates/skills/docs: if the renderer regressed during extraction, building docs on top of a broken renderer is wasted work. Verify the renderer first.

### B1: Build both outputs

- [ ] **Step 1:** Rebuild the canonical in-tree output: `node scripts/build-progress-html.mjs`. Expected: `✓ wrote D:\Claude\FrolliePOS\docs\progress.html`.
- [ ] **Step 2:** Build the package output: `node packages/ceo-progress-report/bin/cli.mjs build --src docs/PROGRESS.md --out /tmp/cpr-diff.html`. Expected: `✓ wrote /tmp/cpr-diff.html`.

### B2: Diff with tolerance for known-differences

- [ ] **Step 1:** Run the structured diff:
  ```bash
  node -e "
    const fs=require('fs');
    const a=fs.readFileSync('docs/progress.html','utf8').replace(/generated-at=\"[^\"]+\"/,'GEN').replace(/>2026-[\d-]+ [\d:Z]+</g,'>GEN<');
    const b=fs.readFileSync('/tmp/cpr-diff.html','utf8').replace(/generated-at=\"[^\"]+\"/,'GEN').replace(/>2026-[\d-]+ [\d:Z]+</g,'>GEN<');
    if(a===b){console.log('✓ IDENTICAL');process.exit(0);}
    const aLines=a.split('\n');const bLines=b.split('\n');
    console.log('LINE COUNT a:',aLines.length,'b:',bLines.length);
    let diffs=0;
    for(let i=0;i<Math.max(aLines.length,bLines.length);i++){
      if(aLines[i]!==bLines[i]){
        diffs++;
        if(diffs<=10){console.log('line',i+1);console.log('  a:',(aLines[i]||'').slice(0,200));console.log('  b:',(bLines[i]||'').slice(0,200));}
      }
    }
    console.log('total diffs:',diffs);
    process.exit(diffs>30?1:0);
  "
  ```
- [ ] **Step 2:** Interpret the result:
  - `✓ IDENTICAL` → proceed to Phase C.
  - Up to 30 line-level diffs that are all `>2026-...` timestamps or `generated-at` attributes → ignore and proceed (the regex strips them but if the regex misses a format variant, the diff catches it).
  - **Any structural diff** (e.g., a class missing, a div boundary moved, content reordered) → STOP. Fix the render.mjs extraction. Likely cause: missed a parameterisation or import.

**Phase B verification gate:** the diff loop reports a defensible outcome (identical OR diff explainable by config-defaults). If structural diff appears, do NOT proceed.

---

## Phase C — Templates

**Outcome:** `npx ceo-report init` (run from an empty directory) produces a working starter that builds cleanly.

**Tool-call budget:** 8 calls.

### C1: Write `templates/PROGRESS.md`

**Files:**
- Create: `packages/ceo-progress-report/templates/PROGRESS.md`

- [ ] **Step 1:** Write the starter PROGRESS.md. Must include:
  - `# Progress` H1
  - `**Mission.**` line — "Replace this with one sentence about why this project exists."
  - **Three phases minimum**, each demonstrating one status:
    - `## v0.1 — first slice ✅ SHIPPED` — `**Outcome:**` + `**Merged:**` line + `**You can:**` + `**You still can't:**` blocks + 1 lane with 1 ✅ legacy task
    - `## v0.2 — next slice 📋 PLANNED (next up)` — `**Outcome:**` + `**Target:** TBD` + `**You'll be able to:**` + `**Still not yet:**` + 2 lanes with 2 📋 addressable tasks (showing the metadata block: agent, deps, docs, subtasks, notes)
    - `## v1.0 — launch 🗂️ BACKLOG` — `**Outcome:**` + `**Target:** TBD` + `**You'll be able to:**` + `**Still not yet:**`
  - `## Risks under watch` section with 2 example risks (one with `**Title** — body`, one body-only)
  - `## Decisions awaiting the CTO` section with 1 active decision + 1 resolved (`~~**old question**~~ — **RESOLVED 2026-01-15**: chose option A.`)
  - `## How to read this file` section with the metadata schema reference and refusal rules
- [ ] **Step 2:** Verify build: `node packages/ceo-progress-report/bin/cli.mjs build --src packages/ceo-progress-report/templates/PROGRESS.md --out /tmp/cpr-template.html`. Expected: `✓ wrote /tmp/cpr-template.html`.
- [ ] **Step 3:** Sanity-check: `node -e "const html=require('fs').readFileSync('/tmp/cpr-template.html','utf8');console.log('size:',html.length,'has_three_phases:',(html.match(/class=\"rung/g)||[]).length>=3,'has_decision:',html.includes('desk-card'),'has_resolved:',html.includes('desk-resolved'));"`. Expected: size > 40000, all booleans `true`.

### C2: Write `templates/buildlog.config.mjs`

**Files:**
- Create: `packages/ceo-progress-report/templates/buildlog.config.mjs`

- [ ] **Step 1:** Write the empty-defaults config:
  ```js
  // buildlog.config.mjs — all values optional; sensible defaults apply.
  // Override only what you want to change.

  export default {
    // The big title in the masthead
    title: "Your Project",

    // Italic subtitle under the title
    subtitle: "The Build Log.",

    // Monogram letter in the masthead circle.
    // - String: that letter is used.
    // - Omitted: derived from title[0] uppercase.
    // - false: monogram hidden entirely.
    monogram: undefined,

    // City stamp in the masthead (right side)
    location: "",

    // The version label that anchors "% of the road to ___"
    v1Label: "v1.0",

    // Lane labels in your PROGRESS.md → internal slug used in Task IDs.
    // Default below matches the convention from the original Frollie POS build log.
    lanes: {
      Backend: "be",
      Frontend: "fe",
      "Cross-cutting": "xc",
    },
  };
  ```

### C3: Write `templates/CLAUDE.md`

**Files:**
- Create: `packages/ceo-progress-report/templates/CLAUDE.md`

- [ ] **Step 1:** Write a minimal CLAUDE.md that any project can drop in:
  ```markdown
  # Project context for AI agents

  ## Build log
  This project uses **CEO Progress Report** for its roadmap.
  - Source of truth: `PROGRESS.md`
  - Rendered HTML: `progress.html` (regenerated from the markdown)
  - Build command: `npx ceo-report build`

  ## Refusal conditions when editing PROGRESS.md
  - Do not edit `progress.html` directly — it's regenerated.
  - Do not delete a resolved decision — they are institutional memory; keep them in `~~strikethrough~~ — **RESOLVED YYYY-MM-DD**: ...` form.
  - Do not surface engineering metrics (task counts, dependency chains) in the phase-level Outcome or "You'll be able to" bullets.
  - Do not change a phase status without also updating the `**Target:**` line if applicable.

  ## Voice discipline
  Every phase needs:
  - `**Outcome:**` — one sentence in user-action voice, not engineer voice.
  - `**Target:** YYYY-MM-DD` (or `TBD`) — date the phase ships.
  - `**You'll be able to:**` — 4-8 user-readable bullets, each starting with a verb the reader would say aloud.
  - `**Still not yet:**` — 2-6 bullets naming what's deferred to which future version.

  See the `buildlog-author` skill for full guidance.
  ```

### C4: Write `templates/.github/workflows/ceo-report.yml`

**Files:**
- Create: `packages/ceo-progress-report/templates/.github/workflows/ceo-report.yml`

- [ ] **Step 1:** Write the GH Action:
  ```yaml
  name: Build & publish CEO Progress Report

  on:
    push:
      branches: [main]
    workflow_dispatch:

  permissions:
    contents: read
    pages: write
    id-token: write

  concurrency:
    group: "pages"
    cancel-in-progress: false

  jobs:
    build:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: "20"
        - name: Install ceo-progress-report
          run: npm install --no-save ceo-progress-report
        - name: Build progress.html
          run: npx ceo-report build --src PROGRESS.md --out _site/index.html
        - name: Copy any static assets
          run: |
            mkdir -p _site
            cp -r assets _site/ 2>/dev/null || true
        - uses: actions/upload-pages-artifact@v3
          with:
            path: _site

    deploy:
      needs: build
      runs-on: ubuntu-latest
      environment:
        name: github-pages
        url: ${{ steps.deployment.outputs.page_url }}
      steps:
        - id: deployment
          uses: actions/deploy-pages@v4
  ```

### Phase C verification gate

- [ ] **Gate C.1:** Simulate `init` against a temp directory: `mkdir -p /tmp/cpr-init-test && (cd /tmp/cpr-init-test && node "$PWD/../../d/Claude/FrolliePOS/packages/ceo-progress-report/bin/cli.mjs" init)`.

  Windows note: the relative path above won't work on PowerShell. Use instead:
  ```bash
  rm -rf /tmp/cpr-init-test && mkdir -p /tmp/cpr-init-test && cd /tmp/cpr-init-test && node /d/Claude/FrolliePOS/packages/ceo-progress-report/bin/cli.mjs init
  ```
  (If `/d/Claude/...` mount path doesn't resolve, use the absolute Windows path via the Bash tool's path mapping.)

  Expected: 4 `✓ wrote ...` lines for PROGRESS.md, buildlog.config.mjs, CLAUDE.md, .github/workflows/ceo-report.yml.

- [ ] **Gate C.2:** Build from the init'd directory: `cd /tmp/cpr-init-test && node /d/Claude/FrolliePOS/packages/ceo-progress-report/bin/cli.mjs build`. Expected: `✓ wrote /tmp/cpr-init-test/progress.html`.

- [ ] **Gate C.3:** Sanity-check the init-built HTML: `node -e "const html=require('fs').readFileSync('/tmp/cpr-init-test/progress.html','utf8');console.log('size:',html.length,'monogram_derived:',html.includes('>Y<'));"`. Expected: size > 30000, `monogram_derived: true` (because `templates/buildlog.config.mjs` has `title: \"Your Project\"` and the monogram should derive to `Y`).

---

## Phase D — Skills (the actual IP)

**Outcome:** Two skill markdown files that a Claude Code user activates to get the writing discipline and the CEO-eye review.

**Tool-call budget:** 4 calls.

### D1: Write `skills/buildlog-author/SKILL.md`

**Files:**
- Create: `packages/ceo-progress-report/skills/buildlog-author/SKILL.md`

- [ ] **Step 1:** Write the skill with frontmatter (per Claude Code skill spec) + directives + refusal conditions + 2 worked examples (bad-then-good). Use the structure below:
  ```markdown
  ---
  name: buildlog-author
  description: Use when authoring or editing PROGRESS.md in a project that uses ceo-progress-report. Enforces CEO-readable voice — outcomes in user-action voice, "You'll be able to" / "Still not yet" framing, Target lines, decision resolution markers. Triggers on phrases like "add a phase to PROGRESS.md", "rewrite this outcome", "translate scope into a phase block".
  ---

  # Buildlog Author

  You're authoring PROGRESS.md for a project that uses **ceo-progress-report**. The reader is non-technical, time-constrained, and decision-loaded. They open the rendered HTML weekly to check the build. Your job is to make every phase scannable in 30 seconds.

  ## Core directives

  1. **One-sentence outcome in user-action voice.** "Staff take a sale and accept QRIS payment" — not "Implement payment service with idempotency wrapper". Outcomes name what the user can DO, not what the engineer must BUILD.

  2. **"You'll be able to:" 4-8 bullets, each starting with a verb the reader would say aloud.** "Build a cart with items and quantities" — not "Cart builder UI with line-item add/remove". Bullets ≤ 18 words.

  3. **"Still not yet:" 2-6 bullets naming what's deferred and to which version.** "Issue refunds (v0.5)" — making scope cuts feel like roadmap, not omission.

  4. **`**Target:**` lines use the format `YYYY-MM-DD` (or `Mon DD YYYY`, or just `MMM YYYY`).** Exact placeholder: `**Target:** TBD`. Never mix a date with TBD. Never use prose like "sometime in June".

  5. **For shipped phases, omit `**Target:**`** — the renderer derives the date from the `Merged YYYY-MM-DD` line.

  6. **Decisions resolve via the exact pattern:** `- ~~**Original question**~~ — **RESOLVED YYYY-MM-DD**: what was chosen.` Never delete a resolved decision — it becomes the project's institutional memory and renders in a calm sub-section.

  7. **Lane labels are project-defined but must be 2-5 chars** when used as the middle segment of Task IDs (`vXX-be-something`). Use the labels from the project's `buildlog.config.mjs`.

  8. **Phase status emoji is canonical** — ✅ done · 🔄 in-progress · 📋 planned · 🗂️ backlog. Don't invent new emoji.

  ## Refusal conditions

  Do NOT:
  - Surface engineering metrics (task counts, deps, SHAs) in the phase-level Outcome or "You'll be able to" bullets.
  - Write outcomes that name files, functions, or libraries.
  - Write bullets longer than 18 words.
  - Use markdown H4 or deeper headers inside a phase block.
  - Edit `progress.html` directly — it's regenerated by `npx ceo-report build`.
  - Delete a resolved decision.

  ## Worked examples

  ### Example 1 — Outcome rewrite

  **Engineer voice (rejected):**
  > **Outcome:** Implement Xendit Invoice API integration with webhook + polling fallback + idempotency wrapper.

  **CEO voice (accepted):**
  > **Outcome:** Staff take a sale and accept QRIS or BCA VA payment, with retries that don't double-charge.

  ### Example 2 — Phase block with both lists

  ```markdown
  ## v0.3 — sale flow + Xendit 📋 PLANNED (next up)
  **Outcome:** Staff take a sale and accept QRIS or BCA VA payment, with retries that don't double-charge.
  **Target:** 29 May 2026

  **You'll be able to:**
  - Build a cart with items + quantities, see live totals
  - Charge via QRIS scan or BCA Virtual Account
  - Auto-confirm via webhook or polling — staff never wait wondering if it worked
  - Save sales as drafts (offline too) and resume them later
  - Sell at zero stock — flagged for later manager review

  **Still not yet:**
  - Issue refunds (v0.5)
  - Approve manager actions remotely (v0.4)
  - Manage staff/products in-app (v0.5)
  - See receipts, history, dashboard (v0.5)
  ```
  ```

### D2: Write `skills/buildlog-review/SKILL.md`

**Files:**
- Create: `packages/ceo-progress-report/skills/buildlog-review/SKILL.md`

- [ ] **Step 1:** Write the review skill:
  ```markdown
  ---
  name: buildlog-review
  description: Use when reviewing a PROGRESS.md for CEO-readability before sharing it with founders/board/non-technical stakeholders. Triggers on "review my PROGRESS.md as a CEO would", "is this ready to share with the founders", "what's missing for a CEO check-in", "audit my build log".
  ---

  # Buildlog Review — CEO-eye audit of PROGRESS.md

  Read PROGRESS.md as if you were the CEO/founder. Spend 30 seconds skimming; report what you couldn't answer.

  ## Per-phase questions

  For each phase, ask:
  - Can I tell what unlocks? → `**You'll be able to:**` exists and bullets are user-readable
  - Can I tell what's deferred? → `**Still not yet:**` exists and names which version unlocks each item
  - Can I tell when? → `**Target:** YYYY-MM-DD` (or "TBD" only if genuinely unknown)
  - Can I tell the cost of cutting it? → Outcome is concrete enough to imagine the world without it

  ## Whole-document questions

  - What's the % to the v1 target? (count shipped phases / total phases — the renderer computes this)
  - What's blocked on the CEO's decision? (count of active items in `## Decisions awaiting the CTO`)
  - What's at risk? (`## Risks under watch` section freshness — anything older than 60 days probably stale)
  - When did anything last ship? (most recent `Merged YYYY-MM-DD` line)
  - Does any backlog phase still have `**Target:** TBD` when it shouldn't? (i.e., the team has an estimate but hasn't written it down)

  ## Output format

  Punch-list, severity-marked:

  - `❌ BLOCKER` — phase X has no Outcome / no You'll-be-able-to / no Target. The CEO literally can't read this phase.
  - `⚠ FIX` — phase Y's Target is TBD but the plan is written (i.e., team knows but hasn't said). Decision tagged "Resolved" but not in the `~~strikethrough~~ — **RESOLVED**` format. Bullet over 18 words.
  - `→ POLISH` — Outcome could be tighter. Risk body is 3 sentences (target: 1). Decision title could be sharper.

  If everything passes:
  - `✓ Ready to share with founders.`

  Don't pad with praise. Don't include positive findings — just gaps and fixes. Output 5-15 bullets max; if more, the document needs more work than a review can fix.
  ```

### Phase D verification gate

- [ ] **Gate D.1:** Verify both skill files exist and parse as valid markdown with frontmatter: `node -e "['buildlog-author','buildlog-review'].forEach(n=>{const p='packages/ceo-progress-report/skills/'+n+'/SKILL.md';const c=require('fs').readFileSync(p,'utf8');const fm=c.match(/^---\n([\s\S]+?)\n---/);console.log(n+':',fm?'frontmatter OK':'NO FRONTMATTER');console.log('  size:',c.length);});"`. Expected: both report `frontmatter OK` and size > 1500.

---

## Phase E — Plugin manifest + slash commands

**Outcome:** A `.claude-plugin/plugin.json` that passes `claude plugin validate` (if available) or manual schema review, plus two slash commands that wrap the CLI.

**Tool-call budget:** 4 calls.

### E1: Write `.claude-plugin/plugin.json`

**Files:**
- Create: `packages/ceo-progress-report/.claude-plugin/plugin.json`

- [ ] **Step 1:** Write the manifest:
  ```json
  {
    "name": "ceo-progress-report",
    "displayName": "CEO Progress Report",
    "version": "0.1.0",
    "description": "Turn PROGRESS.md into an editorial build-log dashboard your CEO will actually read. Ships writing-discipline skills + slash commands wrapping the npm CLI.",
    "author": {
      "name": "Lucas Zhu",
      "email": "lucas@malostudio.id"
    },
    "homepage": "https://github.com/lucasyhzhu-debug/ceo-progress-report",
    "repository": "https://github.com/lucasyhzhu-debug/ceo-progress-report",
    "license": "MIT",
    "keywords": [
      "roadmap",
      "progress",
      "dashboard",
      "ceo",
      "build-log",
      "writing-discipline",
      "markdown"
    ]
  }
  ```

### E2: Write `commands/build.md`

**Files:**
- Create: `packages/ceo-progress-report/commands/build.md`

- [ ] **Step 1:** Write the build command:
  ```markdown
  ---
  description: Build progress.html from PROGRESS.md using the CEO Progress Report renderer.
  ---

  The user is invoking the CEO Progress Report build command. Run the CLI to regenerate the rendered HTML.

  **Prerequisite:** the `ceo-progress-report` npm package must be installed in
  the project (or be available via `npx`). If neither, the first invocation
  will trigger an `npx` install — let it proceed; warn the user it may take a
  few seconds.

  1. Check that `PROGRESS.md` exists in the current working directory. If not, ask the user where it is (or suggest running `/ceo-progress-report:init` first).
  2. Run:
     ```bash
     npx ceo-report build
     ```
  3. Report the result. If the build succeeded (`✓ wrote ...`), tell the user to open the generated `progress.html` in a browser. If it failed, surface the error and suggest the most likely fix (missing config, malformed PROGRESS.md, package not installed, etc.).
  4. Do not edit PROGRESS.md or progress.html yourself — the user owns the source markdown; the HTML is generated.
  ```

### E3: Write `commands/init.md`

**Files:**
- Create: `packages/ceo-progress-report/commands/init.md`

- [ ] **Step 1:** Write the init command:
  ```markdown
  ---
  description: Scaffold a CEO Progress Report setup — PROGRESS.md, buildlog.config.mjs, CLAUDE.md, GH Action.
  ---

  The user is scaffolding CEO Progress Report in their project. Run the CLI to write the starter files.

  **Prerequisite:** the `ceo-progress-report` npm package must be installed in
  the project (or be available via `npx`). If neither, the first invocation
  will trigger an `npx` install — let it proceed; warn the user it may take a
  few seconds. If they prefer, they can install explicitly first with
  `npm install --save-dev ceo-progress-report`.

  1. Confirm with the user: "I'll create PROGRESS.md, buildlog.config.mjs, CLAUDE.md, and .github/workflows/ceo-report.yml in the current directory. Existing files will be skipped. Proceed?"
  2. On confirmation, run:
     ```bash
     npx ceo-report init
     ```
  3. Report which files were written and which were skipped.
  4. Suggest next steps:
     - Edit `PROGRESS.md` with their first phase (load the `buildlog-author` skill for voice guidance)
     - Update `buildlog.config.mjs` with their project title
     - Run `/ceo-progress-report:build` to render
     - Push to GitHub — the workflow will auto-publish to GitHub Pages
  ```

### Phase E verification gate

- [ ] **Gate E.1:** Validate manifest JSON: `node -e "const m=JSON.parse(require('fs').readFileSync('packages/ceo-progress-report/.claude-plugin/plugin.json','utf8'));['name','version','description'].forEach(k=>console.log(k+':',m[k]||'MISSING'));console.log('keywords:',m.keywords?.length);"`. Expected: name, version, description all present; keywords count >= 5.
- [ ] **Gate E.2:** Confirm both commands have frontmatter: `node -e "['build','init'].forEach(n=>{const c=require('fs').readFileSync('packages/ceo-progress-report/commands/'+n+'.md','utf8');console.log(n+':',c.startsWith('---\n')?'OK':'MISSING FRONTMATTER');});"`. Expected: both `OK`.

---

## Phase F — Documentation

**Outcome:** A first-time GitHub visitor reads README + can install + ship a build in under 60 seconds. Frollie's own docs link to the new package.

**Tool-call budget:** 8 calls (was 6; F5 added per staffreview §9).

### F1: Write `README.md`

**Files:**
- Create: `packages/ceo-progress-report/README.md`

- [ ] **Step 1:** Write the README. Sections in this order:
  1. **Pitch** (60 words) — what it is, who it's for, what makes it different ("the writing-discipline skills, not just the renderer").
  2. **Screenshot placeholder** — `![CEO Progress Report — Frollie POS edition](docs/screenshot.png)` (TODO: capture post-extraction; track as Open Follow-up #4).
  3. **Install (two surfaces — explicit per staffreview Improvement 2):**
     ```markdown
     ## Install

     CEO Progress Report ships in two distribution surfaces. Install **both** for the full integration, or **either alone** for partial use.

     ### npm package (always required for the renderer)
     ```bash
     npm install --save-dev ceo-progress-report
     npx ceo-report init                # scaffold PROGRESS.md + config + GH Action
     npx ceo-report build               # render PROGRESS.md → progress.html
     ```

     ### Claude Code plugin (optional — adds slash commands inside your editor)
     ```bash
     # In a Claude Code session:
     /plugin marketplace add anthropics/claude-plugins-community
     /plugin install ceo-progress-report@claude-community
     ```

     The plugin's slash commands (`/ceo-progress-report:build`, `:init`) wrap the
     npm CLI — they require the npm package to be installed in your project
     (the first `npx` invocation will install it if not present). The plugin
     also ships the two writing-discipline skills (`buildlog-author`,
     `buildlog-review`) which Claude will activate automatically when you
     author or review your PROGRESS.md.
     ```
  4. **60-second start** — three-line example: `npx ceo-report init && edit PROGRESS.md && npx ceo-report build && open progress.html`.
  5. **What's in the box** — bullet list: renderer, CLI, 2 skills, 2 slash commands, GH Action template, starter PROGRESS.md, optional config.
  6. **Schema reference** — link to `docs/SCHEMA.md`.
  7. **Voice reference** — link to `docs/VOICE.md` with one sentence about why the discipline matters.
  8. **License** — MIT.

### F2: Write `docs/SCHEMA.md`

**Files:**
- Create: `packages/ceo-progress-report/docs/SCHEMA.md`

- [ ] **Step 1:** Write the schema reference. Cover: phase header format (`## vX.Y — title <emoji> <statusLabel>`), Outcome / Target / Merged / You'll-be-able-to / Still-not-yet conventions, lane headers (`### Backend (...)`), addressable task format (`- 📋 **[vXX-be-name]** title` + indented metadata), legacy task format (`- ✅ no-id title`), risks section, decisions section + resolved-decision marker, status emoji legend. End with "If you change the format, update src/parse.mjs to match — the parser is the contract enforcer."

### F3: Write `docs/VOICE.md`

**Files:**
- Create: `packages/ceo-progress-report/docs/VOICE.md`

> **Authoring note** (per staffreview §7): VOICE.md is the document that earns the marketplace submission. If executing this plan via subagent-driven-development, dispatch this single phase to the `crafting-portfolio-essays` agent — it will produce voice-aware prose rather than generic doc-style copy. For inline execution, write it yourself in the same editorial voice used in this plan.

- [ ] **Step 1:** Write the voice doc. Readers should leave understanding WHY the format matters, not just WHAT it is. Sections:
  - "The problem with engineer-voice build logs" (2 paragraphs)
  - "The CEO question hierarchy" (the 4 per-phase questions + 4 whole-doc questions from the buildlog-review skill, expanded)
  - "Outcome statements" with 3 before/after examples
  - "The unlocks/deferred framing — why both lists matter" (1 paragraph)
  - "When to mark a decision resolved" (process + format)
  - "Targets vs deadlines" (1 paragraph — Target is a commitment, not a forecast)
  - "Why the renderer is opinionated" (1 paragraph defending the aesthetic and the layout choices)
  - **"How roadmap % is computed"** (per staffreview Refinement 1) — 1 paragraph documenting the unweighted-by-phase choice. Cover: simplest interpretation; treats v0.2.1 (architecture restructure) the same as v0.5 (largest phase); intentional default because weighted-by-scope requires effort estimates the build log doesn't currently capture; weighted variant available in v0.3 as an opt-in config knob if user demand surfaces.

### F4: Write `LICENSE`

**Files:**
- Create: `packages/ceo-progress-report/LICENSE`

- [ ] **Step 1:** Write MIT license text with `Copyright (c) 2026 Lucas Zhu`.

### F5: Update Frollie's own docs to point at the new package (per staffreview §9)

**Files:**
- Modify: `CLAUDE.md` (root, Frollie POS project file)
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1:** Add a one-line note to Frollie's root `CLAUDE.md` so future agents discover the package. Find the "File locations" section and add a bullet:
  ```markdown
  - `packages/ceo-progress-report/` — extracted PROGRESS.md → progress.html renderer + Claude Code plugin (publishable as standalone npm package). The Frollie POS build log uses `scripts/build-progress-html.mjs` directly until v0.3 ships, then migrates to this package.
  ```
  Insert it near the other top-level directory entries (after `archive/files.zip` or similar — pick a location that reads sensibly with the surrounding bullets).

- [ ] **Step 2:** Add a CHANGELOG entry. Find the top of `docs/CHANGELOG.md` (or create if missing) and prepend:
  ```markdown
  ## 2026-05-27 — Tooling: CEO Progress Report extraction

  - Extracted PROGRESS.md → progress.html renderer from `scripts/build-progress-html.mjs` into a standalone, installable package at `packages/ceo-progress-report/`.
  - Package bundles: Node CLI (`ceo-report init`, `ceo-report build`), Claude Code plugin with two skills (`buildlog-author`, `buildlog-review`) and two slash commands, starter templates, GH Action workflow.
  - Frollie POS continues using the in-tree script for v0.3 work; migration to the published package planned post-v0.3 (hard commitment — see plan Risks).
  - npm publish + Claude Code marketplace submission deferred to follow-up tasks.
  ```

### Phase F verification gate

- [ ] **Gate F.1:** Confirm all four files exist and are non-trivial: `node -e "['README.md','docs/SCHEMA.md','docs/VOICE.md','LICENSE'].forEach(p=>{const c=require('fs').readFileSync('packages/ceo-progress-report/'+p,'utf8');console.log(p+':',c.length,'chars');});"`. Expected: README > 1500, SCHEMA > 2500, VOICE > 2500, LICENSE > 1000.
- [ ] **Gate F.2:** No broken internal links: `node -e "const fs=require('fs');['README.md','docs/SCHEMA.md','docs/VOICE.md'].forEach(p=>{const c=fs.readFileSync('packages/ceo-progress-report/'+p,'utf8');const links=[...c.matchAll(/\]\((\.\/[^)]+)\)/g)].map(m=>m[1]);links.forEach(l=>{const target='packages/ceo-progress-report/'+l;if(!fs.existsSync(target))console.log('BROKEN in',p,'→',l);});});console.log('done');"`. Expected: only `done`, no `BROKEN`.

---

## Phase G — Final integration test + commit

**Outcome:** A single commit on the current branch lays down all of the above; the working tree is clean.

**Tool-call budget:** 5 calls.

### G1: Re-run the full golden diff one more time

- [ ] **Step 1:** `node packages/ceo-progress-report/bin/cli.mjs build --src docs/PROGRESS.md --out /tmp/cpr-final.html && node scripts/build-progress-html.mjs && node -e "const a=require('fs').readFileSync('docs/progress.html','utf8').replace(/generated-at=\"[^\"]+\"/,'GEN').replace(/>2026-[\d-]+ [\d:Z]+</g,'>GEN<');const b=require('fs').readFileSync('/tmp/cpr-final.html','utf8').replace(/generated-at=\"[^\"]+\"/,'GEN').replace(/>2026-[\d-]+ [\d:Z]+</g,'>GEN<');console.log(a===b?'✓ IDENTICAL':'✗ DIFF: '+a.split('\\n').filter((l,i)=>l!==b.split('\\n')[i]).length+' lines');"`. Expected: `✓ IDENTICAL`. If not, fix before committing.

### G2: STOP — human review checkpoint

- [ ] **Step 1:** Pause and report to the user:
  - Files created (paths + sizes)
  - Phase A-F gate results
  - Golden-diff final result
  - Any decisions made during execution that deviated from the plan
- [ ] **Step 2:** Wait for user "ship it" or "amend X first" before proceeding to G3.

### G3: Commit

- [ ] **Step 1:** Verify git status: `git status --short packages/ceo-progress-report docs/superpowers/plans/ docs/reviews/ CLAUDE.md docs/CHANGELOG.md`. Expected: new files in packages/, plans/, reviews/; modified CLAUDE.md (root) + docs/CHANGELOG.md (one-line notes per F5).
- [ ] **Step 2:** Stage explicitly (don't `git add -A`):
  ```bash
  git add packages/ceo-progress-report \
          docs/superpowers/plans/2026-05-27-ceo-progress-report-extraction.md \
          docs/reviews/staffreview-ceo-progress-report-extraction-2026-05-27.md \
          CLAUDE.md \
          docs/CHANGELOG.md
  ```
- [ ] **Step 3:** Commit via heredoc:
  ```bash
  git commit -m "$(cat <<'EOF'
  feat(packages): extract ceo-progress-report as OSS package + Claude Code plugin

  Lift the PROGRESS.md → progress.html renderer from
  scripts/build-progress-html.mjs into a standalone, installable tool.

  packages/ceo-progress-report/
  - src/{parse,compute,render,helpers,index}.mjs — modular renderer
    (~1500 lines, zero runtime deps, pure stdlib).
  - src/theme/default.css — newspaper theme extracted from inline style.
  - bin/cli.mjs — `init` + `build` commands. Windows-safe dynamic config
    import via pathToFileURL.
  - templates/{PROGRESS.md, buildlog.config.mjs, CLAUDE.md,
    .github/workflows/ceo-report.yml} — drop-in starter.
  - skills/{buildlog-author, buildlog-review}/SKILL.md — the writing-
    discipline IP, packaged as Claude Code skills.
  - commands/{build, init}.md — slash commands wrapping the CLI.
  - .claude-plugin/plugin.json — manifest for marketplace submission.
  - docs/{SCHEMA.md, VOICE.md} — the contract and the discipline.
  - README.md + LICENSE (MIT). README explicit on two-surface install
    (npm + Claude Code plugin).
  - examples/frollie-pos-PROGRESS.md — golden-diff fixture.

  Verification: package-built HTML is byte-identical (modulo timestamps)
  to scripts/build-progress-html.mjs output for the live Frollie
  PROGRESS.md. Verified at Phase B + Phase G1 of the plan.

  Frollie POS impact:
  - CLAUDE.md: one-line file-locations note pointing at the new package.
  - docs/CHANGELOG.md: 2026-05-27 extraction entry.
  - scripts/build-progress-html.mjs: unchanged. Continues to power
    Frollie's progress.html until v0.3 ships. Hard commitment to retire
    immediately post-v0.3 in favor of the published package.

  Plan: docs/superpowers/plans/2026-05-27-ceo-progress-report-extraction.md
  Staff review: docs/reviews/staffreview-ceo-progress-report-extraction-2026-05-27.md
  Improvements applied pre-execution: split A3 into 7 sub-steps; fixed
  loadConfig for Windows; added code-drift risk + retirement commitment;
  explicit two-surface install in README + slash commands; empty-title
  guard in renderPage.

  Marketplace submission + npm publish deferred to follow-up tasks.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] **Step 4:** Verify: `git log -1 --oneline && git status`. Expected: new commit shows in log; working tree clean (or only Frollie POS unrelated files remaining).

---

## Definition of done (whole plan)

The plan is complete when ALL of the following are true:

1. `packages/ceo-progress-report/` exists with all 19 files listed in the File Structure section.
2. `node packages/ceo-progress-report/bin/cli.mjs build --src docs/PROGRESS.md --out /tmp/x.html` produces an HTML structurally identical (modulo timestamps) to `docs/progress.html`.
3. `node packages/ceo-progress-report/bin/cli.mjs init` (run from a fresh empty directory) produces 4 starter files that themselves build cleanly via `npx ceo-report build`.
4. Both skill `SKILL.md` files have valid YAML frontmatter with `name` and `description` fields.
5. `.claude-plugin/plugin.json` parses as valid JSON with required fields (`name`, `version`, `description`).
6. README, SCHEMA, VOICE all > 1500 chars; LICENSE present.
7. Frollie's root `CLAUDE.md` has a one-line note pointing at `packages/ceo-progress-report/` (per F5 / staffreview §9).
8. Frollie's `docs/CHANGELOG.md` has the 2026-05-27 extraction entry prepended (per F5).
9. CLI's `loadConfig` uses `pathToFileURL` for cross-platform safety (per staffreview Improvement 4).
10. `Risks` table includes the code-drift row + `Open follow-ups` lists the in-tree script retirement commitment (per staffreview Improvement 3).
11. A single commit on the current branch contains all of the above.
12. Working tree clean.

Out of scope of this plan (separate tasks afterwards):
- Spinning out to standalone repo via `git subtree split`.
- Publishing to npm.
- Submitting to Claude Code plugin marketplace.
- Migrating Frollie POS's `scripts/build-progress-html.mjs` to use the published package.

---

## Out of scope (do NOT do during this plan)

Cut aggressively. Each of these would feel "polished" but adds tool-call budget without changing whether the package is shippable:

- **TypeScript types or `.d.ts` files.** Pure JS; ESM.
- **Unit test suite** (`vitest`, etc.). Golden diff against Frollie is the integration test.
- **Watch mode CLI** (`ceo-report watch`). Defer to v0.2.
- **Check/lint CLI** (`ceo-report check`). Defer to v0.2.
- **Multiple themes.** Default newspaper only. Custom CSS documented as override.
- **Screenshot in README.** Add post-extraction once we have a live demo URL. Use a placeholder string.
- **Dark theme.** Defer to v0.2.
- **i18n.** English only.
- **Sync with Linear/Jira/Notion.** Markdown is the source of truth, by design.
- **Schema validation as a library export.** The CLI's `build` command surfaces parse errors; that's enough.
- **Plugin tests / `claude plugin validate` run.** The CLI may not be installed locally; manual JSON validation is the gate.
- **README screenshot capture.** Deferred to post-extraction with placeholder.
- **Spinning out to standalone repo.** Stays in `packages/` for this plan.
- **npm publish.** Manual step after plan completes.
- **Marketplace submission.** Manual step after plan completes.
- **Migrating Frollie's own usage.** Separate task after v0.3.

---

## Risks with concrete mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `render.mjs` extraction introduces a regression vs. the in-tree script | Medium | Phase B golden-diff CATCHES this before Phase C-F build on top. If diff fails, fix render.mjs and re-run Phase B before continuing. |
| `src/render.mjs` becomes async (needed to read CSS at render time) — breaks callers expecting sync | Low | The public API `buildHtml` was already designed async. CLI uses `await`. Document `buildHtml` as async in README. |
| Windows path resolution in CLI fails (e.g., `file:///` URL vs path mixing) | Low (was Medium) | RESOLVED by staffreview Improvement 4 — `loadConfig` uses `pathToFileURL(resolve(cwd, configPath)).href` for dynamic import. Works on Windows, macOS, Linux without special-casing. |
| **Code drift between `packages/ceo-progress-report/src/*` and `scripts/build-progress-html.mjs` (HIGH after Phase G)** | High | Two copies of ~1500 lines of identical-at-commit logic. Golden diff catches parity at commit time but not future drift. **Mitigation:** every change to either copy MUST be mirrored in the other until the in-tree script is retired. **Hard commitment:** retire `scripts/build-progress-html.mjs` immediately after Frollie POS v0.3 ships, replacing all callers with `node packages/ceo-progress-report/bin/cli.mjs build`. Tracked in Open follow-ups below. |
| Plugin manifest schema validation rejects our format | Low | Followed `code.claude.com/docs/en/plugins-reference.md` exactly per research agent. Run `claude plugin validate` post-commit IF the CLI is available locally; otherwise validate JSON shape via Gate E.1. |
| Skill descriptions trigger on wrong contexts in real usage | Low | Descriptions name specific trigger phrases. Worst case: user disables the skill via Claude Code settings. Not a shipping blocker. |
| Lane labels in user's PROGRESS.md differ from defaults — parser drops their tasks | Medium | `parseProgressMarkdown` accepts `{ lanes }` config arg. Document prominently in `buildlog.config.mjs` template and in SCHEMA.md. |
| npm package name `ceo-progress-report` is already taken | Unknown | Check `npm view ceo-progress-report` BEFORE publishing (out of scope of this plan). Fall back to `@lucasy/ceo-progress-report` if needed. |
| Generated HTML's `<script id="kanban-data">` JSON gets too large for parse | Low | Already in use at Frollie scale (125 tasks). 10x headroom assumed. |

---

## Stopping points that trigger human review

The plan has TWO explicit human-review checkpoints:

1. **After Phase B (golden diff)** — if the diff is non-zero structurally, stop and report. Do not silently "fix and continue" — the human needs to know there's a renderer regression.
2. **At G2 (before commit)** — pause for "ship it" approval. Files written, all gates passed, deltas from plan reported.

Beyond these, the executor proceeds without further checkpoints. Decisions table at the top removes all pre-execution questions.

---

## Decisions log

- 2026-05-27 — Chose name "CEO Progress Report" over "buildlog" per user preference (sexier marketplace framing).
- 2026-05-27 — Chose full extraction (Option 1) over skills-only or document-in-place.
- 2026-05-27 — Chose both .md skill files AND Claude Code plugin distribution; submit to community marketplace.
- 2026-05-27 — Chose `.claude-plugin/plugin.json` manifest location, `skills/<name>/SKILL.md` skill structure, `commands/<name>.md` slash commands — per research from `claude-code-guide` agent.
- 2026-05-27 — All 10 open questions from the original draft locked in the pre-flight decisions table; executor does not pause to ask.
- 2026-05-27 — Inserted Phase B (golden-diff verification) BEFORE Phase C (templates) so we catch renderer regressions before building docs on top of a broken renderer.
- 2026-05-27 — Removed "Phase B starter content" from original draft → renamed to Phase C, added explicit `init` simulation gate.
- 2026-05-27 — Stayed in `packages/` instead of standalone repo for this plan; subtree-split deferred.
- 2026-05-27 — Applied staffreview improvements (1, 2, 3, 4) + refinements (1, 2) before execution. Split Phase A3 into 7 sub-steps; fixed CLI `loadConfig` for Windows via `pathToFileURL`; added code-drift risk + retirement commitment; clarified plugin-vs-package install in README + commands; added empty-title guard to `renderPage`.

---

## Open follow-ups (post-plan tasks; not in scope of this plan)

| # | Task | Owner | When |
|---|---|---|---|
| 1 | `git subtree split --prefix=packages/ceo-progress-report` → push to standalone GitHub repo (`lucasyhzhu-debug/ceo-progress-report` or org account) | Lucas | After this plan ships + name availability check (`npm view ceo-progress-report`) |
| 2 | `npm publish` v0.1.0 from the standalone repo | Lucas | After repo split + final manual smoke test |
| 3 | Submit Claude Code plugin to community marketplace at `platform.claude.com/plugins/submit` | Lucas | After npm publish + `claude plugin validate` passes locally |
| 4 | Capture screenshot of Frollie's live `progress.html` for the README pitch | Lucas | Pre-marketplace-submission (replaces placeholder) |
| 5 | **Retire `scripts/build-progress-html.mjs`** — replace with `node packages/ceo-progress-report/bin/cli.mjs build` (or `npx ceo-report build` once published). Update Frollie's `CLAUDE.md` references. **Hard commitment per staffreview Improvement 3.** | Lucas | Immediately after Frollie POS v0.3 ships to prod |
| 6 | Add CI workflow to `ceo-progress-report` repo that runs the golden-diff against `examples/frollie-pos-PROGRESS.md` on every push | Lucas | v0.2 of the package |
| 7 | Add `ceo-report check` command (lint PROGRESS.md for missing Targets, orphan deps, malformed decisions) | — | v0.2 |
| 8 | Add `ceo-report watch` (rebuild on PROGRESS.md change) | — | v0.2 |
| 9 | Add edge-case test suite (empty PROGRESS.md, single phase, custom lanes, empty title) | — | v0.2 |
| 10 | Document weighted-by-scope roadmap % as an opt-in config (current behaviour is unweighted; documented as intentional in `docs/VOICE.md`) | — | v0.3 if user demand surfaces |
