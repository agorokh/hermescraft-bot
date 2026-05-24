# PR #12 Comment Ledger (zero-sampling audit)

**Watermark:** `2ac92648d065073900a5129a49522b77f653a52e`

## Summary

- Review threads: **40** (target: 40 RESOLVED / 0 UNRESOLVED)
- agorokh comments: **0**

## Round 12 (post-`6a759a6` Bugbot + Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294115916 recall phrases block imperative builds with "talked about" | RESOLVED | Soft-recall only blocks when no imperative build command |
| r3294122330 regex missing star tower / spell tower keywords | RESOLVED | Add resolver aliases to build_schematic regex |

## Round 11 (post-`499af0e` Bugbot + Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294102962 setblock probe accepts player chat as auth proof | RESOLVED | Listen on `message` with system-only feedback filter |
| r3294102964 waitForSetblockOutcome trusts non-system chat | RESOLVED | Same filter; prefer readback before feedback-only success |
| r3294107861 regex literal spaces vs resolver `\s*` | RESOLVED | Align compound keywords with `\s*` in build_schematic regex |

## Round 10 (post-`a708af1` Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294087195 where-is blocks imperative builds with location qualifiers | RESOLVED | Skip where-recall when build imperatives present |

## Full thread inventory

| # | Status | Author | Link |
|---|--------|--------|------|
| 1 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620001 |
| 2 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620519 |
| 3 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620520 |
| 4 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620523 |
| 5 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622935 |
| 6 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622936 |
| 7 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622938 |
| 8 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622939 |
| 9 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622940 |
| 10 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622941 |
| 11 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622942 |
| 12 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622944 |
| 13 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293642772 |
| 14 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293642773 |
| 15 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293644625 |
| 16 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293649240 |
| 17 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293656234 |
| 18 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293665513 |
| 19 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293665515 |
| 20 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293677654 |
| 21 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293690715 |
| 22 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702046 |
| 23 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702047 |
| 24 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702048 |
| 25 | RESOLVED | coderabbitai | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702049 |
| 26 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293703173 |
| 27 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293713121 |
| 28 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293713122 |
| 29 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293725826 |
| 30 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293736293 |
| 31 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293749738 |
| 32 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293768746 |
| 33 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294072299 |
| 34 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294072301 |
| 35 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294087195 |
| 36 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294102962 |
| 37 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294102964 |
| 38 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294107861 |
| 39 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294115916 |
| 40 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294122330 |
