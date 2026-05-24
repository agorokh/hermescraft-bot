# PR #12 Comment Ledger (zero-sampling audit)

**Watermark:** `f364631` (Round 18 push — hoist afterName before probe try/finally)

## Summary

- Review threads: **51** (51 RESOLVED / 0 UNRESOLVED after Round 18 code fixes)
- agorokh comments: **0**

## Round 18 (post-`90c4182` Bugbot + Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294990837 afterName declared inside try, used outside | RESOLVED | Hoist `afterName` before try/finally block |
| r3294991751 Hoist setblock probe readback state outside try block | RESOLVED | Same fix as r3294990837 |

## Round 17 (post-`29daba1` Bugbot)

| Item | Status | Fix |
|------|--------|-----|
| r3294967634 build_tower missing normalizeBuildBaseY (regex + NLP) | RESOLVED | Normalize Y at tower foot offset in both routers |
| r3294967637 wizard_tower false positives from non-proximate word pairs | RESOLVED | Compound wizard/magic + tower patterns; ice_castle before wizard |
| r3294981683 detectSetblockAuth probe listener lacks try/finally | RESOLVED | Wrap probe loop in try/finally for listener cleanup |

## Round 16 (post-`06c0846` Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294959684 market fallback hijacks mansion/fire pit near market | RESOLVED | Move bare build+market fallback after all structure branches |

## Round 15 (post-`b7e9d89` Bugbot)

| Item | Status | Fix |
|------|--------|-----|
| r3294949257 setblock feedbackFail not filtered to command feedback | RESOLVED | Split command-feedback source check from ok/fail phrase matching |

## Round 14 (post-`113d0df` Bugbot + Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294926923 NLP speculative gate blocks non-build mixed intents | RESOLVED | Build-only gate + where-primary recall blocks all intents |
| r3294927193 bare "later" in hardRecall blocks imperative builds | RESOLVED | Move later/another day to softRecall with imperative exception |

## Round 13 (post-`c7f222c` Codex)

| Item | Status | Fix |
|------|--------|-----|
| r3294905478 market alias hijacks house-near-market builds | RESOLVED | Require compound market terms or build-market without other structures |
| r3294905481 bare imperative build phrasing blocked by softRecall | RESOLVED | Accept build-verb + any following token in imperative check |

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
| 41 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294905478 |
| 42 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294905481 |
| 43 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294926923 |
| 44 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294927193 |
| 45 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294949257 |
| 46 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294959684 |
| 47 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294967634 |
| 48 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294967637 |
| 49 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294981683 |
| 50 | RESOLVED | cursor | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294990837 |
| 51 | RESOLVED | chatgpt-codex-connector | https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3294991751 |
