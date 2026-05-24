# PR #12 Comment Ledger

**Watermark (audit start):** `e12072a63d1c6eeb1b17c075bff6aa1d593edbb8`  
**PR:** https://github.com/agorokh/hermescraft-bot/pull/12

## Inventory totals

| Source | Count |
|--------|------:|
| Review threads | 15 |
| Inline review comments (REST) | 15 |
| Issue conversation comments | 3 |
| Pull request reviews | 7 |
| `agorokh`-authored feedback | 0 |

## Review threads (15/15 RESOLVED)

All threads resolved on GitHub after code fixes in `16eb71c`, `9388c71`, and `e12072a`.

| # | Thread ID | Author | Path | Fix commit |
|---|-----------|--------|------|------------|
| 1 | PRRT_kwDOSfkEa86EV3YE | chatgpt-codex-connector | intent_router.js | 16eb71c NLP Y norm |
| 2 | PRRT_kwDOSfkEa86EV3eV | cursor | player_utils.js | 16eb71c center column |
| 3 | PRRT_kwDOSfkEa86EV3eW | cursor | intent_router.js | 16eb71c shared speculative fn |
| 4 | PRRT_kwDOSfkEa86EV3eZ | cursor | schematic_resolve.js | 16eb71c alias tighten |
| 5 | PRRT_kwDOSfkEa86EV38i | coderabbitai | intent_router.js | 16eb71c NLP Y norm |
| 6 | PRRT_kwDOSfkEa86EV38j | coderabbitai | intent_router.js | 16eb71c remember tighten |
| 7 | PRRT_kwDOSfkEa86EV38l | coderabbitai | schematic_resolve.js | 16eb71c alias tighten |
| 8 | PRRT_kwDOSfkEa86EV38m | coderabbitai | skills.js | 16eb71c setblock verify |
| 9 | PRRT_kwDOSfkEa86EV38n | coderabbitai | INDEX.json | 16eb71c heights |
| 10 | PRRT_kwDOSfkEa86EV38o | coderabbitai | server.js | 16eb71c chatEntry |
| 11 | PRRT_kwDOSfkEa86EV38p | coderabbitai | kid_prompts test | 16eb71c action assert |
| 12 | PRRT_kwDOSfkEa86EV38r | coderabbitai | generator script | 16eb71c heights |
| 13 | PRRT_kwDOSfkEa86EV71M | cursor | intent_router.js | 9388c71 scoped guard |
| 14 | PRRT_kwDOSfkEa86EV71N | cursor | skills.js | 9388c71 probe coords |
| 15 | PRRT_kwDOSfkEa86EV8L- | coderabbitai | server.js | e12072a handledByRouter |

## Issue comments (3/3 RESOLVED)

Rate-limit or summary only; no code changes required.

## PR reviews (7/7 RESOLVED)

All bot reviews map to threads above; no additional actionable items.

## Verification

`cd bot && npm test` — 180/180 passing.

## Post-watermark round 2 (after `23969b6`)

| # | Thread ID | Author | Path | Status | Resolution |
|---|-----------|--------|------|--------|------------|
| 16 | PRRT_kwDOSfkEa86EV9Dw | cursor | schematic_resolve.js | RESOLVED | Router regex + corpus utterances aligned to qualified aliases |
| 17 | PRRT_kwDOSfkEa86EV-Xn | cursor | intent_corpus.json | RESOLVED | Same alignment + regression test |

