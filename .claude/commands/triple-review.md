---
name: triple-review
description: Use when completing a feature branch and wanting thorough parallel review before merge. Triggers on: "review this branch", "pre-merge review", "triple review", "review before merging".
---

<objective>
Dispatch 3 independent code review agents in parallel, synthesize their findings into a severity-tiered report, implement fixes, and surface lessons for memory.

**Orchestrator role:** Gather git context, spawn 3 reviewers simultaneously, wait for all to complete, cross-reference findings, triage by severity, drive fixes.
</objective>

<context>
Arguments: $ARGUMENTS
- First positional arg (optional): base branch for diff (default: `origin/main`)
- `--external-review=PATH`: path to a pre-computed review file (e.g., gsd-code-review REVIEW.md) to fold into the synthesis as a 4th reviewer perspective. When set, the unified report becomes a "quad review" covering 3 live agents + 1 pre-computed review.
- Remaining positional args (optional): plan file path(s) to pass to reviewers
</context>

<process>

## 0. Gather Git Context

Parse arguments first:
```bash
BASE=""
EXTERNAL_REVIEW=""
POSITIONAL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --external-review=*)
      EXTERNAL_REVIEW="${arg#--external-review=}"
      ;;
    *)
      POSITIONAL_ARGS+=("$arg")
      ;;
  esac
done
BASE="${POSITIONAL_ARGS[0]:-origin/main}"
```

Then gather context:
```bash
BRANCH=$(git branch --show-current)
SLUG=$(echo "$BRANCH" | tr '/' '-')
TODAY=$(date +%Y-%m-%d)
git log --oneline ${BASE}..HEAD
git rev-parse ${BASE} HEAD
git diff --stat ${BASE}..HEAD -- '*.ts' '*.tsx'
```

Extract: `branch`, `slug`, `base_sha`, `head_sha`, `commit_list`, `changed_files`, `external_review` (path or empty).

If `$EXTERNAL_REVIEW` is set, verify the file exists:
```bash
if [ -n "$EXTERNAL_REVIEW" ] && [ ! -f "$EXTERNAL_REVIEW" ]; then
  echo "Warning: --external-review path not found: $EXTERNAL_REVIEW — continuing as triple review (3 reviewers)"
  EXTERNAL_REVIEW=""
fi
```

If not found or empty, the skill runs as a standard triple review. If found, it runs as a quad review (3 live agents + 1 pre-computed perspective).

## 1. Auto-detect Supporting Files

Frollie POS is an **ADR-driven, deep-module** codebase ([ADR-034](docs/ADR/034-deep-modules-surface-apis.md)). Work is tracked in `docs/PROGRESS.md` (Task IDs `<phase>-<lane>-<slug>`, e.g. `v03-be-transactions`) and architectural decisions live in `docs/ADR/`. The single highest-signal review input is **which ADRs the diff touches** — gather those first.

```bash
# Phase / version token from the branch name (e.g. feature/v03-transactions, v0.3-be-foo)
PHASE=$(echo "$BRANCH" | grep -oP 'v?\d+(\.\d+)?' | head -1)

# Roadmap / task board (source of truth for "what was this branch supposed to do")
ls docs/PROGRESS.md 2>/dev/null

# ADRs referenced in the diff or in changed-file paths — the contract the code must honour.
# Map changed convex modules → likely-relevant ADRs by scanning ADR bodies for module names.
ls docs/ADR/*.md 2>/dev/null | head -40
git diff ${BASE}..HEAD -- '*.ts' '*.tsx' | grep -oiP 'ADR-\d+' | sort -u   # ADRs the code itself cites

# Design / decision docs + per-module patterns
ls docs/SCHEMA.md docs/DECISIONS.md docs/WORKFLOW.md 2>/dev/null
ls docs/PATTERNS/*.md 2>/dev/null
ls docs/superpowers/plans/*.md 2>/dev/null | sort -r | head -5

# GSD-style planning dirs (absent in this repo — degrades silently, kept for portability)
ls .planning/phases/${PHASE}-*/*.md 2>/dev/null | head -10

# Prior reviews for this branch/phase
ls docs/reviews/*${PHASE}*.md 2>/dev/null | sort -r | head -3
ls docs/reviews/*${SLUG}*.md 2>/dev/null | sort -r | head -3
```

Collect: `relevant_adrs` (always include `docs/ADR/000-strategic-foundations.md` + any ADR the diff cites or whose subject a changed module implements), `progress_task` (the matching `docs/PROGRESS.md` block), `design_docs` (`SCHEMA.md`, `DECISIONS.md`, relevant `PATTERNS/`), `prior_reviews`. Use these as `files_to_read` in agent prompts.

