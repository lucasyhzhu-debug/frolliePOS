# CEO Progress Report

Turn `PROGRESS.md` into an editorial build-log dashboard your CEO will actually read. Built for founders, CEOs, and anyone who skims the build log between meetings — not for the engineer who wrote it. The defensible part isn't the renderer; it's the writing discipline the package ships: two Claude Code skills that translate engineer-voice ("implemented webhook handler") into CEO-voice ("customers can now pay") every time you author or review a phase.

![CEO Progress Report — editorial build-log dashboard](docs/screenshot.png)
<!-- TODO: capture screenshot post-extraction -->

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

The plugin's slash commands (`/ceo-progress-report:build`, `:init`) wrap the npm CLI — they require the npm package to be installed in your project (the first `npx` invocation will install it if not present). The plugin also ships the two writing-discipline skills (`buildlog-author`, `buildlog-review`) which Claude will activate automatically when you author or review your `PROGRESS.md`.

## 60-second start

```
npx ceo-report init           # scaffold PROGRESS.md + config + workflow
$EDITOR PROGRESS.md           # edit your first phase
npx ceo-report build          # → progress.html
```

Open `progress.html` in a browser — your build log is ready.

## What's in the box

- The Node.js renderer (zero runtime deps, ESM)
- A `ceo-report` CLI with `init` and `build` commands
- Two Claude Code skills (`buildlog-author` for writing, `buildlog-review` for editing)
- Two slash commands (`/ceo-progress-report:build`, `/ceo-progress-report:init`)
- A starter `PROGRESS.md` with three example phases, risks, and decisions
- A GitHub Action workflow that publishes to GitHub Pages
- A `buildlog.config.mjs` with all knobs documented
- A `CLAUDE.md` template to drop into any agent-friendly project

## Schema reference

See [docs/SCHEMA.md](./docs/SCHEMA.md) for the `PROGRESS.md` format contract — what the parser recognizes and what it doesn't.

## Voice reference

The format is opinionated for a reason — see [docs/VOICE.md](./docs/VOICE.md) for why every phase needs an outcome, a target, an unlocks list, and a deferred list (and why deleting a resolved decision is the wrong move).

## License

MIT — see [LICENSE](./LICENSE).
