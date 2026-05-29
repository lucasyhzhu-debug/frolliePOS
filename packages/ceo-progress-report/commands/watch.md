---
description: Start the live rebuild loop — progress.html refreshes on every PROGRESS.md save.
---

The user is invoking the CEO Progress Report watch command. Start the watcher so `progress.html` rebuilds automatically on every save.

**Prerequisite:** the `ceo-progress-report` npm package must be installed in
the project (or be available via `npx`). If neither, the first invocation
will trigger an `npx` install — let it proceed; warn the user it may take a
few seconds.

1. Check that `PROGRESS.md` exists in the current working directory. If not, ask the user where it is (or suggest running `/ceo-progress-report:init` first).
2. Run:
   ```bash
   npx ceo-report watch
   ```
   Optional flags:
   - `--src <path>` — source PROGRESS.md (default: `./PROGRESS.md`)
   - `--out <path>` — output HTML (default: `./progress.html`)
   - `--config <path>` — config file (default: `./buildlog.config.mjs`)
3. The command does an initial build immediately (`✓ rebuilt at HH:MM:SS`), then stays alive watching for changes.
4. On each PROGRESS.md (or config) save, it rebuilds and prints a fresh `✓ rebuilt at ...` line with elapsed time.
5. Press Ctrl-C to stop the watcher cleanly.
6. Do not edit PROGRESS.md or progress.html yourself — the user owns the source markdown; the HTML is generated.
