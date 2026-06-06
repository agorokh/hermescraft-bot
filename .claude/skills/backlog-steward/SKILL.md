---
name: backlog-steward
description: >-
  Reconcile a GitHub backlog against the EVOLVED codebase and merged PRs — not
  against age. Use this whenever the user wants to audit, curate, groom, or
  "keep the backlog live"; asks which issues are stale, already-done, partially
  delivered, duplicated, or have "derailed / drifted"; says they keep "going in
  circles" or "stepping on a rake" re-attempting old issues; wants Issues
  reconciled with a GitHub Projects board; or asks "what's still worth doing".
  Triggers on: "review the backlog", "curate issues", "which issues can we
  close", "is this issue still valid", "did we actually deliver #N", "reconcile
  the board", "backlog health", "groom the backlog". Use it BEFORE re-picking up
  old issues so you don't re-implement work that already shipped in a different
  shape. This is the analysis/proposal organ of the Steward loop — it is
  non-coding: it never writes source and never creates issues itself.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
requires: "{shell}"
# Local-harness only: keep out of Hermes sync (Bash/Write crash the Hermes
# claude-cli subprocess per steward-skills-mcp-pure). skill_sync honors this.
hermes_sync: false

# Self-evolution provenance (Steward SOUL v2)
authority_tier: propose
triggering_session: 2026-06-05-operator-backlog-research
gap_statement: >-
  The fleet's well-defined issues evolve as implementation findings emerge;
  days later many are stale, partially-delivered, or drifted from their text,
  so re-attempting them is "stepping on a rake" and the team goes in circles.
  No existing skill reconciles original issue INTENT against the evolved code +
  merged PRs to keep the backlog live and aligned with the GitHub Project board.
  github-issue-creator creates issues; /post-merge acts on one PR; /orchestrate
  delivers; none audits the standing backlog for drift. This skill fills that
  gap as the analysis/proposal half of the Steward report-to-backlog-shaping
  evolution.
signals_observed:
  - "Recurring operator pain: issues derail over 1-2 days; re-attempts step on a rake"
  - "Issues #137 / #124 stayed OPEN after their PRs merged (auto-close gaps)"
  - "Five public reference skills (Prefect, amplihack, axelix, Backlog.md/agents-council TPM) each own one piece, none owns intent-vs-delivery reconciliation"
  - "Project #2 has rich lifecycle fields (Status, Intake State) that drift out of sync with Issues"
clustered_concept: >-
  Evidence-grounded reconciliation of open GitHub issues against the evolved
  codebase + merged PRs to classify and propose action on stale, partially-
  delivered, and drifted work while keeping Issues and the Projects board
  consistent.

# Reversibility contract
trigger_condition: >-
  Operator or Hermes/Stuart invokes backlog reconciliation manually
  (/backlog-steward), or a post-merge report-only pass runs after a merge.
expected_diff: >-
  Default (read-only): produces a report + per-issue provenance records in
  .scratch/ and a vault investigation/pitfall node; no GitHub mutation. With
  --apply: bounded GitHub metadata only — add/remove labels, at most one comment
  per issue, and Project board field moves. Issue CLOSES are always proposals,
  never executed by this skill.
forbidden_side_effects:
  - "Modifying any source file under src/, scripts/, tests/, ops/, tools/ (non-coding skill)"
  - "Closing or reopening issues automatically (closes are always proposals)"
  - "Creating or rewriting issues itself (hand off to github-issue-creator)"
  - "Using age / updated_at as a staleness signal"
  - "Cross-repo bounded writes in a single --apply run (read-only fan-out is fine; mutation is single-repo per the cross-repo-change-gate invariant)"
  - "Acting on a verdict backed by fewer than two independent evidence signals"
rollback_instructions: >-
  Read-only runs leave only .scratch/ + vault notes (delete them). For --apply
  runs, every label/comment/board change is listed in the run report with the
  inverse command; re-run with the inverse, or revert the vault node via git.
revert_skill: git revert

created: 2026-06-05
created_by: steward
status: active
promotion_note: >-
  Canonical template copy of the backlog-steward local workflow skill,
  propagated from agorokh/agent-factory#394. Child repos adapt this with their
  own vault ProjectKey. `Bash`, `Write`, and `Edit` are declared: Bash for `gh`,
  Write/Edit for the Phase-6 SAVE writes (.scratch ledger + run report + vault
  node — the same class peer skills vault-memory / post-merge / learner declare).
  `hermes_sync: false` keeps it out of any Hermes skill_sync where present (the
  declared Bash/Write would crash the Hermes claude-cli subprocess on tool-use).