## 2. Spawn 3 Review Agents in Parallel

Launch all three with `run_in_background: true`. Do NOT wait between spawns.

> Subagent types: this repo reliably exposes `code-reviewer` (user-global agent) and `general-purpose` (built-in). If a more specialized review agent is available in the session (e.g. `feature-dev:code-reviewer`), you may substitute it for Agent 1 — but never block on an agent type that isn't registered.

---

### Agent 1 — ADR & Business-Invariant Reviewer

```
Task(
  prompt="""
<objective>
Review the implementation on branch `{branch}` for **ADR compliance** and
**business-invariant correctness** in the Frollie POS codebase. The task-board
entry says WHAT this branch should do; the ADRs say HOW it must do it. Your job
is to verify both — and to catch any silent violation of a money/audit/stock
invariant before it ships.
</objective>

<context>
Base: {base_sha}
Head: {head_sha}
Branch: {branch}
Commits:
{commit_list}

Changed files:
{changed_files}
</context>

<files_to_read>
{progress_task}        # docs/PROGRESS.md task block — the requirement
{relevant_adrs}        # the contracts the code must honour (always incl. 000-strategic-foundations.md)
{design_docs}          # docs/SCHEMA.md, docs/DECISIONS.md, relevant docs/PATTERNS/
{prior_reviews}
CLAUDE.md              # "Business rules that affect code" — the 18 invariants
</files_to_read>

<focus>
1. **ADR compliance** — for every ADR the diff touches, does the code honour its decision? Quote the ADR rule and the line that violates it. Common ones:
   - ADR-007 audit log is **append-only** — no update/delete of `audit_log` rows; a `logAudit` row is emitted from EVERY state-changing mutation.
   - ADR-008 refunds are **new `pos_refunds` rows** — never mutate a paid txn's status to "refunded"; status is computed on read.
   - ADR-013 **every public mutation accepts `idempotencyKey`** and is wrapped by the idempotency harness.
   - ADR-015 **all money is integer rupiah** — no floats, no cents, no `/100`; formatting only via `Intl.NumberFormat("id-ID")` in `src/lib/format.ts`.
   - ADR-031 **server time wins** — every `*_at` field set via `Date.now()` inside the Convex function, never client-supplied.
   - ADR-016 / ADR-020 stock-in only at SKU level; every stock change writes a `pos_stock_movements` row with a required `source` enum (never a bare number edit).
   - ADR-018 negative stock is **allowed + flagged** (`flags |= NEG_STOCK`), not hard-blocked.
   - ADR-024 discount ordering = line → voucher → tax; ADR-010 no voucher stacking.
   - ADR-005/027/028/029 manager-PIN gates (refunds, voids, override, manual discounts, stock adj, spoilage, settings, PIN resets); token authorizes VIEW, PIN authorizes ACT; token single-use, 60-min TTL.
   - Snapshot rule: `unit_price` + `product_name_snapshot` frozen on transaction lines — never join to `pos_products` for historical price.
2. **Business logic** — money math, discount/tax sequencing, stock decrement (`qty × pack_size`), aggregation correctness.
3. **Missing pieces** — task subtasks or ADR requirements with no corresponding implementation in the diff.
4. **Confidence scoring** — flag any logic that is inferred vs exact; flag any `?? default` that silently invents a value an invariant should have made explicit.
5. **v1 scope** — did the change quietly add something the "When to push back" list forbids (cash handling, packaging stock, customer-facing UI, voucher stacking)?
</focus>

<output_format>
Return findings as a markdown list grouped by:
## REQUIREMENTS_REVIEWER FINDINGS
### Critical (ADR violations, broken money/audit/stock invariants, incorrect logic)
### Important (partial compliance, missing logAudit/idempotency, scope creep)
### Minor (small gaps)
### Nitpick (naming, optional improvements)

Cite the ADR number + the file:line for every Critical/Important finding.
End with: ## REQUIREMENTS_REVIEWER COMPLETE
</output_format>
""",
  subagent_type="general-purpose",
  description="Review {branch}: ADR compliance & business invariants",
  run_in_background=true
)
```

---

### Agent 2 — Code Quality Reviewer

