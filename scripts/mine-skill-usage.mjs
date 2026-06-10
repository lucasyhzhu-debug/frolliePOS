// scripts/mine-skill-usage.mjs — tally which skills / slash commands were
// invoked across ALL local Claude Code conversations for this project.
//
// Run on the machine that holds the session history (transcripts are local
// to each PC under ~/.claude/projects/):
//
//   node scripts/mine-skill-usage.mjs
//
// Scans every ~/.claude/projects/*frolliePOS*/ transcript (.jsonl) and counts
//   1. user slash-commands  — <command-name>/xxx</command-name> in user turns
//   2. Skill tool calls     — assistant tool_use { name: "Skill", input.skill }
// split into main-conversation vs subagent (sidechain) usage.
// Output: ranked table + a JSON blob to paste back for the slide-4 chart.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const MATCH = /frolliepos/i;

const dirs = readdirSync(PROJECTS).filter(d => MATCH.test(d));
if (!dirs.length) {
  console.error('No frolliePOS project dirs found under', PROJECTS);
  process.exit(1);
}

const tally = {}; // name -> {user: n, agentMain: n, agentSide: n}
const bump = (name, kind) => {
  if (!name) return;
  name = name.trim().toLowerCase().replace(/^\//, '');
  if (!name || name === 'clear' || name === 'model' || name === 'exit') return; // CLI built-ins, not skills
  tally[name] ??= { user: 0, skillMain: 0, skillSide: 0 };
  tally[name][kind]++;
};

let files = 0, lines = 0, sessions = new Set();
for (const d of dirs) {
  const dir = join(PROJECTS, d);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    files++;
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.sessionId) sessions.add(e.sessionId);
      const content = e.message?.content;

      // 1) user slash-commands
      if (e.type === 'user') {
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
        const m = text.match(/<command-name>\s*\/?([a-zA-Z0-9:_-]+)\s*<\/command-name>/);
        if (m) bump(m[1], 'user');
      }

      // 2) Skill tool calls by the model (main convo or subagent sidechain)
      if (e.type === 'assistant' && Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'tool_use' && c.name === 'Skill' && c.input?.skill) {
            bump(c.input.skill, e.isSidechain ? 'skillSide' : 'skillMain');
          }
        }
      }
    }
  }
}

const rows = Object.entries(tally)
  .map(([name, t]) => ({ name, total: t.user + t.skillMain + t.skillSide, ...t }))
  .sort((a, b) => b.total - a.total);

console.log(`scanned ${files} transcript files · ${lines} lines · ${sessions.size} sessions · dirs: ${dirs.join(', ')}\n`);
console.log('rank  total  user-cmd  skill(main)  skill(agent)  name');
rows.slice(0, 25).forEach((r, i) =>
  console.log(
    String(i + 1).padStart(4), String(r.total).padStart(6), String(r.user).padStart(9),
    String(r.skillMain).padStart(12), String(r.skillSide).padStart(13), ' ' + r.name
  ));

console.log('\n--- paste this back to Claude for the slide chart ---');
console.log(JSON.stringify({ sessions: sessions.size, files, top: rows.slice(0, 10) }, null, 2));
