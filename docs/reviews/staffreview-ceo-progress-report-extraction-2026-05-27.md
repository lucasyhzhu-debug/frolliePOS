# Staff Review: CEO Progress Report — Extraction Plan

**Date:** 2026-05-27
**Plan:** `docs/superpowers/plans/2026-05-27-ceo-progress-report-extraction.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Sections added — see §0

---

## 0. Plan Structure Additions

The plan was structurally complete enough to review, but two sections were added by the reviewer because the originals are scattered or implicit:

### 0.1 Testing Strategy (consolidated)

The plan distributes tests across phase gates rather than centralising. Summary for clarity:

| Layer | Test | Phase | Frequency |
|---|---|---|---|
| Renderer regression | Golden diff vs `scripts/build-progress-html.mjs` output on live Frollie PROGRESS.md | B + G1 | Once at extraction lockdown, again pre-commit |
| CLI smoke | `init` writes 4 files, `build` produces HTML > 30KB | C gate | Once |
| Skill/manifest validity | YAML frontmatter present; JSON parses; required fields present | D + E gate | Once each |
| Doc completeness | All 4 doc files exist + minimum byte sizes + no broken internal links | F gate | Once |

What's **NOT** tested in this plan:
- Edge cases: empty PROGRESS.md, single-phase PROGRESS.md, custom lane labels in config, missing config file, monogram derivation from empty title string.
- CLI error paths beyond "source not found": bad config, write-permission errors.
- The actual Claude Code plugin loading the manifest (would require `claude plugin validate` CLI; deferred).
- Future regression after this commit lands (no CI test in package itself).

Verdict: **Adequate for v0.1.0 MVP.** Edge-case coverage moves to v0.2 with the `check` command.

### 0.2 Rollback section (explicit)

Rollback is one operation: `git revert <commit-sha>`. The plan creates only new files under `packages/ceo-progress-report/` plus one new file in `docs/superpowers/plans/`. No existing file is modified outside that directory. A revert leaves the rest of the FrolliePOS repo and `scripts/build-progress-html.mjs` untouched.

Recovery from a broken commit: revert, fix in a follow-up commit, re-apply via cherry-pick or fresh commit.

Post-commit irreversible actions (npm publish, marketplace submission) are explicitly out of scope of this plan — so rollback during/after this plan is always clean.

---

## 1. Summary

**Overall Assessment: APPROVE WITH 4 IMPROVEMENTS**

The plan is well-structured, decisions are pre-locked, verification gates are concrete and shell-runnable, and the Phase B golden-diff insertion is a strong safety net against renderer regressions. The work is genuinely an extraction (lift-and-shift) of code we already know works — risk is correspondingly low. No critical issues block execution.

Four improvements would meaningfully strengthen the plan; three are about resilience (code drift, fresh-context executor risk, Windows path handling) and one is a UX clarity fix (plugin-vs-package install instructions). All four are addressable in <30 mins of plan edits and don't change the phase architecture.

## 2. Critical Issues (Must Fix)

**None.** The plan has no implementation-failure, data-loss, security, or correctness blockers.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|---|---|---|
| 1 | Split Phase A3 (render.mjs extraction) into smaller, more concrete steps | H | M |
| 2 | Make the plugin-vs-npm-package install relationship explicit in README outline + slash command bodies | M | L |
| 3 | Document the in-tree-script vs OSS-package code-drift risk and the follow-up task to retire one | M | L |
| 4 | Pre-empt Windows path issues in CLI by using `pathToFileURL` for dynamic config imports | M | L |

### Improvement 1: Split Phase A3 into smaller steps

**Location:** `Phase A — A3: Extract src/render.mjs`

The current A3 is one step that says: "Write `render.mjs` with [6 specific parameterisations], copy all other render functions verbatim." The deltas are described accurately, but the resulting render.mjs is ~700 lines. For self-execution (the executor has full conversation context), this is fine. For a fresh subagent or another developer, this single step is the highest-risk step in the plan — a missed parameterisation produces a runnable-but-wrong renderer that Phase B will catch as a structural diff, forcing rework.

**Recommendation:** Decompose A3 into:

- **A3.1** Copy `scripts/build-progress-html.mjs` lines 398-700 verbatim into `src/render.mjs`. Add ESM `export` keyword to each top-level function.
- **A3.2** At top of file, add imports from `./helpers.mjs` (full list as written today) plus `node:fs/promises`, `node:url`, `node:path`. Add `__dirname` derivation + `DEFAULT_CSS_PATH` constant.
- **A3.3** Change `renderPage(doc, generatedAt)` signature to `async renderPage(doc, generatedAt, config = {})`. Add config defaults block at function top — show the exact destructure + defaults.
- **A3.4** Replace 5 Frollie-specific strings with config interpolations (table of before/after lines).
- **A3.5** Inline CSS via `await readFile(config.cssPath, "utf8")` instead of the embedded template-literal CSS block — remove the old block.
- **A3.6** Conditional rendering of `.monogram` div when `monogramLetter === null`.
- **A3.7** Smoke import: `node -e "import('./packages/ceo-progress-report/src/render.mjs').then(m => console.log(Object.keys(m)))"`.

This makes each step a 2-5 min unit (per the skill's bite-sized rule) and each step has an explicit failure mode the executor can verify.

### Improvement 2: Plugin-vs-npm install relationship

**Location:** `Phase F — F1: README.md` outline; `Phase E — E2/E3: commands`

The plugin's slash commands (`commands/build.md` and `commands/init.md`) call `npx ceo-report build`. `npx` will silently install the npm package on first use, which works but is opaque. Users may install the plugin alone and be surprised when `/ceo-progress-report:build` triggers a fresh npm install.

**Recommendation:** In the README, add a clear two-step install:

```markdown
## Install (two surfaces)