---

# Backlog Steward — intent-vs-delivery reconciliation

You keep a GitHub backlog **live** by reconciling each open issue against what
the codebase and merged PRs **actually became** — never against how long it has
sat. The operator's recurring pain is precise: a well-scoped issue evolves as
findings emerge, and a few days later re-attempting it is *stepping on a rake* —
the premise moved, the work partly shipped under a different shape, or it is
plainly done but still open. Your job is to surface that truth with evidence and
**propose** the live-keeping move, not to silently mutate the tracker.

This skill is **non-coding**. It reads, classifies, and proposes. It hands code
work to `/orchestrate` and issue creation/rewrites to `github-issue-creator`.

## The one rule that governs everything

**An issue is never stale because it is old. It is stale because the code moved.**
Age and `updated_at` are banned as staleness signals — closing on inactivity is
the single most-documented failure of automated triage. Every non-`live` verdict
must rest on **≥2 independent evidence signals** drawn from code/PRs; with fewer,
the verdict is `undetermined`, never `stale`.

## First reply (discipline contract)

Before any analysis, state: **scope** (repo(s), issue count, filter), **mode**
(`read-only` default vs `--apply`), the **Tier-3 substrate query** you ran, and
the **provenance promise** (every verdict cites PR# + a code-search/symbol
anchor, not a bare line number — lines drift under refactor).

## Inputs / flags

- `--repo OWNER/REPO` (repeatable) — defaults to the current `origin`. Read-only
  reconciliation may fan out across repos. **Bounded writes (`--apply`) operate
  on a single repo per invocation** (cross-repo *mutation* needs Council sign-off
  per the `cross-repo-change-gate` invariant).
- `--project N` — the GitHub Project to reconcile against (e.g. `2`).
- `--apply` — enable bounded safe-outputs (labels, ≤1 comment/issue, board
  moves). Absent ⇒ report only. **Never auto-closes even with `--apply`.**
  **Guard:** if multiple `--repo` values are provided alongside `--apply`,
  abort immediately: `"Error: --apply requires exactly one --repo (bounded
  writes are single-repo per invocation per the cross-repo-change-gate
  invariant)"`. Read-only fan-out across multiple repos is allowed without
  `--apply`.
- `--limit N` — cap issues examined (batch in 25–100 for large backlogs).
- `--unattended` — marks the run as non-interactive (e.g. invoked from `/post-merge`
  or a cron). Forces report-only regardless of `--apply`; suppresses all GitHub
  mutations and rate-limits comment emission. Pass this flag whenever the caller
  has no interactive operator present.

## Procedure

**Multi-repo fan-out:** When multiple `--repo` values are provided (read-only only),
run Phases 0–5 as a sequential loop over each repo. **Each iteration MUST ground in
that target's OWN code, PRs, manifest, and workspace — never the current checkout's.**
This skill's core premise is "reconcile the issue against what *that repo's* codebase
actually became"; substituting the current repo's tree or Tier-3 workspace for a
fan-out target produces confidently-wrong verdicts. Concretely, for each `OWNER/REPO`
that is **not** the current checkout:
- Obtain its code: prefer a local checkout if present; otherwise read via `gh` against
  `OWNER/REPO` (`gh search code --repo OWNER/REPO`, `gh api repos/OWNER/REPO/contents/…`,
  `gh pr list --repo OWNER/REPO --state merged`) — do **not** grep the current working tree.
- Resolve its workspace from **its** manifest (`OWNER/REPO`'s `ops/memory_manifest.yml`
  `tier3_workspace_id`), via the canonical ladder; if you cannot read the target's
  manifest, mark its verdicts `undetermined` rather than reusing this repo's workspace.
Each iteration issues its own substrate query, lists issues for that repo, and appends
its report section + ledger entries under the `OWNER/REPO` namespace. Aggregate the
per-repo reports in Phase 6. With `--apply` only one `--repo` is allowed (see guard above).

### Phase 0 — Resolve scope (deterministic)
1. Build the repo list: `--repo` values (repeatable) or `git remote get-url origin`
   when no `--repo` is given. Parse `.git` off each URL.