```
Task(
  prompt="""
<objective>
Review code quality, bugs, performance, security, and conventions for branch `{branch}`.
</objective>

<context>
Base: {base_sha}
Head: {head_sha}
Branch: {branch}
Changed files:
{changed_files}
</context>

<files_to_read>
Read each changed file fully. Also read CLAUDE.md ("Stack", "File locations", "Auth",
"Xendit integration notes") for project conventions.
</files_to_read>

<focus>
1. **Bugs & logic errors** — off-by-ones, wrong conditions, incorrect data handling, integer-rupiah math (no float drift).
2. **Security (POS-specific)** —
   - PIN verification (argon2id) MUST run in a Convex **action**, never a mutation (ADR-004 — long-running verify blocks the event loop).
   - Xendit webhook (`convex/payments/` or `convex/xendit/webhook.ts`) MUST verify the signature via `XENDIT_CALLBACK_TOKEN` before acting; webhook dedupes by `xendit_invoice_id` (Xendit retries).
   - Approval tokens: 32-byte URL-safe random, single-use, 60-min TTL; token authorizes VIEW only, PIN authorizes ACT.
   - Device registration required before login; sessions bound to `device_id`.
   - Unvalidated inputs, exposed internals, missing manager-PIN gate on a privileged mutation.
3. **Performance** — N+1 queries (use `Promise.all`), missing indexes, expensive client compute. Offline correctness: payments/auth/refunds MUST block offline; catalog/cart/drafts/stock-in may queue (ADR-025).
4. **Code quality** — dead code, unclear naming, missing error handling, type-safety holes, `any` leaks.
5. **Test quality** — for payment/refund/stock changes tests are REQUIRED (CLAUDE.md "How to add a feature" #7); check coverage of the idempotency + reconciliation paths, edge cases, no brittle/placeholder assertions (`expect(true).toBe(true)`).
6. **Project conventions** —
   - **DB field names are snake_case** (`unit_price`, `tax_rate`, `xendit_invoice_id`, `ref_type`, `device_id`); tables are `pos_*`. Do NOT flag snake_case as a defect — flag camelCase DB fields instead.
   - Convex anti-patterns: dynamic `import()` in Convex (fails in prod), React hooks after early returns, `ctx: { db: any }` instead of typed `QueryCtx`/`MutationCtx`.
   - **Module boundary discipline** (deep modules, ADR-034): a module's `public.ts` is its only sanctioned interface. Flag any import that reaches into another module's `internal.ts`/`schema.ts`. Cross-module calls go through `public.ts`; external (Frollie Pro) integration goes through `convex/api/v1/` only — never direct table access.
</focus>

<output_format>
Return findings as a markdown list grouped by:
## CODE_QUALITY_REVIEWER FINDINGS
### Critical (bugs, security issues, missing/incorrect auth, signature/token flaws)
### Important (performance, module-boundary leaks, missing required tests)
### Minor (conventions, clarity)
### Nitpick (style preferences)

End with: ## CODE_QUALITY_REVIEWER COMPLETE
</output_format>
""",
  subagent_type="code-reviewer",
  description="Review {branch}: code quality, security & module boundaries",
  run_in_background=true
)
```

---

### Agent 3 — Deep-Module Architecture Reviewer (Staff/Principal)

```
Task(
  prompt="""
<objective>
Perform a senior-engineer architectural review of branch `{branch}` through the lens
of Frollie POS's **deep-module / surface-API** design philosophy ([ADR-034]). Judge
plan-to-implementation fidelity AND whether the change keeps modules deep, interfaces
narrow, and the future Frollie Pro graft clean. Then write the review report to disk.
</objective>

<context>
Branch: {branch}
Changed files:
{changed_files}
</context>

<files_to_read>
{progress_task}
{relevant_adrs}
{design_docs}        # docs/SCHEMA.md, docs/DECISIONS.md, docs/PATTERNS/
{prior_reviews}
CLAUDE.md
docs/ADR/034-deep-modules-surface-apis.md
docs/ADR/000-strategic-foundations.md
docs/WORKFLOW.md
</files_to_read>

<focus>
1. **Deep-module discipline (ADR-034)** — the core lens:
   - Is each touched module **deep** (narrow `public.ts` interface hiding substantial implementation in `internal.ts`/`schema.ts`), or did the change create a **shallow pass-through** that adds interface surface without hiding complexity?
   - Did the public interface widen unnecessarily? A new exported function/arg is a cost — is it earned, or could it stay internal?
   - **Information leakage**: does a caller now need to know a module's internal layout (table shapes, enum internals) to use it? That's a leak.
   - **Cross-module coupling**: any reach into another module's `internal.ts`/`schema.ts` instead of its `public.ts`. External/Frollie-Pro-facing access must go through `convex/api/v1/` (versioned HTTP surface), never direct table access.
2. **Graft integrity** — POS data shape is intentionally independent of Frollie Pro (ADR-034 / strategic-foundations). Does this change lock in something that would make the v1.1+ cross-deployment integration harder? "Don't ship an assumption that locks the Frollie Pro graft."
3. **Plan fidelity** — task-board intent vs what was built; gaps, scope creep, shortcuts.
4. **Architectural risks** — real-time subscription load, schema migration implications, the idempotency/reconciliation/audit harnesses being bypassed rather than reused.
5. **Over- vs under-engineering** — unnecessary abstraction for v1, OR a quick hack that erodes a module's depth. Both are findings.
</focus>

<output>
Write full review to: docs/reviews/staffreview-{slug}-{today}.md
Use the staffreview report format (sections: Summary, Critical Issues, Improvements, Refinements).
Lead the Summary with a one-line verdict on module depth: did this change make the
affected modules deeper, shallower, or leave depth unchanged?
</output>

<output_format>
Also return inline summary:
## STAFFREVIEW FINDINGS
### Critical
### Important
### Minor
### Nitpick

End with: ## STAFFREVIEW COMPLETE
</output_format>
""",
  subagent_type="general-purpose",
  description="Review {branch}: deep-module architecture review",
  run_in_background=true
)
```

