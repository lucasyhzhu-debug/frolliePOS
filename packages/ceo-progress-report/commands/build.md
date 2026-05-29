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
