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
