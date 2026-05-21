# HermesCraft architecture

This document explains how HermesCraft turns a Hermes agent into a Minecraft player without writing a custom agent runtime. It complements the [project README](../README.md) and the per-mode docs ([COMPANION_MODE](COMPANION_MODE.md), [CIVILIZATION_MODE](CIVILIZATION_MODE.md), [LAN_PLAY](LAN_PLAY.md)).

## Goal

Each in-world character is a normal Hermes agent with:

- its own `HERMES_HOME` (memory + session history)
- its own SOUL prompt (personality, goals, constraints)
- its own Minecraft bot body (a Mineflayer process behind an HTTP API)
- access to the `mc` CLI for everything Minecraft-specific (perception + action)

That means the same Hermes tools and reasoning stack power both a single companion and a multi-agent civilization. There is no separate "agent runtime" to maintain.

## Layered view

```text
+--------------------------------------------------------+
|  Hermes Agent (terminal + tools + memory + SOUL)       |
+--------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------+
|  mc CLI (bin/mc) — observation, action, social verbs   |
+--------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------+
|  bot/server.js — HTTP API, one process per character   |
|    - routing/intent layer (bot/lib/)                   |
|    - fair-play perception filters                      |
|    - background-task queue                             |
+--------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------+
|  Mineflayer bot body (real Minecraft protocol client)  |
+--------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------+
|  Minecraft Java Edition (LAN or Paper server)          |
+--------------------------------------------------------+
```

## Why HTTP between Hermes and Mineflayer?

The Hermes brain runs in a terminal as a normal Hermes session (so you keep its tools, memory, and conversation transcript). The Mineflayer bot runs as a long-lived Node process so it can hold a stable Minecraft connection across many short Hermes tool calls. The HTTP boundary is the cleanest way to keep those two lifecycles separate while letting the agent feel like it has a body.

`mc` is the operator-facing surface. Internally it just calls the HTTP API. Agents are told about `mc`, not about HTTP.

## Fair-play perception

Most Minecraft bot frameworks expose the full world to the agent: every entity, every block, every chest content, regardless of line of sight. That makes for impressive demos and unbelievable characters.

HermesCraft intentionally constrains perception so the agent has to behave like a player:

- entities are filtered by line of sight and range
- sounds are directional hints, not exact coordinates
- `mc scene` reports what is visible in the current view cone plus remembered nearby landmarks
- resource finding is biased toward visible blocks instead of omniscient scans
- agents are encouraged to admit uncertainty and reposition

This matters for two reasons: the characters become believable, and the demo stays honest about what the architecture can do without cheating.

## Multi-agent routing

In civilization mode, every character runs as a separate Hermes process pointed at a separate Mineflayer bot. They share the Minecraft server but not their memory or session state.

Social interaction flows through Minecraft's own systems:

- **public chat** — everyone in range hears it
- **direct whispers** — `mc whisper <player> "<msg>"`
- **overhearing** — characters near a private exchange may receive a hint
- **commands** — human players can queue instructions to a specific character

This means alliances, tension, and division of labor have to emerge from in-world signals, not from a privileged shared blackboard.

## Persistence

Each character has its own `HERMES_HOME`, so memory and conversation history survive across sessions. A character can remember:

- previous interactions with specific players
- saved locations (home, mine, fishing spot)
- preferences and routines
- ongoing quests or projects

This is why a Landfolk-mode character like Reed (the fishing-shack builder) actually returns to his shack across multiple play sessions instead of restarting from scratch.

## Where the code lives

| Concern | Path |
|---|---|
| Mineflayer HTTP server | `bot/server.js` |
| Routing + intent + perception helpers | `bot/lib/` |
| Unit tests | `bot/test/` |
| `mc` CLI | `bin/mc` |
| Companion SOUL | `SOUL-minecraft.md` |
| Civilization SOUL | `SOUL-civilization.md` |
| Landfolk SOUL | `SOUL-landfolk.md` |
| Character prompts | `prompts/` |
| Launchers | `hermescraft.sh`, `civilization.sh`, `landfolk.sh`, `scripts/run-landfolk-*.sh` |

## What this isn't

- Not a fake NPC framework (the characters are real Minecraft clients)
- Not a separate agent runtime (it reuses the Hermes stack)
- Not an omniscient bot (perception is constrained on purpose)
- Not a benchmark harness (the goal is play and small-society behavior, not eval scores)

## Roadmap shape

The architecture targets two human-legible scales: one companion that feels like a friend, and a small cast that makes a world feel inhabited. Both share the same plumbing, which is the whole point — if the substrate works at one character, scaling to many is configuration, not redesign.
