# PROGRESS.md format — schema reference

This is the format `ceo-report build` parses. If you change it, update `src/parse.mjs` to match — the parser is the contract enforcer.

The renderer is forgiving about ordering and whitespace, but strict about the shape of each construct below. Constructs the parser doesn't recognize are silently ignored (the renderer will not surface them), so a typo in a marker is invisible at build time — read this doc end-to-end before inventing your own variants.

---

## Phase header

```
## vX.Y — title <emoji> <statusLabel>
```

Examples:
```
## v0.3 — sale flow + Xendit 📋 PLANNED (next up)
## v0.2 — auth + foundations ✅ DONE
## v0.5 — manager surface 🗂️ BACKLOG
```

- The version is `v` followed by 2+ dot-separated numerics (`v0.3`, `v1.0`, `v1.2.1` all valid).
- The em-dash (`—`, U+2014) separating version and title is required. A hyphen-minus (`-`) will not parse.
- The status emoji is one of: `✅` (done) · `🔄` (in-progress) · `📋` (planned) · `🗂️` (backlog).
- The status label is free text after the emoji — `DONE`, `PLANNED (next up)`, `BACKLOG`, `IN PROGRESS — ETA Fri`. It's surfaced as a subtitle. The emoji, not the label, is canonical.

## Phase body

After the header, the parser expects (in any order, all optional unless noted):

### Outcome (recommended)
```
**Outcome:** <one sentence in user-action voice>
```
A single sentence. The renderer treats this as the phase's lede. See [VOICE.md](./VOICE.md) for the writing rules.

### Target (non-shipped phases only)
```
**Target:** YYYY-MM-DD
**Target:** Mon DD YYYY
**Target:** MMM YYYY
**Target:** TBD
```
Use `TBD` only when the date is genuinely unknown. Never mix prose with the date.

### Merged line (shipped phases only)
```
Merged YYYY-MM-DD
```
A bare line — **not** `**Merged:**`. The parser reads the unstyled form. Omit `**Target:**` once a phase has merged; the date in `Merged` is what the renderer displays.

### Unlocks block
```
**You can:**
- Bullet 1
- Bullet 2
```
Also accepted: `**You'll be able to:**`. Use 3–8 bullets, each ≤ 18 words, each starting with a verb the reader would say aloud.

### Deferred block
```
**You still can't:**
- Bullet 1 (v0.5)
- Bullet 2 (v0.4)
```
Also accepted: `**Still not yet:**`. Use 2–6 bullets. Naming the version where each item unlocks is convention, not parsed.

### Lane sections
```
### Backend (be)
- ✅ Task title
- 📋 **[v03-be-example]** Addressable task
```
Lane labels are configured in `buildlog.config.mjs` — defaults are `Backend`, `Frontend`, `Cross-cutting`. The slug in parens is informational only (the parser identifies the lane by its heading match against the config).

---

## Tasks

A task is a top-level bullet under a lane heading. The first character after the bullet must be a status emoji.

### Legacy task (no metadata)
```
- ✅ Decision logging mechanism
```
No ID, no metadata block. Useful for migrated history where the granularity wasn't tracked.

### Addressable task (with metadata)
```
- 📋 **[v02-be-example]** Example task
  - agent: claude
  - deps: v02-be-foundations, v02-xc-config
  - docs: docs/ADR/012-foo.md
  - subtasks:
    - [ ] checkbox item
    - [x] completed checkbox item
  - notes: free text continuation
```

Required:
- A status emoji (`✅` · `🔄` · `📋` · `🗂️`) immediately after the dash.
- The task ID wrapped as `**[task-id]**` — lowercase ASCII, digits, hyphens only.
- A title after the bracketed ID.

Optional indented metadata (2-space indent for top-level keys, 4-space for subtask checkboxes):
- `agent: <name or —>`
- `deps: <comma-separated task-ids or —>`
- `docs: <path or —>`
- `subtasks:` followed by indented checkbox items
- `notes: <free text>`

A commit SHA in parens at the end of the title line is parsed as the merge commit reference:
```
- ✅ **[v02-be-auth]** PIN-based login (a1b2c3d)
```

The task's status comes from the emoji, not from subtask completion — keep them in sync manually.

---

## Risks section

```
## Risks under watch

- **Title** — body sentence.
- body-only sentence with no title.
```

Two formats, both accepted:
- **Titled:** `- **Title** — body sentence.` (renderer shows title prominently)
- **Body-only:** `- body sentence.` (renderer shows body only)

Risks don't have a resolved state in v0.1. To remove a risk, delete the bullet.

---

## Decisions section

```
## Decisions awaiting the CTO

- **Question?** — body explaining the tradeoff.
- ~~**Original question?**~~ — **RESOLVED 2026-05-15**: chose option A.
```

Two formats:
- **Active:** `- **Question?** — body explaining the tradeoff.`
- **Resolved:** `- ~~**Original question?**~~ — **RESOLVED YYYY-MM-DD**: chose option A.`

The resolved format is exact: strikethrough (`~~ ... ~~`) wraps the bold-question, then ` — **RESOLVED <date>**: ` then the resolution sentence. The parser segregates resolved decisions into a separate renderer section — they remain as institutional memory, not clutter.

**Never delete a resolved decision** — the renderer hides them visually if you want, but the audit trail stays in the markdown.

---

## Status emoji legend

| Emoji | Status        | Used for          |
| ----- | ------------- | ----------------- |
| ✅    | done          | shipped phases + completed tasks |
| 🔄    | in-progress   | active phase + in-flight tasks   |
| 📋    | planned       | next-up phase + queued tasks     |
| 🗂️    | backlog       | future phases + parked tasks     |

These four are canonical. Don't invent new emoji — the parser hard-codes this set.

---

**If you change the format, update `src/parse.mjs` to match — the parser is the contract enforcer.**