2. **Tier-3 substrate query (mandatory)** for prior decisions on these issues:
   `mcp__agentic-memory__query_knowledge_graph(prompt="backlog reconcile <repo> <issue nouns> prior decisions", workspace=<resolved per the repo's workspace-resolution ladder>)`.
   **Resolve the workspace authoritatively — never by bare-basename guesswork.**
   Do **not** re-derive the resolution logic here (it drifts): use this repo's
   single canonical **workspace-resolution ladder** verbatim — the one the
   `orchestrate` skill and [`docs/00_Core/MEMORY_CONTRACT.md`](../../../docs/00_Core/MEMORY_CONTRACT.md)
   define (manifest `tier3_workspace_id`/`name` → `ops/memory_manifest.local.yml`
   → `mcp__agentic-memory__list_workspaces` bridge visibility → `resolution_exceptions`).
   The key fact for this skill: the manifest's authoritative mapping is
   `tier3_workspace_id` (e.g. this hub → `agent_factory_steward`), which a plain
   basename match (`template_repo`) does **not** hit. If the ladder still yields
   more than one candidate, pick the **canonical domain workspace for the repo's
   own product**, never a neighbour that merely shares a basename. If it yields
   **none**, do not query a wrong graph and do not hard-stop the reconciliation —
   degrade to the ladder's bootstrap/warn-only mode: ground on the repo's Tier-2
   vault (grep it directly), mark affected verdicts `undetermined`, and note the
   missing workspace. (Reserve a hard STOP for genuine *ambiguity* you cannot
   break, not for a simply-absent workspace.)
   Substrate down ⇒ grep the vault directly and mark affected verdicts
   `undetermined`; never guess.
3. Load the project board fields once: `gh project view N --owner OWNER --format json`
   and `gh project item-list N --owner OWNER --format json` (Status, Intake
   State, Target Repo).
4. Load the **reconciliation ledger** from the last run (see Phase 6). If absent,
   this is a cold start.
5. List open issues, **excluding PRs**. **Prefer `gh issue list`** — it returns
   issues only (never PRs) and honors `--limit N` exactly:
   `gh issue list --repo OWNER/REPO --state open --limit N --json number,title,body,labels,updatedAt,assignees`
   Only fall back to the REST path when you need raw fields `gh issue list` omits —
   and note that `/issues` returns issues **and** PRs, so `per_page=N` then
   PR-filtering **under-fetches** (a PR-heavy first page leaves <N issues silently).
   Page at the API max and cap *after* filtering:
   `gh api "repos/OWNER/REPO/issues?state=open&per_page=100" --jq 'map(select(.pull_request==null)) | .[:N]'`.
   If that returns a full page (100 items) but fewer than N issues, PRs are crowding
   the page — fetch successive pages (`&page=2`, …) until you have N issues or the
   open issues are exhausted, and record the page count in the report. Do **not**
   use `--paginate` (it fetches the entire backlog and defeats the `--limit` cap).

### Phase 1 — Sweep (Pass 1: fast, whole batch)
Assign a **provisional verdict** + confidence from cheap signals only (title,
first paragraph, linked PRs, labels, ledger delta). **Diff against the ledger** —
an issue whose state is unchanged since its last verdict and carries a
`scope-evolution-accepted` marker is *not* re-flagged; this is what stops the
team going in circles. Use JIT context: only deep-load bodies for non-`live`
candidates in Phase 2.

The five mutually-exclusive verdicts:

| Verdict | Means | Distinguishing evidence |
|---|---|---|
| `live` | still actionable; intent intact, not yet delivered | no merged PR satisfies it; premise still holds |
| `stale:<reason>` | code moved underneath it | reason ∈ {already-addressed, superseded, not-applicable, duplicate}, each with PR/code evidence |
| `partially-delivered` | **intent unchanged**, only some codepaths shipped | merged PR covers part of the AC; a concrete delta remains |
| `drifted` | **intent/requirements themselves changed** | findings/decisions diverged from the issue text; the text now misleads |
| `undetermined` | insufficient evidence | <2 signals, or substrate/code search inconclusive |

The split that matters: **`partially-delivered` = right goal, incomplete build;
`drifted` = the goal itself changed.** If you cannot tell, it is `undetermined`.

### Phase 2 — Dig-in (Pass 2: evidence-required, candidates only)
For every `stale` / `partially-delivered` / `drifted` / auto-close-gap candidate,
produce a **provenance record**. Never finalize a close/rewrite from Pass 1.