### npm CLI (works in any project)
\`\`\`bash
npm install --save-dev ceo-progress-report
npx ceo-report init
\`\`\`

### Claude Code plugin (adds slash commands to your editor)
\`\`\`bash
# In a Claude Code session:
/plugin marketplace add anthropics/claude-plugins-community
/plugin install ceo-progress-report@claude-community
\`\`\`

The plugin's slash commands wrap the npm CLI; install both for full integration, or use either alone.
```

In each command's markdown body, add a one-line preamble: "Requires `ceo-progress-report` npm package installed in the project (or globally). If not present, the first `npx` invocation will install it."

### Improvement 3: Code-drift risk between package and in-tree script

**Location:** `Risks section`

The plan explicitly defers Frollie's migration to the published package. That means Frollie continues using `scripts/build-progress-html.mjs` while `packages/ceo-progress-report/src/*.mjs` is the OSS surface. Two divergent copies of ~1500 lines of identical-at-commit logic. The golden-diff verifies parity at commit time but does nothing to prevent future drift.

**Recommendation:** Add a row to the Risks table:

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bug fix lands in `scripts/build-progress-html.mjs` but not in `packages/ceo-progress-report/src/*` (or vice versa) | High | Add a CI check (deferred to v0.2 of the package) that re-runs the golden diff on every push. Until then: every change to either copy must be mirrored in the other. **Strongly recommend retiring `scripts/build-progress-html.mjs` immediately after Frollie POS v0.3 ships, replacing it with `node packages/ceo-progress-report/bin/cli.mjs build`.** |

Also add to the plan's "Open follow-ups" section:

- Track migration of Frollie POS from `scripts/build-progress-html.mjs` to `packages/ceo-progress-report/bin/cli.mjs` as an explicit v0.3+ follow-up task. ETA: same day v0.3 merges to main.

### Improvement 4: Windows-safe dynamic config import

**Location:** `Phase A — A5: bin/cli.mjs`

The CLI's `loadConfig` function uses dynamic `import(configPath + ...)` with a brittle Windows path prefix check:

