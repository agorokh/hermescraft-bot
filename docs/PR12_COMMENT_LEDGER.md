# PR #12 Comment Ledger (zero-sampling audit)

**Watermark:** updated on each push (see git log)

## Summary
- Review threads: **28** total, **28** RESOLVED, **0** UNRESOLVED
- Issue conversation comments: 3 (bot summaries)
- PR reviews: informational bot summaries
- agorokh comments: **0**

## Post-0b1455a Bugbot (round 4)
| Thread | Status | Fix |
|--------|--------|-----|
| r3293713121 dead `blocksBuild` in NLP speculative guard | RESOLVED | Removed unreachable `SPECULATIVE_BUILD_ACTIONS` / `blocksBuild`; recall-only post-dispatch gate |
| r3293713122 `waitForSetblockOutcome` listener leak | RESOLVED | Wrapped poll loop in try/finally to always remove `messagestr` listener |

## All review threads

| 1 | RESOLVED | chatgpt-codex-connector | [**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=f](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620001) |
| 2 | RESOLVED | cursor | [### Top-down multi-column search selects tree canopy over ground](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620519) |
| 3 | RESOLVED | cursor | [### Duplicated function across two router files](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620520) |
| 4 | RESOLVED | cursor | [### Bare "bridge" keyword resolves any mention to sky_bridge](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293620523) |
| 5 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622935) |
| 6 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622936) |
| 7 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622938) |
| 8 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622939) |
| 9 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622940) |
| 10 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622941) |
| 11 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622942) |
| 12 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293622944) |
| 13 | RESOLVED | cursor | [### Speculative discussion guard blocks all intents, not just builds](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293642772) |
| 14 | RESOLVED | cursor | [### Probe feedback check missing space-separated coordinate format](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293642773) |
| 15 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293644625) |
| 16 | RESOLVED | cursor | [### Corpus utterances can never resolve to schematic names](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293649240) |
| 17 | RESOLVED | cursor | [### Corpus and router include terms that never resolve](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293656234) |
| 18 | RESOLVED | cursor | [### Wizard tower resolution too broadly matches "house" keyword](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293665513) |
| 19 | RESOLVED | cursor | [### Duplicate training utterance in NLP corpus](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293665515) |
| 20 | RESOLVED | cursor | [### NLP router speculative check blocks all intents](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293677654) |
| 21 | RESOLVED | cursor | [### Post-dispatch speculative guard incorrectly blocks non-build inten](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293690715) |
| 22 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702046) |
| 23 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702047) |
| 24 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702048) |
| 25 | RESOLVED | coderabbitai | [_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293702049) |
| 26 | RESOLVED | cursor | [### Speculative discussion gate misses past-tense "built" recall promp](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293703173) |
| 27 | RESOLVED | cursor | [### Post-dispatch speculative guard contains unreachable dead code](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293713121) |
| 28 | RESOLVED | cursor | [### Listener leak in waitForSetblockOutcome on exception](https://github.com/agorokh/hermescraft-bot/pull/12#discussion_r3293713122) |