```
issue: #N — title
claim_to_verify: why it looks closable / drifted / partial
current_state_check: grep/Read of the named modules + symbol anchors;
                     merged-PR linkage (Closes/Fixes); test coverage of the AC
evidence_links: PR #, commit SHA, file + symbol/search-anchor (NOT bare line), ADR/vault node
counterevidence: any signal it should stay open
signals_count: N (must be >= 2 for a close/stale verdict)
verdict: <final, from the five>
confidence: low | medium | high
recommended_action: keep | rewrite | split | close(reason) | reprioritize | escalate
```

The dangerous false close (from adversarial review): a PR removes a public API an
issue depends on, so the issue *looks* obsolete — but the behavior **migrated**
elsewhere. Before any `stale:already-addressed`, check for **migrated/renamed**
behavior, not just the disappearance of the original surface.

### Phase 3 — Board reconciliation (report; propose)
Report each divergence class against the Project board, honoring **single source
of truth**:
- closed-but-not-Done · Done-but-still-open · **orphan** open issues not on the
  board · **stale-on-board** (board says In Progress but the issue drifted) ·
  **auto-close-gap** (merged PR should have closed it, it is still open).
Propose the 1:1 corrective Status / Intake-State move for each.

### Phase 4 — Re-prioritize the `live` set (advisory only)
Score with lightweight **ICE** (Impact × Confidence × Ease) — or RICE/WSJF if the
operator asks — and output a recommended order with one-line rationale +
confidence. **Never reorder the board without the operator.** Note over-precision
on guessed inputs is a known failure; keep scores advisory.

### Phase 5 — Apply (only with `--apply`; bounded safe-outputs)
**Pre-check:** if `--unattended` is set (or the skill was invoked from `/post-merge`),
skip this phase entirely — remain report-only regardless of `--apply`. Log:
`"Unattended mode: Phase 5 skipped; report written to .scratch/backlog-steward/"`.

Pre-approved, volume-limited actions ONLY:
- `gh issue edit … --add-label/--remove-label` for `status:*`, `needs:*`, `stale`
  (verify labels exist first against the **target** repo: `gh label list --repo OWNER/REPO`
  — never the bare `gh label list`, which reads the current directory's repo).
- `gh issue comment` — **at most one per issue**, from a template, no raw dumps.
- Project board field move via `gh project item-edit`.
- **Closes, rewrites, splits, and any code work are emitted as proposals** — route
  closes to the operator, rewrites/splits to `github-issue-creator`, code to
  `/orchestrate`. This skill does not run them.
Post-merge / unattended mode is **report-only and rate-limited** regardless of
`--apply`: it never comments or mutates without an interactive operator.

### Phase 6 — SAVE (the anti-rake loop)
1. **Report**: counts per verdict, the provenance records, the board-divergence
   table, the recommended order, and (for `--apply`) every change with its
   inverse command.
2. **Reconciliation ledger**: persist per-issue `{repo, number, last_verdict,
   evidence_snapshot, run_ts}` (keyed on `"OWNER/REPO#N"` to prevent
   multi-repo collisions) to `.scratch/backlog-steward/ledger.json` so the
   next run **diffs instead of re-deriving**. Record a `scope-evolution-accepted`
   marker for any issue whose scope legitimately evolved, so future runs treat
   the evolution as intentional rather than re-flagging it as `drifted`.
3. **Living memory**: append recurring drift patterns to a vault `pitfall` or
   `investigation` node under this repo's vault (`docs/01_Vault/<ProjectKey>/`;
   `ProjectTemplate` in the template) (Tier-2 → Tier-3 ingest makes them
   fleet-discoverable). Update `Next Session Handoff.md`.

## Guardrails (why, not just what)
- **Age is never staleness.** Old ≠ dead; only moved code is. This is the line
  between curation and vandalism.
- **Read-only by default; propose-then-apply.** Trust is earned in stages:
  summarize → label-with-review → board-move → (close stays a proposal). Closing
  duplicates is the highest-risk action and is never automated here.
- **≥2 independent signals or it's `undetermined`.** Single-signal closes are how
  an auditor becomes confidently wrong and the operator acts on it.
- **Refactor-proof provenance.** Cite symbols / search anchors, not line numbers.
- **Degrade safe.** If the substrate, `gh`, or a model is unavailable, fall back
  to a read-only report and mark verdicts `undetermined`; never block, never guess.
- **Compose, don't absorb.** Creating/rewriting issues is `github-issue-creator`;
  delivering code is `/orchestrate`; this skill only analyzes and proposes.

## Reference
Design rationale, the five reference skills surveyed, and the council review are
captured in the originating research (see the investigation node linked from the
PR that lands this skill).