```js
const mod = await import(configPath + (configPath.startsWith("/") || /^[a-zA-Z]:/.test(configPath) ? "" : "/" + configPath));
```

This is incorrect — the string concatenation with `"/" + configPath` would produce nonsense for relative paths, and `import()` of a Windows absolute path like `C:\foo\config.mjs` needs `pathToFileURL` to become `file:///C:/foo/config.mjs`. The current code will fail on Windows.

**Recommendation:** Replace with:

```js
import { pathToFileURL } from "node:url";

async function loadConfig(cwd) {
  const flagged = flag("config");
  const configPath = flagged
    ? resolve(cwd, flagged)
    : resolve(cwd, "buildlog.config.mjs");
  if (!existsSync(configPath)) return {};
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default || {};
}
```

This works on Windows, macOS, and Linux without special-casing.

## 4. Refinements (Optional)

- **Roadmap % weights all phases equally.** v0.2.1 (architecture restructure, ~3 days work) counts the same as v0.5 (largest phase). Document as intentional in `docs/VOICE.md` ("simplest interpretation; weighted-by-scope is v0.2 enhancement").
- **CLI should validate monogram derivation.** If `config.title` is an empty string, derivation produces empty char and the masthead renders awkwardly. Add a one-line guard in `renderPage`: `if (!config.title) config.title = "Project";`.
- **Plugin manifest could declare CSS asset.** The plugin spec may support `assets` field for non-skill bundled files. Worth checking when running `claude plugin validate`. Non-blocking.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|---|---|---|
| `parseProgressMarkdown` | `packages/ceo-progress-report/src/parse.mjs` (already extracted) | Already in plan A4 imports |
| `escapeHtml`, `renderInline`, formatters | `packages/ceo-progress-report/src/helpers.mjs` (already extracted) | Already in plan A3 imports |
| Computed stats logic | `scripts/build-progress-html.mjs:280-380` | Plan A1 lift |
| Render functions | `scripts/build-progress-html.mjs:398-700` | Plan A3 lift |
| CSS block | `scripts/build-progress-html.mjs:720-895` (inside template literal) | Plan A2 lift |

### Potential duplication risks

- **Confirmed and accepted:** Frollie POS keeps `scripts/build-progress-html.mjs` after this plan ships. Identical-at-commit, but drift risk is real (see Improvement 3).
- **No other duplication concerns.** The package is genuinely new code paths.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|---|---|---|
| Phase A — extract renderer + CLI | Good | A3 should be split (Improvement 1) |
| Phase B — golden diff | **Excellent insertion** | This catches the highest-risk extraction failure mode before subsequent phases build on it |
| Phase C — templates | Good | The init-roundtrip gate (Gate C.1-C.3) is well-designed |
| Phase D — skills | Good | Self-contained, low risk |
| Phase E — plugin manifest + commands | Good | Manifest is small + well-spec'd by research |
| Phase F — docs | Good | Internal-link check is a nice touch |
| Phase G — final diff + commit | Good | Explicit human review at G2 |

**Ordering issues:** None. The A → B → {C, D, E, F} → G dependency tree is correct. C/D/E/F could theoretically parallelise after B passes, but for single-session sequential execution the order as listed makes sense.

**Missing phases:** None.

## 7. Specialist Agent Recommendations

For single-session inline execution (most efficient given the renderer is already in working order), no specialist agents needed.

If the user chooses subagent-driven-development per phase:

| Phase | Recommended Agent | Rationale |
|---|---|---|
| A | `general-purpose` | Code extraction; no specialist needed |
| B | `general-purpose` | Shell diff; no specialist needed |
| C | `general-purpose` | Template writing; no specialist needed |
| D | `claude-code-guide` (or `agent-builder` for guidance) | Skill markdown authoring; `claude-code-guide` already has plugin/skill format context from earlier research |
| E | `claude-code-guide` | Manifest + slash command authoring; same context |
| F | `crafting-portfolio-essays` (for VOICE.md only) | VOICE.md is the document that earns the marketplace submission — it deserves voice-aware authoring, not generic prose |
| G | `general-purpose` | Git commit; standard |

