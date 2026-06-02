## Learned User Preferences

- Drive GitHub PR work with `/babysit N` (babysit skill) until merge-ready: conflicts, CI, and review comments triaged.
- On PR resolution follow-up: run a zero-sampling comment audit — paginate all review threads, issue comments, and reviews via `gh api graphql`; account for every item; treat bot and `agorokh` feedback as binding across all severities.
- After each push, watermark HEAD and explicitly re-audit feedback created or updated after that commit before exiting.
- Autonomously prune merged, abandoned, or obsolete local/remote branches and generated leftovers without asking; keep only branches with credible active work or unresolved risk.
- Never change CI workflows or checks just to make failures pass; fix in-scope code or report back.
- Validate Bugbot and similar bot review findings before acting; only fix valid issues and explain when disagreeing.
- Run local verification green before pushing PR fixes (`bot/` tests and syntax check).
- When reporting task results, be brief and omit explicit "no follow-ups needed" disclaimers.

## Learned Workspace Facts

- GitHub repository is `agorokh/hermescraft-bot` (HermesCraft embodied Minecraft agents).
- Core bot code lives under `bot/`; HTTP server entry is `bot/server.js`.
- Intent routing uses `bot/lib/intent_router.js` (regex) and `bot/lib/intent_router_nlp.js` (NLP-primary path).
- Local CI equivalent: `cd bot && npm test` plus `node --check bot/server.js`.
- GitHub Actions `validate` workflow is the main PR CI check (see `.github/workflows/ci.yml`).
- PR review automation commonly includes CodeRabbit, Cursor Bugbot, Codex/Gemini, and Sourcery (often rate-limited or skipped).
- Workspace may start without a checkout; clone the relevant PR branch from GitHub when needed.
- Parent monorepo `hermescraft` vendors this repo at `vendor/hermescraft`.
- `scripts/post_merge_sync.sh` is absent from this repo; the parent `hermescraft` script targets its own repo and is not a bot-repo substitute.