## 3. Wait for All 3 Agents

Do not proceed until all three return `## [REVIEWER] COMPLETE` signals. If any agent errors, note it and continue synthesis with the findings available.

## 4. Synthesize Findings

Cross-reference all result sets:
- Agent 1 (requirements-reviewer) findings
- Agent 2 (code-quality-reviewer) findings
- Agent 3 (staffreview) findings
- **If `$EXTERNAL_REVIEW` is set:** parse the external review file and treat its findings as a 4th reviewer ("gsd-code-reviewer")

**Parsing the external review file:**

Most external review formats (including `gsd:code-review` output) produce a YAML frontmatter block with counts, followed by markdown sections like "Critical", "Important", "Minor", "Nitpick", or "Findings" with structured items. Read the file and extract each finding into the same tiered buckets used by the live agents. If the external file uses a different severity vocabulary (e.g. "blocker"/"warning"/"suggestion"), map it:
- `blocker`, `security`, `auth-missing` → Critical
- `warning`, `performance`, `pattern-deviation` → Important
- `suggestion`, `clarity`, `convention` → Minor
- `nitpick`, `style` → Nitpick

If parsing fails, log a warning and fall back to 3-reviewer synthesis — do not block.

**Priority rules:**
- Flagged by 2+ reviewers → bump to highest tier claimed across sources
- Only 1 reviewer → keep at claimed tier
- External review findings count as 1 reviewer vote when cross-referencing

**Severity tiers (output order):**
1. **Critical** — bugs, missing auth, plan violations, incorrect calculations. Must fix before merge.
2. **Important** — performance (N+1), pattern deviations, partial compliance. Fix before merge.
3. **Minor** — clarity, minor gaps, style. Fix if quick; document if deferred.
4. **Nitpick** — preferences, optional polish. Mention only, do not block.

Present unified report. The header changes based on whether an external review was included:

```
## {Quad Review if $EXTERNAL_REVIEW else Triple Review} — {branch}
Date: {today}
Reviewers: adr-invariant-reviewer · code-quality-security-reviewer · deep-module-architecture-reviewer{if $EXTERNAL_REVIEW: ` · gsd-code-reviewer (from ${EXTERNAL_REVIEW})`}

### Critical ({n})
- [C1] {finding} — flagged by: {reviewers}
...

### Important ({n})
- [I1] {finding} — flagged by: {reviewers}
...

### Minor ({n})
...

### Nitpick ({n})
...

### Consensus Issues (2+ reviewers)
List items where ≥2 reviewers flagged the same root concern.
```

## 5. Implement Fixes

Ask the user: "Implement Critical + Important fixes now?"

If yes:
- Fix Critical items first, one at a time
- Commit after each logical group: `fix: {description}`
- Run `npm run typecheck` after all fixes
- If any payment / refund / stock code changed, run `npm run test:convex` (tests are required for those paths per CLAUDE.md "How to add a feature" #7)
- Run `npm run build` before final commit

If no: summarise fixes as a checklist the user can action manually.

## 6. Document Lessons

Append findings worth retaining to `~/.claude/projects/D--Claude-FrolliePOS/memory/MEMORY.md` under an appropriate heading (e.g., "## Lessons from {branch} Review"). Include only patterns that recur or that are non-obvious.

</process>

<success_criteria>
- [ ] All 3 agents spawned in parallel
- [ ] All 3 agents completed before synthesis
- [ ] Unified report produced with severity tiers
- [ ] Consensus issues (2+ reviewers) called out explicitly
- [ ] Staffreview saved to docs/reviews/
- [ ] Fixes implemented or checklist handed to user
- [ ] Lessons documented to memory
</success_criteria>