The `crafting-portfolio-essays` recommendation for VOICE.md is worth taking. The other agents are conveniences only.

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|---|---|
| Feature branch specified | ⚠️ Implicit — uses current branch `feat/v0.2.1-architecture-restructure` |
| Branch naming follows convention | ⚠️ Current branch is named for an unrelated concern |
| Merge strategy documented | ❌ Not specified |

**Note:** The plan stays on `feat/v0.2.1-architecture-restructure` which is named for the (already-merged) architecture restructure work. This is a mismatch but acceptable for an internal extraction — the package is meta and doesn't need its own branch. Consider creating `feat/extract-ceo-progress-report` if the work might span more than one session or be reviewed in isolation. Not blocker.

### Commit checkpoints

The plan correctly commits ONCE at G3 — appropriate for a "publish one package" deliverable. Splitting into per-phase commits would fragment the package across changelog history without functional benefit.

### Pre-push verification

- [ ] `npm run build` — N/A (package has no build step; pure ESM JS)
- [ ] `npm run typecheck` — N/A (pure JS, no TypeScript)
- [x] Local testing before push — Yes, via Gate B + Gate G1 golden diff
- [ ] `git diff --check` for whitespace — Not in plan. Low risk for new files; skip.

### CI/CD & rollback

| Concern | Status |
|---|---|
| Rollback strategy | ✅ Documented in §0.2 (single `git revert`) |
| Deployment order | N/A (no deploy — extraction only) |
| Data backup needed | N/A |
| Migration safety | N/A |
| npm publish in plan | ✅ Explicitly deferred |
| Marketplace submission in plan | ✅ Explicitly deferred |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|---|---|
| F | `packages/ceo-progress-report/README.md` (new) |
| F | `packages/ceo-progress-report/docs/SCHEMA.md` (new) |
| F | `packages/ceo-progress-report/docs/VOICE.md` (new) |
| F | `packages/ceo-progress-report/LICENSE` (new) |
| **Missing** | Frollie's root `CLAUDE.md` — should `## Packages` section be added pointing to `packages/ceo-progress-report/`? |
| **Missing** | Frollie's `docs/CHANGELOG.md` — extraction is a meta artifact, but worth a line for institutional memory |

**Recommendation:** Add to the plan as a small Phase F addendum (or G2 review checklist):

- Add a one-line note to root `CLAUDE.md` under "File locations" pointing to `packages/ceo-progress-report/` (so future Frollie agents know it exists).
- Add a CHANGELOG.md entry: `2026-05-27 — Extracted PROGRESS.md renderer to packages/ceo-progress-report/ as a publishable OSS package + Claude Code plugin (not yet published).`

Neither is a blocker. Both are 1-line additions.

### CHANGELOG draft

```markdown
## 2026-05-27 — Tooling: CEO Progress Report extraction

- Extracted PROGRESS.md → progress.html renderer from `scripts/build-progress-html.mjs` into a standalone, installable package at `packages/ceo-progress-report/`.
- Package bundles: Node CLI (`ceo-report init`, `ceo-report build`), Claude Code plugin with two skills (`buildlog-author`, `buildlog-review`) and two slash commands, starter templates, GH Action workflow.
- Frollie POS continues using the in-tree script for v0.3 work; migration to the published package planned post-v0.3.
- npm publish + marketplace submission deferred to follow-up tasks.
```

## 10. Testing Plan Assessment

**Verdict: Adequate for v0.1.0 MVP.** See §0.1 for the consolidated testing summary.

### Planned tests

