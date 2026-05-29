---
description: Lint PROGRESS.md for missing Targets, orphan deps, malformed decisions, voice violations.
---

The user is invoking the CEO Progress Report check command. Run the CLI linter and surface the findings.

**Prerequisite:** the `ceo-progress-report` npm package must be installed in the project (or be available via `npx`). If neither, the first invocation will trigger an `npx` install — let it proceed; warn the user it may take a few seconds.

I'll run the linter. The findings come as a punch-list:
- ❌ **BLOCKER** — the CEO literally can't read the phase. Fails the build (exit 1).
- ⚠ **FIX** — structurally wrong but salvageable. Doesn't fail the build, but should be fixed before sharing.
- → **POLISH** — worth flagging, won't break anything.

1. Check that `PROGRESS.md` exists in the current working directory. If not, ask the user where it is (or suggest running `/ceo-progress-report:init` first).
2. Run:
   ```bash
   npx ceo-report check
   ```
3. Report the result. If `✓ All checks pass`, tell the user they're ready to share with founders. Otherwise, walk them through the BLOCKERs first (those must be fixed), then FIXes, then POLISH.
4. Do not edit PROGRESS.md yourself unless the user explicitly asks — surface the findings; let the user own the source markdown.