| Layer | What | Test type | Status |
|---|---|---|---|
| Renderer | Output matches in-tree script for live Frollie file | Golden diff (B, G1) | Planned |
| CLI `init` | 4 files written; subsequent `build` produces HTML > 30KB | End-to-end roundtrip (C gate) | Planned |
| CLI `build` | Reads source, writes destination, exit 0 | Smoke (A gate) | Planned |
| Parser | Structural HTML markers present | Indirect (file-size + class-name greps) | Planned |
| Skill markdown | Valid YAML frontmatter, size > 1500 chars | Static check (D gate) | Planned |
| Plugin manifest | Parses as JSON, required fields present | Static check (E gate) | Planned |
| Documentation | All files exist, sizes > floor, no broken internal links | Static check (F gate) | Planned |

### Missing test coverage (acceptable for v0.1)

| # | Missing test | Why it matters | Approach (v0.2) |
|---|---|---|---|
| 1 | Empty PROGRESS.md → empty doc → render without crash | Defensiveness | Add to a `test/edge-cases/` directory |
| 2 | PROGRESS.md with custom lane labels not matching config | Silent drop = data loss for user | Document loudly in SCHEMA.md; add lint warning in `check` command |
| 3 | `config.title = ""` → monogram derivation | UI bug | Add fallback in render (Refinement) |
| 4 | CLI error paths (bad config, EACCES on write) | UX | Wrap in try/catch with clear error messages |
| 5 | Claude Code plugin actually loaded by Claude Code | Integration | Manual verification post-commit; defer automated test |

### Test execution checkpoints

1. After Phase A (`A.1-A.3` gates): renderer extraction is correct
2. After Phase B (golden diff): zero regression vs canonical output
3. After Phase C (init roundtrip): scaffold-and-build path works for a new user
4. After Phase D-F gates: skills, manifest, docs valid
5. Before commit (G1): golden diff one more time

### Regression risk

- **`scripts/build-progress-html.mjs`** — untouched. No regression risk.
- **Existing Frollie PROGRESS.md** — used as the golden-diff input. Modifications to PROGRESS.md during this plan are prohibited (call out to executor).
- **Other Frollie POS code** — untouched.

## 11. Edge Cases to Address

Adding these to the plan as Phase G2 review checklist items (do not block commit, but executor should verify):

- [ ] What happens when `packages/ceo-progress-report/buildlog.config.mjs` does NOT exist in cwd? — Should silently use defaults. Verify.
- [ ] What happens when `config.title` is empty/missing? — Renderer should fall back to "Project" or similar (see Refinement 2).
- [ ] What happens on Windows when `--config ./my-config.mjs` is passed? — pathToFileURL fix (Improvement 4) handles this.
- [ ] What happens when an attacker passes `--out ../../etc/passwd`? — Local dev tool; acceptable. Document in SCHEMA.md as "trust local input".
- [ ] What happens when PROGRESS.md is missing the `## Risks under watch` section? — Renderer should omit the risks section without error. Verify with a stripped-down test PROGRESS.md.

## 12. Approval Conditions

**To approve, address:**

None (no critical issues).

**Recommended before implementation:**

1. **Improvement 1** — split Phase A3 into 7 smaller steps (highest-value refinement; eliminates the largest single point of executor failure)
2. **Improvement 4** — fix the dynamic config import for Windows (genuine bug in the CLI as written; would manifest on first user attempt)
3. **Improvement 2** — clarify plugin-vs-package install relationship in README outline + slash command preambles (UX clarity)

**Recommended during implementation:**

4. **Improvement 3** — add code-drift risk + retire-in-tree-script follow-up to the plan's risk table and open follow-ups list
5. Refinement 2 — guard against empty `config.title` in `renderPage`
6. Phase F addendum — add 1-line note to Frollie's root `CLAUDE.md` + CHANGELOG entry
7. Phase F3 — consider `crafting-portfolio-essays` agent for VOICE.md authoring

**Ship-it threshold:** If Improvements 1 and 4 land in the plan as edits before execution starts, the plan is ready to execute end-to-end without further pause. The other improvements can be applied inline by the executor and noted in the Phase G2 review.

---

*Generated by /staffreview*
