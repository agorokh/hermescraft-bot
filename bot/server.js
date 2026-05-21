#!/usr/bin/env node
/**
 * HermesCraft Bot Server
 * 
 * A standalone HTTP server that controls a Mineflayer Minecraft bot.
 * Start this, then use the `mc` CLI or any HTTP client to control the bot.
 *
 * Usage:
 *   node server.js                              # defaults
 *   MC_HOST=localhost MC_PORT=25565 node server.js
 *   node server.js --port 3001 --mc-host localhost --mc-port 35901
 *
 * Environment:
 *   MC_HOST       Minecraft server host (default: localhost)
 *   MC_PORT       Minecraft server port (default: 25565)
 *   MC_USERNAME   Bot username (default: HermesBot)
 *   MC_AUTH       Auth type: offline|microsoft (default: offline)
 *   API_PORT      HTTP API port (default: 3001)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderPkg;
// pvp plugin disabled — its deprecated physicTick event breaks pathfinder
// import pvpPkg from 'mineflayer-pvp';
// const pvpPlugin = pvpPkg.plugin;
import armorManager from 'mineflayer-armor-manager';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import collectBlockPkg from 'mineflayer-collectblock';
const collectBlock = collectBlockPkg.plugin;
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import {
  CURRENT_CAST,
  buildKnownNames,
  parseMessageRouting,
  isMessageForMe,
  broadcastMentionsMe,
  stripMentionPrefix,
  applySocialEvent,
  summarizeSocialGraph,
} from './lib/chat.js';
import {
  yawPitchToDir,
  bearingFromDelta,
  classifySector,
  angleDiffDegrees,
  makeBlockMemoryKey,
  summarizeVisibleBlocks,
  summarizeSceneText,
} from './lib/perception.js';
// Square-zero rebuild (2026-05-16): high-level Mindcraft-shaped skill
// primitives + idle bark / presence loop. Each module is self-contained;
// wiring below registers skills with ACTIONS map and installs the bark
// loop on first spawn.
import { registerHighLevelSkills } from './lib/skills.js';
import { installBarksAndPresence } from './lib/barks.js';
import { tryRoute, ackFor } from './lib/intent_router.js';
import { installQuestEngine } from './lib/quests.js';
import { startSurvivalTick } from './lib/survival.js';

let _bark_tear_down = null;
let _quest_tear_down = null;
let _survival_tear_down = null;

// Per-bot locations file to prevent race conditions in multi-agent mode
const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const LOCATIONS_FILE = path.join(DATA_DIR, `locations-${(process.env.MC_USERNAME || 'HermesBot').toLowerCase()}.json`);

function loadLocations() {
  try { return JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveLocations(locs) {
  const dir = path.dirname(LOCATIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(locs, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const config = {
  mc: {
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT || '25565'),
    username: process.env.MC_USERNAME || 'HermesBot',
    auth: process.env.MC_AUTH || 'offline',
  },
  api: {
    port: parseInt(process.env.API_PORT || '3001'),
  },
};

// Parse CLI args
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if (arg === '--port' && next) { config.api.port = parseInt(next); i++; }
  if (arg === '--mc-host' && next) { config.mc.host = next; i++; }
  if (arg === '--mc-port' && next) { config.mc.port = parseInt(next); i++; }
  if (arg === '--username' && next) { config.mc.username = next; i++; }
  if (arg === '--auth' && next) { config.mc.auth = next; i++; }
}

// ═══════════════════════════════════════════════════════════════════
// Bot Manager
// ═══════════════════════════════════════════════════════════════════

let bot = null;
let mcData = null;
let botReady = false;
let chatLog = [];
let deathLog = [];
let commandQueue = []; // complex commands for Hermes to process
let currentTask = null; // background task state
let lastDeath = null;
let hardcoreDead = false; // Once true, no reconnect — permanent death
let lastHealth = 20;
let reconnectAttempts = 0;
const MAX_LOG = 100;
const MAX_QUEUE = 20;

// ── Stale-intent timeout (issue #68 Patch 2) ──────────────────────
// Kids walk away mid-request. Without this sweep, a pending commandQueue
// entry would sit forever, polluting `mc commands` and (worse) letting the
// brain blindly act on a 10-min-old request after the kid logged off. The
// sweep marks entries `status === 'stale'` after STALE_INTENT_TIMEOUT_MS
// with no in-flight progress, writes a durable "<player> asked for X then
// walked away — paused" memory entry, and surfaces them on `/commands` so
// the brain can acknowledge ("oh you came back — want me to finish?") on
// the kid's next turn.
const STALE_INTENT_TIMEOUT_MS = parseInt(process.env.STALE_INTENT_TIMEOUT_MS || '120000', 10);
const STALE_SWEEP_INTERVAL_MS = parseInt(process.env.STALE_SWEEP_INTERVAL_MS || '30000', 10);

// Rolling buffer of recent action outcomes for loop detection
let actionHistory = []; // { action, status, time }
const MAX_ACTION_HISTORY = 10;

// ── Voice wire (issue #54) ────────────────────────────────────────
// Monotonic envelope id stamped on every commandQueue.push so a reply can
// be correlated back to its originating utterance (chat OR voice).
let _envelopeCounter = 0;
function nextEnvelopeId() { return ++_envelopeCounter; }

// Centralized commandQueue eviction. Replaces the 4 inline
// `if (commandQueue.length > MAX_QUEUE) commandQueue.shift()` sites so the
// MAX_QUEUE-trim path can also free any voice-turn timer+resolver state
// that would otherwise leak. Without this, an evicted voice entry would
// linger in _pendingVoiceTurns until its 75s timeout fires, the kid would
// hang on the speaker, and (reviewer 2026-05-17 BLOCKER) a brain reply
// arriving in the gap could be misrouted to in-game chat.
function trimCommandQueue() {
  while (commandQueue.length > MAX_QUEUE) {
    const evicted = commandQueue.shift();
    if (evicted && evicted.source === 'voice' && _pendingVoiceTurns.has(evicted.id)) {
      const turn = _pendingVoiceTurns.get(evicted.id);
      clearTimeout(turn.timer);
      _pendingVoiceTurns.delete(evicted.id);
      try { turn.resolve({ ok: false, error: 'queue_evicted', id: evicted.id }); } catch {}
      log(`[voice✗] (id=${evicted.id}) MAX_QUEUE evicted before brain reply — fail-closed`);
    }
  }
}
// ── Auto-memory side-effect (issue #68 Patch 2) ──────────────────
// Minimal MEMORY.md append helper for server-side stale-intent notices
// (and future side-effect writes when the brain is unreliable under load).
// Companion home is set by start_companion_phase3.sh via
// HERMES_COMPANION_HOME; fall back to ~/.hermes-companion-<lowercase username>.
// Content-dedup window prevents spam when the brain is mid-restart.
const AUTOMEM_DEDUP_WINDOW_MS = 5 * 60_000;
let _autoMemoryRecent = []; // [{ ts, content }]
function _companionMemoryFile() {
  const home = process.env.HERMES_COMPANION_HOME
    || (process.env.HOME && path.join(process.env.HOME, `.hermes-companion-${(config?.mc?.username || 'rosie').toLowerCase()}`));
  if (!home) return null;
  return path.join(home, 'memories', 'MEMORY.md');
}
// ── readMemoryAnchorsNear — issue #68 Phase C (memory anchors in perceive) ──
// Reads MEMORY.md, extracts named-build / named-place entries with explicit
// coordinates, filters to entries within `radius` blocks of `pos`, returns the
// `limit` nearest ones as { label, x, y, z, distance } objects.
//
// Recognized line shapes (matches autoRememberFact + brain-side memory.add
// formats):
//   "Built <NAME> ... at X,Y,Z (..."             — auto-memory build wrapper
//   "Built <name> (<schem>) for kid at X,Y,Z"    — kid_name + schematic
//   "Built <thing> at X,Y,Z"                     — generic build
//   "Found <ore> vein at X,Y,Z"                  — discovery
//   "<freeform name>: X,Y,Z"                     — brain memory.add convention
//   "the fairy treehouse: 1691,73,1712"          — kid-given names
//
// Defensive: caps at LIMIT entries, ignores malformed lines, fail-silent.
const MEMORY_ANCHOR_LINE_LIMIT = 500; // scan at most N lines for cost control
function readMemoryAnchorsNear(pos, radius = 200, limit = 6) {
  const memFile = _companionMemoryFile();
  if (!memFile) return [];
  let raw;
  try { raw = fs.readFileSync(memFile, 'utf8'); } catch { return []; }
  const px = Math.floor(pos?.x ?? 0);
  const py = Math.floor(pos?.y ?? 0);
  const pz = Math.floor(pos?.z ?? 0);
  const lines = raw.split('\n').slice(-MEMORY_ANCHOR_LINE_LIMIT);
  const out = [];
  // Two extractor patterns — first match wins per line, prefer the
  // "Built/Found/Mined ... at X,Y,Z" shape because it has a verb-anchored
  // name; fallback to "<name>: X,Y,Z".
  const verbRe = /\b(?:Built|Placed|Found|Mined|Lit|Gave)\s+(.+?)\s+(?:at|near|around)\s+(-?\d{1,5})\s*,\s*(-?\d{1,5})\s*,\s*(-?\d{1,5})/i;
  const colonRe = /^([A-Za-z][^:\n]{2,60}):\s*(-?\d{1,5})\s*,\s*(-?\d{1,5})\s*,\s*(-?\d{1,5})/;
  for (const line of lines) {
    if (!line || line.trim().length === 0) continue;
    let m = line.match(verbRe);
    let label, x, y, z;
    if (m) {
      label = m[1].replace(/\s+for\s+kid$|\s+for\s+\w+$|\s*\(\d+\/\d+\s+blocks\).*$/i, '').trim();
      x = +m[2]; y = +m[3]; z = +m[4];
    } else {
      m = line.match(colonRe);
      if (!m) continue;
      label = m[1].trim();
      x = +m[2]; y = +m[3]; z = +m[4];
    }
    // Strip leading date prefix ("2026-05-20: Built ...")
    label = label.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '').trim();
    if (!label || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const dx = x - px, dz = z - pz;
    const distance = Math.round(Math.sqrt(dx * dx + dz * dz));
    if (distance > radius) continue;
    // Cap label length for prompt budget
    out.push({ label: label.slice(0, 60), x, y, z, distance });
  }
  // Sort nearest first; dedup by label+coords (latest entry wins so the most
  // recent fact about a named place is shown, not the earliest)
  const seen = new Map();
  for (const a of out) {
    const key = `${a.label.toLowerCase()}|${a.x},${a.y},${a.z}`;
    seen.set(key, a);
  }
  return Array.from(seen.values()).sort((a, b) => a.distance - b.distance).slice(0, limit);
}

function autoRememberFact(line) {
  if (!line || typeof line !== 'string') return false;
  const memFile = _companionMemoryFile();
  if (!memFile) return false;
  try {
    const now = Date.now();
    // Drop dedup entries outside the window
    while (_autoMemoryRecent.length && now - _autoMemoryRecent[0].ts > AUTOMEM_DEDUP_WINDOW_MS) {
      _autoMemoryRecent.shift();
    }
    if (_autoMemoryRecent.some((e) => e.content === line)) return false;
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(memFile, `\n§\n${stamp}: ${line}\n`);
    _autoMemoryRecent.push({ ts: now, content: line });
    log(`[automem] wrote "${line.slice(0, 100)}" to ${memFile}`);
    return true;
  } catch (e) {
    log(`[automem] write failed: ${e.message}`);
    return false;
  }
}

// ── Stale-intent sweep (issue #68 Patch 2) ───────────────────────
// Marks commandQueue entries `status='stale'` after STALE_INTENT_TIMEOUT_MS
// with no progress, writes a one-line memory fact, and records the
// player+command so the brain can acknowledge later. Surfaced via /commands.
//
// Gemini council #72: a queue-only mark is too passive — if the kid said
// "dig a massive hole" and walked away, Steve will keep digging while the
// stale flag sits idle in the queue. Physical interrupt: if `currentTask`
// was started in service of a now-stale intent (best-effort heuristic:
// same player, task started after the queue entry was created), stop it.
function sweepStaleIntents() {
  if (!commandQueue || commandQueue.length === 0) return;
  const now = Date.now();
  for (const entry of commandQueue) {
    if (entry.status !== 'pending') continue;
    const age = now - (entry.time || now);
    if (age < STALE_INTENT_TIMEOUT_MS) continue;
    entry.status = 'stale';
    entry.stale_at = now;
    const player = entry.from || 'someone';
    // Compact the command — strip long quotes, keep first 80 chars.
    const cmd = (entry.command || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const fact = `${player} asked "${cmd}" at ${new Date(entry.time).toLocaleTimeString()} then walked away — paused. (stale after ${Math.round(age/1000)}s no follow-up)`;
    autoRememberFact(fact);
    log(`[stale] ${player}: "${cmd}" stale after ${Math.round(age/1000)}s`);

    // Physical interrupt: if currentTask is plausibly serving this entry
    // (started after entry.time, kid not online to chat anew), stop the
    // bot's in-flight action so it doesn't keep digging/walking forever.
    // Conservative: only interrupt SLOW_TASK / movement-typed tasks. The
    // brain on its next turn sees the stale entry on /commands AND the
    // cancelled task → emits an acknowledgement chat ("oh you walked off,
    // pausing — let me know when you're back").
    try {
      if (currentTask && currentTask.status === 'running'
          && currentTask.started && currentTask.started > entry.time - 5000) {
        const STALE_INTERRUPTIBLE = new Set([
          'collect', 'bg_collect', 'goto', 'goto_near', 'follow',
          'fight', 'sprint_attack', 'pickup', 'flee',
        ]);
        if (STALE_INTERRUPTIBLE.has(currentTask.action)) {
          log(`[stale] interrupting currentTask=${currentTask.action} for stale intent of ${player}`);
          try { if (bot?.pathfinder) bot.pathfinder.setGoal(null); } catch {}
          try { if (bot) bot.stopDigging?.(); } catch {}
          try { if (bot) bot.clearControlStates?.(); } catch {}
          currentTask.status = 'cancelled';
          currentTask.error = `Cancelled — ${player}'s intent stale (${Math.round(age/1000)}s no follow-up)`;
          entry.physical_interrupt = true;
        }
      }
    } catch (e) { log(`[stale] interrupt error: ${e.message}`); }
  }
}

// Pending voice turns waiting for the brain's reply. Map<id, {resolve, timer, kid, ts}>
// where `resolve` is the HTTP response resolver and `timer` is the fail-closed
// timeout handle. When ACTIONS.chat fires while a voice turn is in flight,
// the message is routed here INSTEAD of bot.chat() — voice replies never
// leak into public Minecraft chat (council's fail-closed rule).
const _pendingVoiceTurns = new Map();
const VOICE_TURN_TIMEOUT_MS = 75000;
// Auto-correlate window: if /action/chat fires without in_reply_to, route
// to the oldest voice turn dispatched within this window.
const VOICE_AUTOCORRELATE_MS = 60000;

// ═══════════════════════════════════════════════════════════════════
// Fair Play Mode — perception constraints for realistic gameplay
// ═══════════════════════════════════════════════════════════════════

let fairPlayMode = process.env.FAIR_PLAY !== 'false'; // on by default
const FAIR_PLAY = {
  LOS_ENTITY_RANGE: 48,       // max entity detection range with LOS
  SNEAK_DETECT_RANGE: 8,      // sneaking players only detected this close
  SOUND_MINE_RADIUS: 16,      // mining sound radius
  SOUND_SPRINT_RADIUS: 8,     // sprinting sound radius
  SOUND_WALK_RADIUS: 4,       // walking sound radius
  SOUND_SNEAK_RADIUS: 1,      // sneaking sound radius
  REACTION_MIN_MS: 100,       // min reaction delay
  REACTION_MAX_MS: 300,       // max reaction delay
  BLOCK_SCAN_RANGE: 16,       // limited block scan (was 64 in find_blocks)
};

// Sound events detected by this bot (populated by nearby activity)
let soundEvents = [];

// Team system
let teamConfig = {
  team: null,        // 'red' or 'blue' or null
  role: null,        // 'commander', 'warrior', 'ranger', 'support'
  teammates: [],     // usernames of teammates
  rallyPoint: null,  // { x, y, z } set by commander
  teamChat: [],      // team-only messages
};

// Kill/death tracking
let combatStats = { kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 };
let recentDamagers = {}; // { username: lastDamageTime } for assist tracking

// Active furnaces (fire-and-forget tracking)
let activeFurnaces = [];

// Local sneak state tracking (Mineflayer controlState is write-only)
let isSneaking = false; // [{ x, y, z, input, count, startTime, estimatedDone }]

// ═══════════════════════════════════════════════════════════════════
// Chat Handling — Name-Routed Message System
//
// Messages are routed by prefix:
//   "Name1,Name2: message"  → only Name1 and Name2 receive it
//   "all: message"          → broadcast to everyone
//   "message" (no prefix)   → broadcast to everyone (human player style)
//
// Received messages go to chatLog (visible via mc read_chat / mc status)
// Other agents' private conversations go to overheardLog (mc overhear)
// Direct mentions also go to commandQueue (mc commands)
// ═══════════════════════════════════════════════════════════════════

let overheardLog = []; // messages between other agents we can "overhear"
let socialGraph = {};
let socialEvents = [];
let observedBlocks = new Map();

function getMyName() {
  return config.mc.username.toLowerCase();
}

function getNearbyPlayerNames() {
  if (!bot) return [];
  return Object.values(bot.entities || {})
    .map((entity) => entity.username)
    .filter(Boolean);
}

function rememberSocialEvent(event) {
  const withTime = { time: Date.now(), ...event };
  socialEvents.push(withTime);
  socialEvents = socialEvents.filter((entry) => Date.now() - entry.time < 30 * 60 * 1000).slice(-200);
  if (withTime.actor) applySocialEvent(socialGraph, withTime);
}

function getMemoryHints(limit = 4) {
  const hints = [...observedBlocks.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map((entry) => `${entry.name} ${entry.bearing} ${entry.distance}m (${Math.round((Date.now() - entry.lastSeen) / 1000)}s ago)`);
  return hints;
}

// Handle incoming chat message with routing
async function handleChat(username, message) {
  const knownNames = buildKnownNames(getMyName(), getNearbyPlayerNames());
  const routing = parseMessageRouting(message, { knownNames });
  let forMe = isMessageForMe(routing, getMyName());

  // Proximity filter: broadcasts from other known agents only heard when nearby.
  // Human players are not in CURRENT_CAST so they always pass through.
  if (forMe && routing.isBroadcast && bot && botReady) {
    const senderLower = username.toLowerCase();
    const isOtherAgent = CURRENT_CAST.includes(senderLower) && senderLower !== getMyName().toLowerCase();
    if (isOtherAgent) {
      const senderEntity = Object.values(bot.entities || {}).find(
        e => e.username && e.username.toLowerCase() === senderLower
      );
      const dist = senderEntity ? bot.entity.position.distanceTo(senderEntity.position) : Infinity;
      if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) {
        overheardLog.push({ time: Date.now(), from: username, message: routing.body, channel: 'distant_broadcast', to: [] });
        if (overheardLog.length > MAX_LOG) overheardLog.shift();
        rememberSocialEvent({ actor: username, kind: 'heard', channel: 'overheard_distant', message: routing.body });
        return;
      }
    }
  }

  if (forMe) {
    // Message is for us — add to chatLog (visible in mc read_chat / mc status)
    chatLog.push({
      time: Date.now(),
      from: username,
      message: routing.body,
      private: !routing.isBroadcast,
      channel: routing.channel,
      targets: routing.targets.length > 0 ? routing.targets : undefined,
    });
    if (chatLog.length > MAX_LOG) chatLog.shift();
    log(`[Chat${routing.isBroadcast ? '' : ' @me'}] <${username}> ${routing.body}`);
    
    // If directly addressed (Name: msg format), queue as command
    if (!routing.isBroadcast) {
      // ── Speculative intent router (square-zero rebuild 2026-05-16):
      // try to match the kid's message to a known intent (build_tower,
      // place_near_player, give_to_player, etc.) and fire the matching
      // primitive WITHOUT waiting for the LLM brain. <500ms response.
      // Safe-by-design: only reversible/non-destructive actions route.
      try {
        const route = await tryRoute(bot, routing.body, username);
        if (route.matched) {
          const ack = ackFor(route.intent_name);
          if (ack) {
            try { bot.chat(ack); } catch {}
          }
          log(`[IntentRouter] ${username} → ${route.intent_name} → mc ${route.action} ${JSON.stringify(route.body)}`);
          if (ACTIONS[route.action]) {
            // Fire-and-forget — long-running actions don't block chat thread.
            ACTIONS[route.action](route.body).then((result) => {
              if (result && result.result) {
                log(`[IntentRouter result] ${route.intent_name}: ${String(result.result).slice(0, 120)}`);
                try { bot.chat(String(result.result).slice(0, 80)); } catch {}
              }
            }).catch((e) => {
              log(`[IntentRouter] action ${route.action} failed: ${e.message}`);
              try { bot.chat(`hm, couldn't pull that off — ${e.message.slice(0, 50)}`); } catch {}
            });
            // Skip the queue: the kid is taken care of by the router. The
            // LLM brain doesn't need to see this directive.
            rememberSocialEvent({ actor: username, kind: 'heard',
                                  channel: routing.channel,
                                  command: true, intent_matched: route.intent_name,
                                  message: routing.body });
            return;
          }
        }
      } catch (e) {
        log(`[IntentRouter] error: ${e.message}`);
        // Fall through to normal queue path.
      }

      commandQueue.push({
        id: nextEnvelopeId(),
        time: Date.now(),
        from: username,
        command: routing.body,
        channel: routing.channel,
        source: 'chat',
        originalMessage: message,
        status: 'pending',
      });
      rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, command: true, message: routing.body });
      trimCommandQueue();
      log(`[Queued] ${username}: ${routing.body}`);
    } else {
      // Broadcast but mentions our name at start? Also queue as command.
      const mention = broadcastMentionsMe(routing.body, getMyName());
      if (mention) {
        const command = stripMentionPrefix(routing.body, mention);
        if (command) {
          // Try intent router FIRST (same as direct-address path above) —
          // kids almost always address with "Rosie do X" which hits this
          // branch, NOT the direct-name-colon branch. <500ms response with
          // no LLM round-trip when a keyword pattern matches.
          try {
            const route = await tryRoute(bot, command, username);
            if (route.matched && ACTIONS[route.action]) {
              const ack = ackFor(route.intent_name);
              if (ack) { try { bot.chat(ack); } catch {} }
              log(`[IntentRouter via mention] ${username} → ${route.intent_name} → mc ${route.action} ${JSON.stringify(route.body)}`);
              ACTIONS[route.action](route.body).then((result) => {
                if (result && result.result) {
                  log(`[IntentRouter result] ${route.intent_name}: ${String(result.result).slice(0, 120)}`);
                  try { bot.chat(String(result.result).slice(0, 80)); } catch {}
                }
              }).catch((e) => {
                log(`[IntentRouter] action ${route.action} failed: ${e.message}`);
                try { bot.chat(`hm, couldn't pull that off`); } catch {}
              });
              rememberSocialEvent({ actor: username, kind: 'heard',
                                    channel: 'public_mention',
                                    command: true, intent_matched: route.intent_name,
                                    message: command });
              return; // skip queue — handled by router
            }
          } catch (e) {
            log(`[IntentRouter via mention] error: ${e.message}`);
          }

          commandQueue.push({
            id: nextEnvelopeId(),
            time: Date.now(),
            from: username,
            command,
            channel: 'public_mention',
            source: 'chat',
            originalMessage: message,
            status: 'pending',
          });
          rememberSocialEvent({ actor: username, kind: 'heard', channel: 'public_mention', command: true, message: command });
          trimCommandQueue();
          log(`[Queued via mention] ${username}: ${command}`);
        }
      } else {
        rememberSocialEvent({ actor: username, kind: 'heard', channel: routing.channel, message: routing.body });
      }
    }
  } else {
    // Message is NOT for us — overheard only
    overheardLog.push({ time: Date.now(), from: username, message: routing.body,
                        channel: routing.channel, to: routing.targets });
    if (overheardLog.length > MAX_LOG) overheardLog.shift();
    rememberSocialEvent({ actor: username, kind: 'heard', channel: `overheard_${routing.channel}`, message: routing.body });
    log(`[Overheard] <${username}> → [${routing.targets.join(',')}] ${routing.body}`);
  }
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

async function createBot() {
  if (bot) {
    try { bot.quit(); } catch {}
    bot = null;
    botReady = false;
    await sleep(1000);
  }

  return new Promise((resolve, reject) => {
    log(`Connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username}...`);
    
    bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.mc.username,
      auth: config.mc.auth,
    });

    const timeout = setTimeout(() => {
      reject(new Error(`Connection timeout — couldn't reach ${config.mc.host}:${config.mc.port}`));
    }, 30000);

    bot.once('spawn', () => {
      clearTimeout(timeout);
      mcData = minecraftData(bot.version);

      // Load plugins
      bot.loadPlugin(pathfinder);
      // bot.loadPlugin(pvpPlugin); // disabled — breaks pathfinder
      bot.loadPlugin(armorManager);
      bot.loadPlugin(autoEatLoader);
      bot.loadPlugin(collectBlock);

      // Configure pathfinder
      const moves = new Movements(bot);
      moves.allowSprinting = true;
      moves.canDig = true;
      moves.allowParkour = true;
      bot.pathfinder.setMovements(moves);

      // Configure auto-eat
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: [],
      };

      // ── Square-zero rebuild: register high-level skill primitives
      // (Mindcraft-shaped, return English sentences) and install the
      // scripted idle-bark / gaze-on-proximity / event-reaction loop
      // (zero LLM calls; pure scripted "feel-alive" behavior). The bark
      // loop only fires when a player is nearby so empty-world idle
      // doesn't burn anything.
      try {
        registerHighLevelSkills(ACTIONS, ensureBot);
        // ── Auto-memory wrappers on marquee skills (issue #68 / cherry-picked
        // from f557003 after PR #69 bumped vendor to the wrong commit). The
        // brain reliably calls these high-level verbs; auto-write the
        // completion fact to MEMORY.md so cross-session continuity doesn't
        // depend on Sonnet remembering to ALSO emit a memory.add tool call
        // (emitting text-wrapped <tool_call>s alongside native Bash tool_use
        // is rare for Sonnet under load — primary failure mode of PR #54).
        const _origBuildSchematic = ACTIONS.build_schematic;
        if (_origBuildSchematic) {
          ACTIONS.build_schematic = async (body) => {
            const result = await _origBuildSchematic(body);
            try {
              const r = result?.result || '';
              const m = r.match(/Built (?:schematic )?"?([\w_-]+)"? at ([-\d]+),([-\d]+),([-\d]+) — (\d+)\/(\d+)/);
              if (m) {
                const [, schemName, x, y, z, placed, total] = m;
                if (Number(placed) > 0) {
                  // If body carries `kid_name` (kid said "name it X"), record
                  // it FIRST so the object-permanence gate (issue #68) can
                  // recover the kid-facing name next session. body.name is the
                  // schematic id; not the kid's name.
                  const kidName = body && typeof body.kid_name === 'string' && body.kid_name.trim()
                    ? body.kid_name.trim()
                    : null;
                  const label = kidName ? `${kidName} (${schemName})` : schemName;
                  autoRememberFact(`Built ${label} for kid at ${x},${y},${z} (${placed}/${total} blocks). Schematic build.`);
                }
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        const _origBuildTower = ACTIONS.build_tower;
        if (_origBuildTower) {
          ACTIONS.build_tower = async (body) => {
            const result = await _origBuildTower(body);
            try {
              const x = body.x, y = body.y, z = body.z, mat = body.material;
              const r = result?.result || '';
              const m = r.match(/(\d+)\/(\d+)/);
              if (m && Number(m[1]) > 0) {
                const kidName = body && typeof body.kid_name === 'string' && body.kid_name.trim()
                  ? body.kid_name.trim()
                  : null;
                const label = kidName ? `${kidName} (${mat || 'block'} tower)` : `${mat || 'block'} tower`;
                autoRememberFact(`Built ${label} at ${x},${y},${z} (${m[1]}/${m[2]} blocks). Kid build.`);
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        const _origGiveToPlayer = ACTIONS.give_to_player;
        if (_origGiveToPlayer) {
          ACTIONS.give_to_player = async (body) => {
            const result = await _origGiveToPlayer(body);
            try {
              const r = result?.result || '';
              if (/gave|tossed|delivered/i.test(r) || /^\s*Sent /i.test(r)) {
                autoRememberFact(`Gave ${body.count || ''} ${body.item} to ${body.player}.`);
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        const _origFindBlocks = ACTIONS.find_blocks;
        if (_origFindBlocks) {
          ACTIONS.find_blocks = async (body) => {
            const result = await _origFindBlocks(body);
            try {
              // find_blocks returns `{ result: "Found 5 iron_ore", locations: [{x,y,z}, ...] }`
              // — coords are in `locations`, NOT the result string.
              const locs = Array.isArray(result?.locations) ? result.locations : [];
              if (locs.length > 0) {
                const nearest = locs[0];
                if (typeof nearest.x === 'number' && typeof nearest.y === 'number' && typeof nearest.z === 'number') {
                  const blockName = body.block || body.type || 'block';
                  autoRememberFact(`Found ${blockName} vein at ${nearest.x},${nearest.y},${nearest.z} (${locs.length} block${locs.length === 1 ? '' : 's'} visible).`);
                }
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        const _origLightArea = ACTIONS.light_area;
        if (_origLightArea) {
          ACTIONS.light_area = async (body) => {
            const result = await _origLightArea(body);
            try {
              const r = result?.result || '';
              const m = r.match(/(\d+)/);
              if (m && Number(m[1]) > 0) {
                autoRememberFact(`Lit area around ${body.cx},${body.cy},${body.cz} with ${m[1]} torches.`);
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        const _origPlaceNearPlayer = ACTIONS.place_near_player;
        if (_origPlaceNearPlayer) {
          ACTIONS.place_near_player = async (body) => {
            const result = await _origPlaceNearPlayer(body);
            try {
              const r = result?.result || '';
              if (/placed|put|set/i.test(r) && !/cannot|couldn't/i.test(r)) {
                autoRememberFact(`Placed ${body.item} near ${body.player}.`);
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        for (const collectVerb of ['collect', 'bg_collect']) {
          const orig = ACTIONS[collectVerb];
          if (!orig) continue;
          ACTIONS[collectVerb] = async (body) => {
            const result = await orig(body);
            try {
              const r = result?.result || '';
              const m = r.match(/(?:Collected|collected|gathered|mined)\s+(\d+)(?:\/\d+)?\s+([\w_-]+)/);
              if (m) {
                const [, count, item] = m;
                if (Number(count) > 0) {
                  const pos = bot?.entity?.position;
                  const where = pos ? ` at ~${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '';
                  autoRememberFact(`Mined ${count} ${item}${where}.`);
                }
              }
            } catch { /* swallow */ }
            return result;
          };
        }
        log('high-level skills registered: place_near_player, give_to_player, build_tower, light_area, follow_player_v2 + auto-memory wrappers on 8 marquee verbs (#68)');
      } catch (e) {
        log(`skill registration failed: ${e.message}`);
      }
      try {
        if (_bark_tear_down) _bark_tear_down();
        _bark_tear_down = installBarksAndPresence(bot, { characterName: config.mc.username });
        log(`presence loop installed for ${config.mc.username} (idle barks + gaze on proximity)`);
      } catch (e) {
        log(`presence loop install failed: ${e.message}`);
      }

      // Quest engine — state-machine driver for kid-play storylines.
      // Loads vendor/hermescraft/bot/quests/*.json and watches for player
      // chat, position, item-collect, timer triggers.
      try {
        if (_quest_tear_down) _quest_tear_down();
        installQuestEngine(bot, ACTIONS, log).then((teardown) => {
          _quest_tear_down = teardown;
        }).catch((e) => log(`quest engine install failed: ${e.message}`));
      } catch (e) {
        log(`quest engine sync failure: ${e.message}`);
      }

      // Survival tick — rule-based background loops (hunger/health/torch/
      // unstuck). Zero LLM calls. Enables survival_easy mode by keeping the
      // bot alive between kid-directed turns. SURVIVAL_TICK_ENABLED=0 to
      // disable in peaceful-mode deployments.
      try {
        if (_survival_tear_down) _survival_tear_down();
        _survival_tear_down = startSurvivalTick(bot, log);
      } catch (e) {
        log(`survival tick install failed: ${e.message}`);
      }

      // ── Reactive Events ──────────────────────────────

      // Chat listener — name-routed message system
      bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        // All routing (chatLog vs overheardLog, commandQueue) handled by handleChat
        handleChat(username, message).catch(e => log(`Chat handler error: ${e.message}`));
      });

      bot.on('whisper', (username, message) => {
        if (username === bot.username) return;
        // Whispers are always for us — add directly to chatLog + commandQueue
        chatLog.push({ time: Date.now(), from: username, message, whisper: true });
        if (chatLog.length > MAX_LOG) chatLog.shift();
        log(`[Whisper] <${username}> ${message}`);
        commandQueue.push({
          id: nextEnvelopeId(),
          time: Date.now(), from: username, command: message,
          channel: 'whisper', source: 'chat',
          originalMessage: message, status: 'pending',
        });
        trimCommandQueue();
      });

      // Health tracking + combat stats
      bot.on('health', () => {
        if (bot.health < lastHealth) {
          const damage = lastHealth - bot.health;
          combatStats.damageTaken += damage;
          log(`Took ${damage.toFixed(1)} damage (HP: ${bot.health.toFixed(1)})`);
        }
        lastHealth = bot.health;
      });

      // Sound events: detect nearby entity digging
      bot.on('blockBreakProgressObserved', (block, destroyStage, entity) => {
        if (entity && entity !== bot.entity) {
          addSoundEvent('mining', block.position, FAIR_PLAY.SOUND_MINE_RADIUS);
        }
      });

      // Sound events: detect nearby entity sprinting/movement
      bot._soundCheckInterval = setInterval(() => {
        if (!bot || !botReady) return;
        Object.values(bot.entities).forEach(e => {
          if (e === bot.entity || !e.position) return;
          const vel = e.velocity;
          if (!vel) return;
          const speed = Math.sqrt(vel.x*vel.x + vel.z*vel.z);
          if (speed > 0.2) addSoundEvent('sprinting', e.position, FAIR_PLAY.SOUND_SPRINT_RADIUS);
          else if (speed > 0.05) addSoundEvent('walking', e.position, FAIR_PLAY.SOUND_WALK_RADIUS);
        });
      }, 2000);

      // Death tracking
      bot.on('death', () => {
        combatStats.deaths++;
        lastDeath = {
          time: Date.now(),
          position: posObj(),
          inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
          deathNumber: deathLog.length + 1
        };
        const entry = { time: Date.now(), position: posObj() };
        deathLog.push(entry);
        const locs = loadLocations(); locs['death_'+deathLog.length]={...posObj(),saved:new Date().toISOString()};saveLocations(locs);
        
        // Check if hardcore mode — if so, this is PERMANENT death
        if (bot.game?.hardcore || hardcoreDead) {
          hardcoreDead = true;
          log('☠ HARDCORE DEATH! This character is PERMANENTLY DEAD. No reconnect.');
          // Add a final chat message to the log so the agent knows
          chatLog.push({ 
            time: Date.now(), 
            from: 'SYSTEM', 
            message: 'YOU DIED IN HARDCORE MODE. You are permanently dead. Your story is over.',
            whisper: false 
          });
          return; // Don't respawn, don't reconnect
        }
        log('DIED! Respawning...');
      });

      // Kicked — log only, 'end' event fires after and handles reconnect
      bot.on('kicked', (reason) => {
        log(`Kicked: ${JSON.stringify(reason)}`);
        botReady = false;
      });

      // Disconnect — auto-reconnect with backoff (handles both kicks and drops)
      bot.on('end', (reason) => {
        log(`Disconnected: ${reason}`);
        botReady = false;
        positionHistory = []; // clear stuck detection history
        if (bot?._soundCheckInterval) { clearInterval(bot._soundCheckInterval); bot._soundCheckInterval = null; }
        if (_survival_tear_down) { _survival_tear_down(); _survival_tear_down = null; }
        
        // In hardcore mode, death = permanent. Don't reconnect.
        if (hardcoreDead) {
          log('☠ Hardcore death — staying disconnected. RIP.');
          return;
        }
        
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
        reconnectAttempts++;
        log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(() => {
          log('Attempting reconnect...');
          createBot().catch(e => log(`Reconnect failed: ${e.message}`));
        }, delay);
      });

      botReady = true;
      reconnectAttempts = 0;
      const locs = loadLocations(); if(!locs.spawn){locs.spawn={...posObj(),saved:new Date().toISOString()};saveLocations(locs);}
      log(`Connected! Spawned at ${fmt(bot.entity.position.x)}, ${fmt(bot.entity.position.y)}, ${fmt(bot.entity.position.z)}`);
      resolve(bot);
    });

    bot.on('error', (err) => {
      log(`Bot error: ${err.message}`);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(v) { return typeof v === 'number' ? Math.round(v * 10) / 10 : v; }

function posObj(pos) {
  const p = pos || bot?.entity?.position;
  if (!p) return null;
  return { x: fmt(p.x), y: fmt(p.y), z: fmt(p.z) };
}

function itemStr(item) {
  if (!item) return null;
  return { name: item.name, count: item.count };
}

function ensureBot() {
  if (!bot || !botReady || !bot.entity) {
    throw new Error('Bot not connected. POST /connect to retry.');
  }
  return bot;
}

// ═══════════════════════════════════════════════════════════════════
// Fair Play — Line-of-Sight & Perception
// ═══════════════════════════════════════════════════════════════════

function hasLineOfSight(from, to) {
  if (!bot || !botReady) return false;
  // Bresenham-style raycast through blocks
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (dist < 1) return true;
  const steps = Math.ceil(dist * 2); // check every 0.5 blocks
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const z = from.z + dz * t;
    const block = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (block && block.boundingBox === 'block') return false; // solid block blocks LOS
  }
  return true;
}

function canDetectEntity(entity) {
  if (!fairPlayMode || !bot || !botReady) return true; // no filtering if fair play off
  const pos = bot.entity.position;
  const dist = entity.position.distanceTo(pos);
  
  // Always detect entities within 3 blocks (melee range — you can hear/feel them)
  if (dist < 3) return true;
  
  // Sneaking entities: much shorter detection range
  const isSneaking = entity.metadata?.[6] === 5 || entity.crouching || (entity.pose === 'sneaking');
  if (isSneaking && dist > FAIR_PLAY.SNEAK_DETECT_RANGE) return false;
  
  // Beyond max range: invisible
  if (dist > FAIR_PLAY.LOS_ENTITY_RANGE) return false;
  
  // LOS check: raycast from bot eyes to entity center
  const eyeHeight = bot.entity.height * 0.85;
  const eyePos = pos.offset(0, eyeHeight, 0);
  const targetCenter = entity.position.offset(0, (entity.height || 1.8) * 0.5, 0);
  
  if (!hasLineOfSight(eyePos, targetCenter)) {
    // Can't see through walls — but check sound events
    // Mining/sprinting nearby creates sound events
    return false;
  }
  
  return true;
}

function filterEntitiesFairPlay(entities) {
  if (!fairPlayMode) return entities;
  return entities.filter(e => canDetectEntity(e));
}

function eyePosition(entity = bot?.entity) {
  if (!entity?.position) return null;
  return entity.position.offset(0, (entity.height || 1.62) * 0.85, 0);
}

function raycastFirstSolid(origin, direction, maxDistance = 16, step = 0.75) {
  for (let distance = step; distance <= maxDistance; distance += step) {
    const sample = new Vec3(
      origin.x + direction.x * distance,
      origin.y + direction.y * distance,
      origin.z + direction.z * distance,
    );
    const block = bot.blockAt(new Vec3(Math.floor(sample.x), Math.floor(sample.y), Math.floor(sample.z)));
    if (block && block.boundingBox === 'block' && block.name !== 'air' && block.name !== 'cave_air') {
      return { block, distance };
    }
  }
  return null;
}

function rememberObservedBlock(entry) {
  observedBlocks.set(makeBlockMemoryKey(entry.position, entry.name), {
    ...entry,
    lastSeen: Date.now(),
  });
  if (observedBlocks.size > 200) {
    const oldest = [...observedBlocks.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, observedBlocks.size - 200);
    oldest.forEach(([key]) => observedBlocks.delete(key));
  }
}

function scanVisibleBlocks({ range = 16, horizontalFov = 100, verticalFov = 36, horizontalRays = 7, verticalRays = 3 } = {}) {
  const b = ensureBot();
  const origin = eyePosition(b.entity);
  const hits = [];
  const seen = new Set();
  const baseYawDeg = (b.entity.yaw * 180) / Math.PI;
  const basePitchDeg = (b.entity.pitch * 180) / Math.PI;

  for (let yi = 0; yi < verticalRays; yi++) {
    const pitchOffset = verticalRays === 1 ? 0 : -verticalFov / 2 + (verticalFov * yi) / (verticalRays - 1);
    for (let xi = 0; xi < horizontalRays; xi++) {
      const yawOffset = horizontalRays === 1 ? 0 : -horizontalFov / 2 + (horizontalFov * xi) / (horizontalRays - 1);
      const yaw = ((baseYawDeg + yawOffset) * Math.PI) / 180;
      const pitch = ((basePitchDeg + pitchOffset) * Math.PI) / 180;
      const hit = raycastFirstSolid(origin, yawPitchToDir(yaw, pitch), range);
      if (!hit) continue;
      const key = `${hit.block.name}@${hit.block.position.x},${hit.block.position.y},${hit.block.position.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dx = hit.block.position.x - b.entity.position.x;
      const dz = hit.block.position.z - b.entity.position.z;
      const bearing = bearingFromDelta(dx, dz);
      const relativeAngle = angleDiffDegrees(baseYawDeg, (Math.atan2(dx, -dz) * 180) / Math.PI);
      const sector = classifySector(relativeAngle);
      const entry = {
        name: hit.block.name,
        position: posObj(hit.block.position),
        distance: fmt(hit.distance),
        bearing,
        sector,
      };
      hits.push(entry);
      rememberObservedBlock(entry);
    }
  }

  return hits.sort((a, b) => a.distance - b.distance);
}

function detectHazardsFromVisibleBlocks(blocks) {
  return blocks
    .filter((block) => ['lava', 'flowing_lava', 'fire', 'campfire'].includes(block.name))
    .slice(0, 5)
    .map((block) => `${block.name} ${block.sector} ${block.distance}m`);
}

function buildSceneSummary({ range = 16 } = {}) {
  const b = ensureBot();
  const visibleBlocks = fairPlayMode ? scanVisibleBlocks({ range }) : scanVisibleBlocks({ range: Math.min(range, 24), horizontalFov: 140, verticalFov: 50, horizontalRays: 9, verticalRays: 4 });
  const pos = b.entity.position;
  const visibleEntities = filterEntitiesFairPlay(Object.values(b.entities)
    .filter((entity) => entity !== b.entity && entity.position.distanceTo(pos) <= Math.min(range + 8, 24)))
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
    .slice(0, 8)
    .map((entity) => ({
      type: entity.username || entity.name || entity.displayName || 'unknown',
      distance: fmt(entity.position.distanceTo(pos)),
      bearing: bearingFromDelta(entity.position.x - pos.x, entity.position.z - pos.z),
      kind: entity.type || (entity.username ? 'player' : 'mob'),
      health: entity.health ?? undefined,
    }));
  const lookingAt = b.blockAtCursor?.(5);
  const hazards = detectHazardsFromVisibleBlocks(visibleBlocks);
  const summary = summarizeSceneText({
    lookingAt: lookingAt ? { name: lookingAt.name, position: posObj(lookingAt.position) } : null,
    visibleBlocks,
    visibleEntities,
    hazards,
    sounds: soundEvents.slice(-5),
    memoryHints: getMemoryHints(),
  });

  return {
    summary,
    visible_blocks: summarizeVisibleBlocks(visibleBlocks),
    visible_block_hits: visibleBlocks,
    visible_entities: visibleEntities,
    hazards,
    looking_at: lookingAt ? { name: lookingAt.name, position: posObj(lookingAt.position) } : null,
    sounds: soundEvents.slice(-5),
    memory_hints: getMemoryHints(),
    fair_play: fairPlayMode,
    range,
  };
}

function findVisibleBlocksByName(blockName, { range = 16, count = 10 } = {}) {
  const needle = String(blockName || '').toLowerCase();
  return scanVisibleBlocks({ range })
    .filter((entry) => entry.name.toLowerCase() === needle)
    .slice(0, count);
}

function addSoundEvent(type, position, radius) {
  if (!bot || !botReady) return;
  const dist = bot.entity.position.distanceTo(position);
  if (dist > radius) return;
  
  // Rough direction (N/S/E/W/NE/etc)
  const dx = position.x - bot.entity.position.x;
  const dz = position.z - bot.entity.position.z;
  const angle = Math.atan2(dz, dx) * 180 / Math.PI;
  let dir;
  if (angle > -22.5 && angle <= 22.5) dir = 'east';
  else if (angle > 22.5 && angle <= 67.5) dir = 'southeast';
  else if (angle > 67.5 && angle <= 112.5) dir = 'south';
  else if (angle > 112.5 && angle <= 157.5) dir = 'southwest';
  else if (angle > 157.5 || angle <= -157.5) dir = 'west';
  else if (angle > -157.5 && angle <= -112.5) dir = 'northwest';
  else if (angle > -112.5 && angle <= -67.5) dir = 'north';
  else dir = 'northeast';
  
  soundEvents.push({
    time: Date.now(),
    type, // 'mining', 'sprinting', 'walking', 'combat', 'explosion'
    direction: dir,
    distance: fmt(dist),
    approximate: true,
  });
  // Keep only last 20 events, last 30 seconds
  soundEvents = soundEvents.filter(e => Date.now() - e.time < 30000).slice(-20);
}

async function reactionDelay() {
  if (!fairPlayMode) return;
  const delay = FAIR_PLAY.REACTION_MIN_MS + Math.random() * (FAIR_PLAY.REACTION_MAX_MS - FAIR_PLAY.REACTION_MIN_MS);
  await sleep(delay);
}

// Brief state snapshot (included in action responses)
// Includes any new chat messages so the AI sees them after every action
function briefState() {
  if (!bot || !botReady) return null;

  // Grab recent chat so AI sees messages that arrived during action.
  // Direct messages (whispers, name-routed DMs) are shown fully.
  // Nearby broadcasts are capped at 2 most recent to reduce cascade noise.
  const now = Date.now();
  const recentAll = chatLog
    .filter(m => now - m.time < 30000 && m.from !== bot.username);
  const directMsgs = recentAll.filter(m => m.private || m.whisper);
  const broadcastMsgs = recentAll.filter(m => !m.private && !m.whisper).slice(-2);
  const recentChat = [...directMsgs, ...broadcastMsgs]
    .sort((a, b) => a.time - b.time)
    .map(m => ({
      from: m.from,
      message: m.message,
      ago: Math.round((now - m.time) / 1000) + 's',
      ...(m.private || m.whisper ? { direct: true } : {}),
    }));

  // Grab pending commands
  const pending = commandQueue.filter(c => c.status === 'pending');

  const state = {
    health: fmt(bot.health),
    food: bot.food,
    position: posObj(),
    holding: bot.heldItem?.name || 'empty',
    time: bot.time.timeOfDay,
    isDay: bot.time.timeOfDay < 12000,
  };

  if (recentChat.length > 0) state.new_chat = recentChat;
  if (pending.length > 0) state.pending_commands = pending.length;
  const recentSocial = socialEvents.filter((entry) => now - entry.time < 60000).slice(-3)
    .map((entry) => `${entry.actor} ${entry.kind} via ${entry.channel}`);
  if (recentSocial.length > 0) state.social = recentSocial;

  // Water hazard — surfaces immediately so agent can react
  if (bot.entity.isInWater) {
    state.hazard = 'SUBMERGED in water — mc stop then mc jump to swim up, navigate to shore';
  }

  // Repeated-failure loop detection
  const recent3 = actionHistory.slice(-3);
  if (recent3.length === 3 && recent3.every(e => e.status !== 'done' && e.action === recent3[0].action)) {
    state.action_loop = `You've tried "${recent3[0].action}" 3 times and failed — check mc inventory first, then try something different`;
  }

  // Show count of overheard messages (other agents' private conversations)
  const recentOverheard = overheardLog.filter(m => now - m.time < 60000).length;
  if (recentOverheard > 0) state.overheard_nearby = recentOverheard;
  if (currentTask && currentTask.status === 'stuck') state.task_stuck = currentTask.error;
  if (currentTask && currentTask.status === 'running') {
    state.task = { action: currentTask.action, elapsed: Math.round((Date.now() - currentTask.started) / 1000) + 's' };
  } else if (currentTask && currentTask.status === 'done') {
    state.task_done = currentTask.result?.result || 'completed';
  } else if (currentTask && currentTask.status === 'error') {
    state.task_error = currentTask.error;
  }

  return state;
}

// ═══════════════════════════════════════════════════════════════════
// State Collection
// ═══════════════════════════════════════════════════════════════════

function getFullState() {
  const b = ensureBot();
  const pos = b.entity.position;
  const inv = b.inventory.items();
  const time = b.time.timeOfDay;

  // Nearby entities (fair-play filtered)
  const rawEntities = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(pos) < (fairPlayMode ? FAIR_PLAY.LOS_ENTITY_RANGE : 24));
  const visibleEntities = filterEntitiesFairPlay(rawEntities);
  const entities = visibleEntities
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
    .slice(0, 15)
    .map(e => ({
      type: e.name || e.mobType || e.displayName || 'unknown',
      kind: e.type || (e.username ? 'player' : 'mob'),
      username: e.username || undefined,
      distance: fmt(e.position.distanceTo(pos)),
      position: posObj(e.position),
      health: e.health ?? undefined,
    }));

  // Nearby blocks (scan 5-block radius, aggregate by type)
  const blockCounts = {};
  const notableBlocks = []; // specific blocks worth calling out
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -3; dy <= 4; dy++) {
      for (let dz = -5; dz <= 5; dz++) {
        const block = b.blockAt(pos.offset(dx, dy, dz));
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          blockCounts[block.name] = (blockCounts[block.name] || 0) + 1;
          // Note ores and interesting blocks with positions
          if (block.name.includes('ore') || block.name === 'crafting_table' || 
              block.name === 'furnace' || block.name === 'chest' ||
              block.name.includes('log') || block.name === 'water' ||
              block.name === 'lava') {
            if (notableBlocks.length < 20) {
              notableBlocks.push({
                name: block.name,
                position: { x: block.position.x, y: block.position.y, z: block.position.z },
              });
            }
          }
        }
      }
    }
  }

  const nearbyBlocks = Object.entries(blockCounts)
    .sort((a, c) => c[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  // What we're looking at
  const scene = buildSceneSummary({ range: 16 });
  const target = b.blockAtCursor?.(5);
  const lookingAt = target ? { name: target.name, position: posObj(target.position) } : null;

  // Biome
  const biome = b.blockAt(pos)?.biome?.name || 'unknown';

  // Unread chat
  const unreadChat = chatLog.length > 0 ? chatLog.slice(-5).map(m => ({
    from: m.from, message: m.message,
    ago: Math.round((Date.now() - m.time) / 1000) + 's',
  })) : [];

  return {
    health: fmt(b.health),
    maxHealth: 20,
    food: b.food,
    saturation: fmt(b.foodSaturation),
    position: posObj(),
    dimension: b.game?.dimension?.replace('minecraft:', '') || 'overworld',
    biome,
    time: time,
    isDay: time < 12000,
    timePhase: time < 6000 ? 'morning' : time < 12000 ? 'afternoon' : time < 18000 ? 'evening' : 'night',
    holding: bot.heldItem ? itemStr(bot.heldItem) : 'empty',
    experience: { level: b.experience?.level || 0 },
    inventory: inv.map(i => ({ name: i.name, count: i.count })),
    inventoryCount: inv.length,
    nearbyBlocks,
    notableBlocks,
    nearbyEntities: entities,
    nearbyPlayers: entities.filter(e => e.kind === 'player').map(p => ({ name: p.username || p.type, distance: p.distance, position: p.position })),
    lookingAt,
    unreadChat: unreadChat.length > 0 ? unreadChat : undefined,
    deaths: deathLog.length,
    lastDeath: lastDeath ? { position: lastDeath.position, seconds_ago: Math.round((Date.now()-lastDeath.time)/1000) } : null,
    onGround: b.entity.onGround,
    isRaining: b.isRaining,
    isSneaking: isSneaking,
    // Fair play: sound events (directional hints without exact positions)
    sounds: soundEvents.length > 0 ? soundEvents.slice(-5) : undefined,
    scene,
    social_summary: summarizeSocialGraph(socialGraph),
    // Team info
    team: teamConfig.team ? {
      name: teamConfig.team,
      role: teamConfig.role,
      rallyPoint: teamConfig.rallyPoint,
      recentTeamChat: teamConfig.teamChat.slice(-3),
    } : undefined,
    // Combat stats
    combatStats: (combatStats.kills + combatStats.deaths > 0) ? combatStats : undefined,
    // Active furnaces
    activeFurnaces: activeFurnaces.length > 0 ? activeFurnaces.map(f => ({
      position: { x: f.x, y: f.y, z: f.z },
      input: f.input,
      estimatedDone: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) + 's' : 'unknown',
    })) : undefined,
    fairPlay: fairPlayMode,
    hardcore: bot.game?.hardcore || false,
    permanentlyDead: hardcoreDead,
  };
}

function getInventory() {
  const b = ensureBot();
  const items = b.inventory.items();
  if (items.length === 0) return { items: [], summary: 'empty' };

  const categories = {};
  items.forEach(item => {
    const n = item.name;
    let cat = 'other';
    if (n.includes('pickaxe') || n.includes('_axe') || n.includes('shovel') || n.includes('hoe') || n === 'shears' || n === 'flint_and_steel') cat = 'tools';
    else if (n.includes('sword') || n.includes('bow') || n === 'crossbow' || n === 'trident') cat = 'weapons';
    else if (n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots') || n === 'shield') cat = 'armor';
    else if (n.includes('cooked') || n.includes('bread') || n.includes('apple') || n.includes('steak') || n.includes('porkchop') || n.includes('chicken') || n.includes('salmon') || n.includes('potato') || n === 'mushroom_stew') cat = 'food';
    else if (n.includes('ingot') || n.includes('diamond') || n.includes('coal') || n.includes('redstone') || n.includes('lapis') || n.includes('stick') || n.includes('string') || n.includes('flint') || n.includes('blaze') || n.includes('ender_pearl')) cat = 'materials';
    else if (mcData?.blocksByName[n]) cat = 'blocks';

    if (!categories[cat]) categories[cat] = [];
    categories[cat].push({ name: n, count: item.count });
  });

  return { categories, totalSlots: items.length };
}

function getNearby(radius = 32) {
  const b = ensureBot();
  const pos = b.entity.position;

  // Entities (fair-play filtered)
  const rawEnts = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(pos) < radius);
  const entities = filterEntitiesFairPlay(rawEnts)
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
    .slice(0, 20)
    .map(e => ({
      type: e.name || e.mobType || 'unknown',
      distance: fmt(e.position.distanceTo(pos)),
      position: posObj(e.position),
      health: e.health,
      kind: e.type, // 'mob', 'player', 'object', etc.
    }));

  // Notable blocks in wider radius
  const blockTypes = {};
  const scanR = Math.min(radius, 16); // block scan limited for performance
  for (let dx = -scanR; dx <= scanR; dx += 2) {
    for (let dy = -8; dy <= 8; dy++) {
      for (let dz = -scanR; dz <= scanR; dz += 2) {
        const block = b.blockAt(pos.offset(dx, dy, dz));
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'stone' && block.name !== 'dirt' && block.name !== 'grass_block' && block.name !== 'deepslate') {
          if (!blockTypes[block.name]) blockTypes[block.name] = { count: 0, nearest: null, nearestDist: Infinity };
          blockTypes[block.name].count++;
          const dist = pos.distanceTo(block.position);
          if (dist < blockTypes[block.name].nearestDist) {
            blockTypes[block.name].nearest = posObj(block.position);
            blockTypes[block.name].nearestDist = dist;
          }
        }
      }
    }
  }

  const blocks = Object.entries(blockTypes)
    .sort((a, c) => c[1].count - a[1].count)
    .slice(0, 25)
    .map(([name, info]) => ({ name, count: info.count, nearest: info.nearest }));

  return { entities, blocks, scanRadius: scanR };
}

// ═══════════════════════════════════════════════════════════════════
// Spatial Awareness — ASCII Map + Narrative Description
// ═══════════════════════════════════════════════════════════════════

// Generate a top-down ASCII map of the area around the bot
// This gives agents SPATIAL understanding — where things are relative to them
function generateMap(radius = 16) {
  const b = ensureBot();
  const pos = b.entity.position;
  const mapSize = Math.min(radius, 24); // cap at 24 for readability
  const step = mapSize > 16 ? 2 : 1; // downsample for large radii
  const gridR = Math.floor(mapSize / step);
  
  // Build a 2D grid (top-down, X=east, Z=south in MC)
  // Grid is [row][col] where row=north→south (Z), col=west→east (X)
  const grid = [];
  const heightMap = [];
  for (let rz = -gridR; rz <= gridR; rz++) {
    const row = [];
    const hrow = [];
    for (let rx = -gridR; rx <= gridR; rx++) {
      const wx = Math.floor(pos.x) + rx * step;
      const wz = Math.floor(pos.z) + rz * step;
      // Find surface block (scan down from above)
      let surfaceBlock = null;
      let surfaceY = 0;
      for (let dy = 8; dy >= -8; dy--) {
        const wy = Math.floor(pos.y) + dy;
        const block = b.blockAt(new Vec3(wx, wy, wz));
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          surfaceBlock = block;
          surfaceY = wy;
          break;
        }
      }
      row.push(surfaceBlock);
      hrow.push(surfaceY);
    }
    grid.push(row);
    heightMap.push(hrow);
  }
  
  // Map block types to characters
  function blockChar(block, y) {
    if (!block) return ' ';
    const n = block.name;
    if (n === 'water' || n === 'flowing_water') return '~';
    if (n === 'lava' || n === 'flowing_lava') return '!';
    if (n.includes('log') || n.includes('wood')) return 'T';
    if (n.includes('leaves')) return '*';
    if (n.includes('ore')) return '$';
    if (n === 'sand' || n === 'sandstone') return '.';
    if (n === 'gravel') return ',';
    if (n === 'grass_block') return '.';
    if (n === 'dirt' || n === 'coarse_dirt') return '.';
    if (n.includes('stone') || n === 'cobblestone') return '#';
    if (n === 'deepslate' || n.includes('deepslate')) return '#';
    if (n.includes('plank') || n.includes('slab') || n.includes('stair')) return '=';
    if (n === 'crafting_table') return 'C';
    if (n === 'furnace' || n === 'blast_furnace') return 'F';
    if (n === 'chest' || n === 'barrel') return 'B';
    if (n.includes('door')) return 'D';
    if (n === 'torch' || n === 'wall_torch' || n === 'lantern') return 'i';
    if (n === 'snow' || n === 'snow_block') return 'o';
    if (n.includes('ice')) return '-';
    if (n.includes('flower') || n.includes('tulip') || n.includes('daisy') || n === 'dandelion' || n === 'poppy') return '+';
    if (n === 'tall_grass' || n === 'short_grass' || n === 'fern') return '"';
    if (n === 'cactus') return 'I';
    if (n === 'sugar_cane' || n === 'bamboo') return '|';
    if (n === 'farmland' || n === 'wheat' || n.includes('crop')) return '%';
    if (n === 'bed' || n.includes('bed')) return 'b';
    return '.';
  }
  
  // Place entities on the map
  const entityMarkers = {};
  Object.values(b.entities).forEach(e => {
    if (e === b.entity) return;
    const dx = Math.round((e.position.x - pos.x) / step);
    const dz = Math.round((e.position.z - pos.z) / step);
    if (Math.abs(dx) <= gridR && Math.abs(dz) <= gridR) {
      const key = `${dz + gridR},${dx + gridR}`;
      if (e.type === 'player' || e.username) {
        entityMarkers[key] = '@'; // players
      } else if (e.name && (e.name.includes('zombie') || e.name.includes('skeleton') || 
                 e.name.includes('creeper') || e.name.includes('spider') || e.name.includes('enderman'))) {
        entityMarkers[key] = 'X'; // hostile mobs
      } else if (e.type === 'mob') {
        entityMarkers[key] = 'a'; // passive mobs (animals)
      }
    }
  });
  
  // Build the ASCII string
  const lines = [];
  lines.push('     ' + 'N');
  lines.push('     ' + '|');
  
  const width = gridR * 2 + 1;
  for (let rz = 0; rz < grid.length; rz++) {
    let line = '';
    if (rz === gridR) {
      line += 'W -- ';
    } else {
      line += '     ';
    }
    for (let rx = 0; rx < grid[rz].length; rx++) {
      if (rz === gridR && rx === gridR) {
        line += 'P'; // Player position
      } else {
        const key = `${rz},${rx}`;
        if (entityMarkers[key]) {
          line += entityMarkers[key];
        } else {
          line += blockChar(grid[rz][rx], heightMap[rz][rx]);
        }
      }
    }
    if (rz === gridR) {
      line += ' -- E';
    }
    lines.push(line);
  }
  
  lines.push('     ' + '|');
  lines.push('     ' + 'S');
  
  // Legend for what's on the map
  const legend = [];
  legend.push('P=you @=player X=hostile a=animal');
  legend.push('T=tree ~=water !=lava $=ore #=stone');
  legend.push('C=craft F=furnace B=chest D=door b=bed');
  legend.push('=wall/floor .=ground "=grass +=flower');
  
  // Collect entity labels
  const entityLabels = [];
  Object.values(b.entities).forEach(e => {
    if (e === b.entity) return;
    const dist = e.position.distanceTo(pos);
    if (dist > mapSize) return;
    const dx = e.position.x - pos.x;
    const dz = e.position.z - pos.z;
    const dir = getCardinal(dx, dz);
    if (e.username) {
      entityLabels.push(`${e.username} (${dir}, ${fmt(dist)}m)`);
    } else if (e.name) {
      entityLabels.push(`${e.name} (${dir}, ${fmt(dist)}m)`);
    }
  });
  
  return {
    map: lines.join('\n'),
    legend: legend.join('\n'),
    entities_on_map: entityLabels.slice(0, 15),
    center: posObj(),
    radius: mapSize,
    scale: step > 1 ? `1 char = ${step} blocks` : '1 char = 1 block',
  };
}

function getCardinal(dx, dz) {
  // MC: +X=east, +Z=south
  const angle = Math.atan2(dx, -dz) * 180 / Math.PI; // 0=north
  if (angle > -22.5 && angle <= 22.5) return 'N';
  if (angle > 22.5 && angle <= 67.5) return 'NE';
  if (angle > 67.5 && angle <= 112.5) return 'E';
  if (angle > 112.5 && angle <= 157.5) return 'SE';
  if (angle > 157.5 || angle <= -157.5) return 'S';
  if (angle > -157.5 && angle <= -112.5) return 'SW';
  if (angle > -112.5 && angle <= -67.5) return 'W';
  return 'NW';
}

// Generate a narrative description of surroundings — like what a human would SEE
function generateLookAround() {
  const b = ensureBot();
  const pos = b.entity.position;
  const parts = [];
  
  // Time and weather
  const time = b.time.timeOfDay;
  const phase = time < 3000 ? 'early morning' : time < 6000 ? 'morning' : time < 9000 ? 'midday' : 
                time < 12000 ? 'afternoon' : time < 13500 ? 'sunset' : time < 18000 ? 'evening' : 'night';
  parts.push(`It's ${phase}${b.isRaining ? ', raining' : ''}.`);
  
  // Immediate terrain
  const biome = b.blockAt(pos)?.biome?.name || 'unknown';
  const ground = b.blockAt(pos.offset(0, -1, 0))?.name || 'unknown';
  parts.push(`Standing on ${ground} in ${biome.replace(/_/g, ' ')}.`);
  
  // Height context (above/below ground level approximation)
  const y = Math.floor(pos.y);
  if (y > 90) parts.push(`High up (Y:${y}).`);
  else if (y < 50) parts.push(`Underground (Y:${y}).`);
  else parts.push(`Y:${y}.`);
  
  // Scan each cardinal direction for notable features
  const directions = [
    { name: 'North', dx: 0, dz: -1 },
    { name: 'East', dx: 1, dz: 0 },
    { name: 'South', dx: 0, dz: 1 },
    { name: 'West', dx: -1, dz: 0 },
  ];
  
  for (const dir of directions) {
    const features = [];
    let hasWater = false, hasTrees = false, hasStone = false, hasBuilding = false;
    let terrainDelta = 0;
    
    for (let dist = 2; dist <= 20; dist += 2) {
      const wx = Math.floor(pos.x) + dir.dx * dist;
      const wz = Math.floor(pos.z) + dir.dz * dist;
      
      // Check a column
      for (let dy = -4; dy <= 10; dy++) {
        const block = b.blockAt(new Vec3(wx, Math.floor(pos.y) + dy, wz));
        if (!block || block.name === 'air') continue;
        if (block.name === 'water' || block.name === 'flowing_water') hasWater = true;
        if (block.name.includes('log')) hasTrees = true;
        if (block.name.includes('plank') || block.name.includes('stair') || block.name === 'cobblestone_wall') hasBuilding = true;
        if (dy > 4 && block.name !== 'leaves' && block.name !== 'air') terrainDelta++;
      }
      
      // Check surface height difference
      for (let sy = 20; sy >= -10; sy--) {
        const block = b.blockAt(new Vec3(wx, Math.floor(pos.y) + sy, wz));
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'leaves') {
          const surfaceY = Math.floor(pos.y) + sy;
          if (Math.abs(surfaceY - pos.y) > 5) {
            if (surfaceY > pos.y + 5) hasStone = true; // cliff/hill
          }
          break;
        }
      }
    }
    
    const desc = [];
    if (hasBuilding) desc.push('structures');
    if (hasTrees) desc.push('trees');
    if (hasWater) desc.push('water');
    if (hasStone) desc.push('high ground');
    if (desc.length > 0) {
      features.push(`${dir.name}: ${desc.join(', ')}`);
    } else {
      features.push(`${dir.name}: open terrain`);
    }
    parts.push(...features);
  }
  
  // Nearby players with directions
  const players = Object.values(b.entities)
    .filter(e => e !== b.entity && e.username && e.position.distanceTo(pos) < 40)
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));
  
  if (players.length > 0) {
    const playerDescs = players.map(p => {
      const dx = p.position.x - pos.x;
      const dz = p.position.z - pos.z;
      return `${p.username} ${getCardinal(dx, dz)} ${fmt(p.position.distanceTo(pos))}m`;
    });
    parts.push(`Players: ${playerDescs.join(', ')}`);
  }
  
  // Nearby threats
  const threats = Object.values(b.entities)
    .filter(e => {
      if (e === b.entity || e.type !== 'mob') return false;
      const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'phantom'];
      return hostile.some(h => (e.name || '').includes(h)) && e.position.distanceTo(pos) < 20;
    })
    .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));
  
  if (threats.length > 0) {
    const threatDescs = threats.slice(0, 5).map(t => {
      const dx = t.position.x - pos.x;
      const dz = t.position.z - pos.z;
      return `${t.name} ${getCardinal(dx, dz)} ${fmt(t.position.distanceTo(pos))}m`;
    });
    parts.push(`⚠ THREATS: ${threatDescs.join(', ')}`);
  }
  
  // Nearby animals (food)
  const animals = Object.values(b.entities)
    .filter(e => {
      if (e === b.entity || e.type !== 'mob') return false;
      const passive = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'];
      return passive.some(a => (e.name || '').includes(a)) && e.position.distanceTo(pos) < 25;
    });
  
  if (animals.length > 0) {
    const animalCounts = {};
    animals.forEach(a => { animalCounts[a.name] = (animalCounts[a.name] || 0) + 1; });
    const animalDesc = Object.entries(animalCounts).map(([n, c]) => `${c}x${n}`).join(', ');
    parts.push(`Animals nearby: ${animalDesc}`);
  }
  
  return {
    description: parts.join(' '),
    position: posObj(),
    biome: biome.replace(/_/g, ' '),
    time_phase: phase,
    light_level: b.blockAt(pos)?.light || 0,
  };
}


// ═══════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════

const ACTIONS = {
  // ── Perception (council-converged structural fix, 2026-05-16) ────────
  //
  // Per Gemini + Mistral council + SOTA research: bots' chat-theater
  // failure mode is information asymmetry, not prompt failure. The LLM
  // can't promise what it doesn't know it can do. This aggregates
  // getFullState + nearby + inventory into a compact Voyager-shaped
  // English block — meant to be the FIRST tool call every action turn.
  //
  // Voyager's `action_template.txt` fields: biome, time, position, HP,
  // hunger, equipment, inventory, nearby blocks, nearby entities, chat,
  // task. Compact YAML keeps the token budget low.
  async perceive(_body) {
    const b = ensureBot();
    const state = getFullState();
    const data = state.data || state;
    const pos = data.position || {};
    const lines = [];
    lines.push(`## you are at ${fmt(pos.x)},${fmt(pos.y)},${fmt(pos.z)} in ${data.biome || 'unknown'}; time=${data.time || '?'} (${data.timePhase || '?'}); hp=${data.health || '?'}/20 food=${data.food || '?'}/20; weather=${data.weather || 'clear'}`);
    // Inventory
    const inv = (data.inventory || []).slice(0, 12);
    if (inv.length === 0) {
      lines.push('## inventory: EMPTY');
    } else {
      lines.push('## inventory: ' + inv.map(i => `${i.name}x${i.count}`).join(', '));
    }
    // Holding
    if (data.holding) {
      const h = typeof data.holding === 'object' ? `${data.holding.name}x${data.holding.count}` : data.holding;
      lines.push(`## holding: ${h}`);
    }
    // Nearby blocks (aggregate counts)
    const nearby = getNearby(16);
    const blocks = nearby.blocks || nearby.blocks_by_type || [];
    if (Array.isArray(blocks)) {
      const summary = blocks.slice(0, 12).map(b => `${b.name}x${b.count || 1}${b.nearest ? `@(${b.nearest.x},${b.nearest.y},${b.nearest.z})` : ''}`).join(', ');
      lines.push(`## nearby blocks (r=16): ${summary || 'none notable'}`);
    }
    // Nearby entities (players + mobs)
    const ents = (data.entities || []).slice(0, 8);
    if (ents.length > 0) {
      lines.push('## nearby entities: ' + ents.map(e => `${e.username || e.type}@${e.distance}m`).join(', '));
    }
    // Recent chat (last 5 lines for context)
    const chat = data.chat_log || data.recentChat || [];
    if (Array.isArray(chat) && chat.length > 0) {
      lines.push('## recent chat:');
      for (const m of chat.slice(-5)) {
        const txt = typeof m === 'string' ? m : `<${m.from || '?'}> ${m.message || m.text || ''}`;
        lines.push(`  - ${txt.slice(0, 120)}`);
      }
    }
    // Pending commands (kid requests waiting for action)
    if (data.pending_commands && data.pending_commands > 0) {
      lines.push(`## pending kid requests: ${data.pending_commands} (run mc commands to drain)`);
    }
    // ── Memory anchors (issue #68 Phase C fix; gemini council 2026-05-20) ──
    // Inject nearby named-build entries from MEMORY.md as live sensory data.
    // The brain skips pure-recall replies because §1.0d ("world must change
    // THIS turn") makes chat-only turns feel like no-ops. But if the perceive
    // output INCLUDES the named build as a "you can see" anchor, referencing
    // it becomes a grounded act — same as referencing a nearby block or entity.
    // Bot reads its own MEMORY.md (HERMES_COMPANION_HOME injected by launcher),
    // extracts "Built X (or similar) at A,B,C" entries within 200 blocks, and
    // surfaces them alongside nearby blocks. Cheap on-disk read (<5ms), no API.
    try {
      const anchors = readMemoryAnchorsNear(pos, 200, 6);
      if (anchors.length > 0) {
        lines.push('## remembered nearby builds (from your memory.md):');
        for (const a of anchors) {
          lines.push(`  - ${a.label} at ${a.x},${a.y},${a.z} (${a.distance}m away)`);
        }
      }
    } catch (e) {
      // never fail perceive due to memory read; log + continue
      log(`[memory-anchors] perceive read failed: ${e.message}`);
    }
    return { result: lines.join('\n') };
  },

  // ── Movement ─────────────────────────────────────
  async goto({ x, y, z }) {
    const b = ensureBot();
    const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    // Timeout after 15s to prevent blocking the agent forever
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
    try {
      await Promise.race([b.pathfinder.goto(goal), timeout]);
      return { result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
    } catch (e) {
      try { b.pathfinder.setGoal(null); } catch {}
      const pos = posObj();
      if (e.message === 'timeout') return { result: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances.` };
      return { result: `Navigation failed: ${e.message}. Try mc bg_goto instead.` };
    }
  },

  async goto_near({ x, y, z, range = 2 }) {
    const b = ensureBot();
    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
    try {
      await Promise.race([b.pathfinder.goto(goal), timeout]);
      return { result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
    } catch (e) {
      try { b.pathfinder.setGoal(null); } catch {}
      const pos = posObj();
      if (e.message === 'timeout') return { result: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances.` };
      return { result: `Navigation failed: ${e.message}. Try mc bg_goto instead.` };
    }
  },

  async follow({ player }) {
    const b = ensureBot();
    const entity = Object.values(b.entities).find(e =>
      e !== b.entity && (
        (e.username || '').toLowerCase() === player.toLowerCase() ||
        (e.name || '').toLowerCase() === player.toLowerCase()
      )
    );
    if (!entity) throw new Error(`Player/entity "${player}" not found nearby.`);
    b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
    return { result: `Following ${player}. Use /action/stop to stop.` };
  },

  async look({ x, y, z }) {
    const b = ensureBot();
    await b.lookAt(new Vec3(x, y, z));
    return { result: `Looking at ${x}, ${y}, ${z}` };
  },

  async stop() {
    const b = ensureBot();
    b.pathfinder.setGoal(null);
    try { b.stopDigging(); } catch {}
    if (b.pvp) try { b.pvp.stop(); } catch {}
    return { result: 'Stopped all actions.' };
  },

  // ── Mining ───────────────────────────────────────
  async collect({ block, count = 1 }) {
    const b = ensureBot();
    const blockType = mcData.blocksByName[block];
    if (!blockType) throw new Error(`Unknown block "${block}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`);

    // Cap at 20 per call — chat piggybacks on the response so AI sees it
    const batchSize = Math.min(count, 20);

    const found = fairPlayMode
      ? findVisibleBlocksByName(block, { range: 16, count: batchSize * 3 }).map((entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z))
      : b.findBlocks({
          matching: blockType.id,
          maxDistance: 64,
          count: batchSize * 3,
        });

    if (found.length === 0) {
      throw new Error(fairPlayMode
        ? `Can't see any ${block} right now. Turn, move, or use mc scene/mc look before collecting.`
        : `No ${block} found within 64 blocks.`);
    }

    // Filter out blocks directly under the bot (never dig straight down!)
    const botPos = b.entity.position;
    const safe = found.filter(pos => {
      // Skip blocks directly below us (within 1 block horizontally, any depth below)
      if (Math.abs(pos.x - Math.floor(botPos.x)) < 1 && 
          Math.abs(pos.z - Math.floor(botPos.z)) < 1 && 
          pos.y < Math.floor(botPos.y)) return false;
      return true;
    });

    if (safe.length === 0) throw new Error(`No safely reachable ${block} found.`);

    let collected = 0;
    for (const pos of safe.slice(0, batchSize)) {
      try {
        const target = b.blockAt(pos);
        if (!target || target.name !== block) continue;
        await b.tool.equipForBlock(target);
        if (b.entity.position.distanceTo(pos) > 4.5) {
          await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
        }
        await b.dig(target, true);
        collected++;
        await sleep(200);
      } catch (err) {
        log(`[collect] Error mining ${block} at ${pos.x},${pos.y},${pos.z}: ${err.message}`);
      }
    }

    // Auto-pickup: walk through nearby drops to collect them
    await sleep(600);
    for (let attempt = 0; attempt < 3; attempt++) {
      const drops = Object.values(b.entities)
        .filter(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(b.entity.position) < 12)
        .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position));
      if (drops.length === 0) break;
      for (const drop of drops.slice(0, 6)) {
        try {
          await b.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
          await sleep(400);
        } catch {}
      }
    }

    // Report what we actually have now
    const invCount = b.inventory.items().filter(i => i.name === block).reduce((s, i) => s + i.count, 0);
    const remaining = count - collected;
    const msg = remaining > 0
      ? `Mined ${collected} ${block} (${remaining} more needed). Have ${invCount} ${block} in inventory.`
      : `Mined ${collected}/${count} ${block}. Have ${invCount} ${block} in inventory.`;
    return { result: msg };
  },

  async dig({ x, y, z }) {
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    if (!target || target.name === 'air') throw new Error(`No block at ${x}, ${y}, ${z}`);
    await b.tool.equipForBlock(target);
    if (b.entity.position.distanceTo(target.position) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    }
    await b.dig(target, true);
    return { result: `Mined ${target.name} at ${x}, ${y}, ${z}` };
  },

  async pickup() {
    const b = ensureBot();
    const invBefore = b.inventory.items().reduce((s, i) => s + i.count, 0);

    for (let attempt = 0; attempt < 3; attempt++) {
      const pos = b.entity.position;
      const drops = Object.values(b.entities)
        .filter(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(pos) < 16)
        .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));

      if (drops.length === 0) break;

      for (const drop of drops.slice(0, 8)) {
        try {
          await b.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
          await sleep(400);
        } catch {}
      }
    }

    const invAfter = b.inventory.items().reduce((s, i) => s + i.count, 0);
    const gained = invAfter - invBefore;
    return { result: gained > 0 ? `Picked up ${gained} items.` : 'No items to pick up.' };
  },

  // ── Find blocks ──────────────────────────────────
  async find_blocks({ block, radius = 32, count = 10 }) {
    const b = ensureBot();
    const blockType = mcData.blocksByName[block];
    if (!blockType) throw new Error(`Unknown block "${block}".`);

    const found = fairPlayMode
      ? findVisibleBlocksByName(block, { range: Math.min(radius, 24), count })
      : b.findBlocks({
          matching: blockType.id,
          maxDistance: Math.min(radius, 64),
          count,
        }).map((p) => ({ position: { x: p.x, y: p.y, z: p.z }, distance: fmt(b.entity.position.distanceTo(p)) }));

    if (found.length === 0) {
      return {
        result: fairPlayMode
          ? `No visible ${block} in the current view cone. Turn, move, or use mc scene to inspect.`
          : `No ${block} found within ${radius} blocks.`,
        locations: [],
      };
    }

    const locations = found.map((entry) => ({
      x: entry.position.x,
      y: entry.position.y,
      z: entry.position.z,
      distance: entry.distance,
      bearing: entry.bearing,
      sector: entry.sector,
    }));

    return { result: fairPlayMode ? `Found ${found.length} visible ${block}` : `Found ${found.length} ${block}`, locations };
  },

  // ── Find entities ────────────────────────────────
  async find_entities({ type, radius = 32 }) {
    const b = ensureBot();
    const pos = b.entity.position;
    let entities = Object.values(b.entities)
      .filter(e => e !== b.entity && e.position.distanceTo(pos) < radius);

    // Fair play: filter by line-of-sight
    entities = filterEntitiesFairPlay(entities);

    if (type) {
      entities = entities.filter(e =>
        (e.name || '').toLowerCase().includes(type.toLowerCase()) ||
        (e.username || '').toLowerCase().includes(type.toLowerCase()) ||
        (e.displayName || '').toLowerCase().includes(type.toLowerCase())
      );
    }

    entities = entities
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
      .slice(0, 20)
      .map(e => ({
        type: e.username || e.name || e.displayName || 'unknown',
        distance: fmt(e.position.distanceTo(pos)),
        position: posObj(e.position),
        health: e.health ?? undefined,
      }));

    return {
      result: `Found ${entities.length} ${type || 'entities'}`,
      locations: entities.map(e => ({ ...e.position, distance: e.distance, type: e.type })),
      entities,
    };
  },

  // ── Command queue management ────────────────────
  async complete_command({ index = 0 }) {
    if (commandQueue.length === 0) return { result: 'No commands in queue.' };
    // Accept both pending and stale entries (issue #68 Patch 2). Stale
    // entries surface on /commands so the brain can acknowledge them;
    // marking them done is the same FIFO motion.
    const surfaced = commandQueue.filter(c => c.status === 'pending' || c.status === 'stale');
    if (index >= surfaced.length) return { result: 'No pending command at that index.' };
    const wasStale = surfaced[index].status === 'stale';
    surfaced[index].status = 'completed';
    rememberSocialEvent({ actor: surfaced[index].from, kind: 'completed_command', channel: surfaced[index].channel || 'direct', message: surfaced[index].command });
    return { result: `Marked command as completed${wasStale ? ' (was stale)' : ''}: "${surfaced[index].command}"` };
  },

  // ── Crafting ─────────────────────────────────────
  async craft({ item, count = 1 }) {
    const b = ensureBot();
    const itemType = mcData.itemsByName[item];
    if (!itemType) throw new Error(`Unknown item "${item}". Check spelling.`);

    // Find nearby crafting table
    const table = b.findBlock({
      matching: mcData.blocksByName.crafting_table?.id,
      maxDistance: 4,
    });

    // Try all recipe sources: without table, with table, all recipes
    let recipes = b.recipesFor(itemType.id, null, 1, null);
    if ((!recipes || recipes.length === 0) && table) {
      recipes = b.recipesFor(itemType.id, null, 1, table);
    }
    // Fallback: try getting all recipes regardless
    if (!recipes || recipes.length === 0) {
      recipes = b.recipesAll(itemType.id, null, 1);
    }
    if (!recipes || recipes.length === 0) {
      throw new Error(`Can't craft ${item}. ${table ? 'Missing ingredients.' : 'Need a crafting table nearby (place one within 4 blocks).'} Use /action/recipes to check.`);
    }

    const recipe = recipes[0];
    const craftTable = (recipe.requiresTable !== false) ? table : null;

    await b.craft(recipe, count, craftTable || undefined);
    const resultCount = count * (recipe.result?.count || 1);
    return { result: `Crafted ${item} x${resultCount}` };
  },

  async recipes({ item }) {
    const b = ensureBot();
    const itemType = mcData.itemsByName[item];
    if (!itemType) throw new Error(`Unknown item "${item}".`);

    // Try multiple recipe lookup methods
    let recipes = b.recipesFor(itemType.id);
    if (!recipes || recipes.length === 0) {
      // Try with crafting table
      const table = b.findBlock({
        matching: mcData.blocksByName.crafting_table?.id,
        maxDistance: 4,
      });
      if (table) recipes = b.recipesFor(itemType.id, null, 1, table);
    }
    if (!recipes || recipes.length === 0) {
      // Try recipesAll
      try { recipes = b.recipesAll(itemType.id, null, 1); } catch {}
    }
    if (!recipes || recipes.length === 0) {
      return { result: `No crafting recipe for ${item}.`, recipes: [] };
    }

    const formatted = recipes.slice(0, 3).map(r => {
      const ingredients = {};
      const slots = r.inShape ? r.inShape.flat() : r.ingredients?.flat() || [];
      slots.filter(id => id && id !== -1).forEach(id => {
        const name = mcData.items[id]?.name || `id:${id}`;
        ingredients[name] = (ingredients[name] || 0) + 1;
      });
      return {
        ingredients,
        needsTable: r.requiresTable !== false,
        makes: r.result?.count || 1,
      };
    });

    return { result: `${formatted.length} recipe(s) for ${item}`, recipes: formatted };
  },

  async smelt({ input, fuel, count = 1 }) {
    const b = ensureBot();
    const furnaceBlock = b.findBlock({
      matching: block => block.name === 'furnace' || block.name === 'lit_furnace',
      maxDistance: 4,
    });
    if (!furnaceBlock) throw new Error('No furnace within 4 blocks. Place one first.');

    const furnace = await b.openFurnace(furnaceBlock);
    const inputItem = b.inventory.items().find(i => i.name === input);
    if (!inputItem) { furnace.close(); throw new Error(`No ${input} in inventory.`); }

    await furnace.putInput(inputItem.type, null, Math.min(count, inputItem.count));

    if (!furnace.fuelItem()) {
      const fuelNames = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];
      const fuelItem = fuel
        ? b.inventory.items().find(i => i.name === fuel)
        : b.inventory.items().find(i => fuelNames.includes(i.name));
      if (!fuelItem) { furnace.close(); throw new Error('No fuel. Need coal, planks, or logs.'); }
      await furnace.putFuel(fuelItem.type, null, Math.min(8, fuelItem.count));
    }

    // Wait briefly then check
    await sleep(Math.min(count * 10000, 30000));
    const output = furnace.outputItem();
    if (output) await furnace.takeOutput();
    furnace.close();

    return { result: output ? `Smelted ${output.name} x${output.count}` : `Smelting in progress. Check furnace later.` };
  },

  // ── Combat ───────────────────────────────────────
  async attack({ target }) {
    const b = ensureBot();
    await reactionDelay();
    const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned', 'phantom', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'cave_spider'];

    // Fair play: only attack visible entities
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    let entity;
    if (target) {
      entity = visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()));
    } else {
      entity = visible.find(e => hostiles.includes((e.name || '').toLowerCase()));
    }
    if (!entity) throw new Error(`No ${target || 'hostile mob'} found nearby.`);

    // Approach and attack
    if (entity.position.distanceTo(b.entity.position) > 3) {
      await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
    }
    await b.attack(entity);
    return { result: `Attacked ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m away)` };
  },

  async eat() {
    const b = ensureBot();
    const foods = b.inventory.items().filter(i => mcData.foodsByName?.[i.name]);
    if (foods.length === 0) throw new Error('No food in inventory.');
    foods.sort((a, c) => (mcData.foodsByName[c.name]?.foodPoints || 0) - (mcData.foodsByName[a.name]?.foodPoints || 0));
    await b.equip(foods[0], 'hand');
    await b.consume();
    return { result: `Ate ${foods[0].name}. Health: ${fmt(b.health)}, Food: ${b.food}` };
  },

  // ── Inventory ────────────────────────────────────
  async equip({ item, slot = 'hand' }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) {
      const available = b.inventory.items().map(i => i.name);
      throw new Error(`No ${item} in inventory. Have: ${[...new Set(available)].join(', ')}`);
    }
    await b.equip(invItem, slot);
    return { result: `Equipped ${item} to ${slot}` };
  },

  async toss({ item, count }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) throw new Error(`No ${item} in inventory.`);
    if (count && count > 0 && count < invItem.count) {
      await b.toss(invItem.type, null, count);
    } else {
      await b.tossStack(invItem);
    }
    return { result: `Tossed ${count || invItem.count} ${item}` };
  },

  // ── Building ─────────────────────────────────────
  async place({ block: blockName, x, y, z }) {
    const b = ensureBot();
    const item = b.inventory.items().find(i => i.name === blockName);
    if (!item) throw new Error(`No ${blockName} in inventory.`);

    await b.equip(item, 'hand');
    const targetPos = new Vec3(x, y, z);

    // Approach if far
    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    }

    // Find reference block to place against
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of offsets) {
      const ref = b.blockAt(targetPos.offset(dx, dy, dz));
      if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
        await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
        return { result: `Placed ${blockName} at ${x}, ${y}, ${z}` };
      }
    }
    throw new Error(`No solid block adjacent to ${x}, ${y}, ${z} to place against.`);
  },

  async place_fill({ block: blockName, x1, y1, z1, x2, y2, z2, hollow = false }) {
    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 500) throw new Error(`Area too large (${total} blocks, max 500). Split into smaller fills.`);

    // Strategy A — vanilla /fill via chat.  Op'd companion bots (Rosie, Steve
    // in `server/ops.json`) can run /fill directly; this works for aerial
    // placement (floors, walls, treehouse cantilevers) where mineflayer's
    // physical `placeBlock` fails because there's no adjacent solid block
    // to place against.  The earlier physical-placement path threw a stream
    // of `TypeError: Cannot read properties of undefined (reading 'type')`
    // unhandled rejections from inside mineflayer when asked to place into
    // air — `vendor.../bot/server.js#place_fill` rewrite 2026-05-16.
    //
    // We listen for the next Server confirmation line ("Successfully
    // filled N block(s)") and resolve with the count.  If we don't get a
    // confirmation within 4s OR we receive "Unknown or incomplete
    // command" (non-op fallback path), we fall through to physical
    // placement.
    const fillResult = await new Promise((resolve) => {
      const cmd = `/fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} ${blockName}${hollow ? ' hollow' : ''}`;
      let resolved = false;
      const onMsg = (jsonMsg) => {
        if (resolved) return;
        let txt = '';
        try { txt = (jsonMsg && typeof jsonMsg.toString === 'function') ? jsonMsg.toString() : ''; } catch { txt = ''; }
        if (!txt) return;
        const m = txt.match(/Successfully filled (\d+) block/);
        if (m) {
          resolved = true;
          b.removeListener('message', onMsg);
          resolve({ ok: true, placed: Number(m[1]), via: 'vanilla_fill' });
          return;
        }
        // Common rejection / non-op fallbacks
        if (/Unknown or incomplete command|requires.*permission|don't have permission|No targets matched/i.test(txt)) {
          resolved = true;
          b.removeListener('message', onMsg);
          resolve({ ok: false, reason: 'not_authorized_or_unknown', via: 'vanilla_fill' });
        }
      };
      b.on('message', onMsg);
      try { b.chat(cmd); } catch (e) { /* fall through */ }
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          b.removeListener('message', onMsg);
          resolve({ ok: false, reason: 'timeout', via: 'vanilla_fill' });
        }
      }, 4000);
    });

    if (fillResult.ok) {
      return { result: `Filled ${fillResult.placed} ${blockName} blocks via /fill (${hollow ? 'hollow' : 'solid'})` };
    }

    // Strategy B — physical mineflayer placement (fallback when /fill not
    // available; e.g. non-op bot, surviving the original 2025 contract).
    // Aerial cells will silently fail here — that's the cost of not being op.
    const positions = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (hollow) {
            const onEdge = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ;
            if (!onEdge) continue;
          }
          positions.push({ x, y, z });
        }
      }
    }

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let placed = 0;
    for (const pos of positions) {
      // Skip if block already there
      const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') continue;

      const item = b.inventory.items().find(i => i.name === blockName);
      if (!item) throw new Error(`Out of ${blockName} (placed ${placed}/${positions.length})`);
      try { await b.equip(item, 'hand'); } catch {}

      if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
        try { await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch {}
      }

      for (const [dx, dy, dz] of offsets) {
        const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
        if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
          try {
            await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
            placed++;
          } catch { /* swallow — usually no-LOS or out-of-reach */ }
          break;
        }
      }
    }
    return { result: `Placed ${placed}/${positions.length} ${blockName} blocks via physical placement (${hollow ? 'hollow' : 'solid'}; /fill unavailable: ${fillResult.reason})` };
  },

  async interact({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) throw new Error(`No block at ${x}, ${y}, ${z}`);
    if (b.entity.position.distanceTo(block.position) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
    }
    await b.activateBlock(block);
    return { result: `Interacted with ${block.name} at ${x}, ${y}, ${z}` };
  },

  async close_screen() {
    const b = ensureBot();
    if (b.currentWindow) b.closeWindow(b.currentWindow);
    return { result: 'Closed screen.' };
  },

  // ── Utility ──────────────────────────────────────
  async chat({ message, in_reply_to }) {
    // Voice-source routing (issue #54): if this reply addresses a pending
    // voice turn — either explicitly via in_reply_to, or auto-correlated to
    // the oldest dispatched voice turn within VOICE_AUTOCORRELATE_MS — route
    // the text to the voice loop's HTTP response. Fail-closed: voice replies
    // NEVER also fan out to public Minecraft chat (council 2026-05-17,
    // reviewer 2026-05-17). Kids hear the reply through their speaker; the
    // chat HUD stays clean even when brain intent + routing state diverge.
    //
    // Three distinct cases (reviewer BLOCKER fix 2026-05-17):
    //   (A) in_reply_to provided AND matches a pending voice turn → route to
    //       voice (happy path).
    //   (B) in_reply_to provided BUT no match (stale id — turn timed out,
    //       client closed, or MAX_QUEUE-shifted before brain replied) →
    //       brain intended voice. FAIL CLOSED: do NOT fan out to b.chat().
    //       Return a 409 so the brain learns it lost the turn; the kid will
    //       just experience silence — better than the wrong-channel broadcast.
    //   (C) in_reply_to absent → genuinely ambiguous. Try auto-correlate; if
    //       no voice turn pending, fall through to b.chat() (this is a real
    //       in-game chat reply, not a misrouted voice reply).
    const has_irt = in_reply_to != null;  // loose: catches both null + undefined
    let voiceTurn = null;
    if (has_irt && _pendingVoiceTurns.has(in_reply_to)) {
      voiceTurn = _pendingVoiceTurns.get(in_reply_to);  // case A
    } else if (!has_irt && !String(message).trimStart().startsWith('/')) {
      // case C: auto-correlate by GLOBAL FIFO across the whole commandQueue.
      // Slash-prefixed messages are in-game/Mineflayer commands (e.g.
      // apply_household_rules_live.sh gamerules) — never steal them into
      // a pending voice turn even if one is open (Bugbot PR #56).
      // Cycle-C bug 2026-05-17: voice-only-oldest was misrouting chat
      // replies to voice when both a voice turn AND a chat turn were
      // pending and the brain replied to the chat turn without in_reply_to
      // (the chat reply got broadcast on the kid's speaker; the chat HUD
      // got silence). The brain drains `mc commands` in FIFO order, so the
      // next reply targets the OLDEST pending dispatched entry regardless
      // of source. We only resolve to voice when that oldest entry IS a
      // voice turn AND it's within the autocorrelate window.
      const now = Date.now();
      const oldest = commandQueue
        .filter(c => c.status === 'pending')
        .sort((a, b) => a.time - b.time)[0];
      if (oldest && oldest.source === 'voice'
          && _pendingVoiceTurns.has(oldest.id)
          && _pendingVoiceTurns.get(oldest.id).dispatched_ts
          && (now - _pendingVoiceTurns.get(oldest.id).dispatched_ts) <= VOICE_AUTOCORRELATE_MS) {
        voiceTurn = _pendingVoiceTurns.get(oldest.id);
      }
      // Otherwise (oldest is a chat turn OR no pending OR voice not yet
      // dispatched OR voice age past window): fall through to bot.chat().
    }
    if (voiceTurn) {
      // Resolve the held HTTP request from /chat/voice
      clearTimeout(voiceTurn.timer);
      _pendingVoiceTurns.delete(voiceTurn.id);
      const qEntry = commandQueue.find(c => c.id === voiceTurn.id);
      if (qEntry) qEntry.status = 'completed';
      rememberSocialEvent({ actor: getMyName(), target: voiceTurn.kid, kind: 'sent', channel: 'voice', message });
      try { voiceTurn.resolve({ ok: true, reply: message, in_reply_to: voiceTurn.id }); } catch (e) { log(`[voice] resolver throw: ${e.message}`); }
      log(`[voice→] (id=${voiceTurn.id}, kid=${voiceTurn.kid}) ${message.slice(0, 80)}`);
      return { result: `Spoke to ${voiceTurn.kid} via voice (id=${voiceTurn.id})` };
    }
    if (has_irt) {
      // case B: brain explicitly intended a voice turn but routing state is
      // gone. Fail closed — do NOT broadcast to in-game chat. The brain can
      // see the rejection and decide whether to retry (it shouldn't; the
      // kid's window for that reply has passed).
      log(`[voice✗] (id=${in_reply_to}) chat reply with stale in_reply_to — dropped fail-closed (no in-game chat fan-out)`);
      const err = new Error(`Voice turn ${in_reply_to} no longer pending (timed out, client closed, or evicted); voice reply dropped fail-closed.`);
      err.statusCode = 409;
      throw err;
    }
    // case C continued: genuine in-game chat reply, no voice turn pending.
    const b = ensureBot();
    b.chat(message);
    rememberSocialEvent({ actor: getMyName(), kind: 'sent', channel: 'public', message });
    return { result: `Sent: ${message}` };
  },

  async wait({ seconds = 5 }) {
    ensureBot();
    await sleep(Math.min(seconds, 60) * 1000);
    return { result: `Waited ${seconds}s` };
  },

  async use() {
    const b = ensureBot();
    await b.activateItem();
    return { result: `Used ${b.heldItem?.name || 'hand'}` };
  },

  async sleep_bed() {
    const b = ensureBot();
    const bed = b.findBlock({
      matching: block => block.name?.includes('bed'),
      maxDistance: 4,
    });
    if (!bed) throw new Error('No bed within 4 blocks.');
    await b.sleep(bed);
    return { result: 'Sleeping...' };
  },

  // ── Sustained Combat ──────────────────────────────
  async fight({ target, retreat_health = 6, duration = 30 }) {
    const b = ensureBot();

    // Auto-equip best weapon
    const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
                     'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe'];
    for (const w of weapons) {
      const item = b.inventory.items().find(i => i.name === w);
      if (item) { await b.equip(item, 'hand'); break; }
    }

    // Find target entity
    const hostiles = ['zombie','skeleton','spider','creeper','enderman','witch',
                      'drowned','husk','stray','phantom','pillager','vindicator','blaze',
                      'wither_skeleton','ghast','piglin_brute','hoglin'];
    // Fair play: only fight visible entities
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    let entity;
    if (target) {
      entity = visible.find(e => e.name?.includes(target) || e.displayName?.includes(target));
    } else {
      entity = visible.find(e => hostiles.some(h => e.name?.includes(h)) && e.position?.distanceTo(b.entity.position) < 16);
    }
    if (!entity) return { result: `No ${target || 'hostile'} found nearby` };

    const startHealth = b.health;
    let hits = 0, targetName = entity.name || entity.displayName || 'entity';
    const endTime = Date.now() + duration * 1000;

    while (Date.now() < endTime) {
      if (b.health <= retreat_health) {
        const fleePos = b.entity.position.offset(
          -(entity.position.x - b.entity.position.x) * 2, 0,
          -(entity.position.z - b.entity.position.z) * 2
        );
        try { await b.pathfinder.goto(new goals.GoalNear(fleePos.x, fleePos.y, fleePos.z, 2)); } catch {}
        const food = b.inventory.items().find(i => mcData.foodsByName?.[i.name]);
        if (food) { await b.equip(food, 'hand'); try { await b.consume(); } catch {} }
        return { result: `Retreated from ${targetName} at ${b.health} HP. ${hits} hits dealt.` };
      }

      if (!entity.isValid) {
        return { result: `Killed ${targetName}! ${hits} hits. Lost ${Math.round(startHealth - b.health)} HP.` };
      }

      const dist = entity.position.distanceTo(b.entity.position);
      if (dist > 3.5) {
        b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
        await sleep(300);
        continue;
      }

      b.pathfinder.setGoal(null);
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      await b.attack(entity);
      hits++;
      await sleep(600);
    }

    return { result: `Fight timeout. ${hits} hits on ${targetName}. Health: ${b.health}` };
  },

  async flee({ distance = 16, from }) {
    const b = ensureBot();
    const hostiles = ['zombie','skeleton','spider','creeper','enderman','witch','drowned','husk','stray','phantom','blaze','wither_skeleton','player'];
    let threat;
    if (from) {
      // Flee from specific entity
      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      threat = visible.find(e => (e.name || '').toLowerCase().includes(from.toLowerCase()) || (e.username || '').toLowerCase().includes(from.toLowerCase()));
    } else {
      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      threat = visible.find(e => hostiles.some(h => (e.name || '').includes(h)));
    }
    if (!threat) return { result: 'No threats nearby' };

    const dx = b.entity.position.x - threat.position.x;
    const dz = b.entity.position.z - threat.position.z;
    const len = Math.sqrt(dx*dx + dz*dz) || 1;
    const fleeX = b.entity.position.x + (dx/len) * distance;
    const fleeZ = b.entity.position.z + (dz/len) * distance;

    try {
      await b.pathfinder.goto(new goals.GoalNear(fleeX, b.entity.position.y, fleeZ, 3));
      return { result: `Fled ${distance} blocks from ${threat.name}` };
    } catch {
      return { result: `Tried to flee, moved partially. Health: ${b.health}` };
    }
  },

  async chat_to({ player, message }) {
    const b = ensureBot();
    // Alias for whisper — use native /msg for true server-side private message
    b.chat(`/msg ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  async whisper({ player, message }) {
    const b = ensureBot();
    b.chat(`/msg ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  // ── Death Recovery ────────────────────────────────
  async deathpoint() {
    if (!lastDeath) return { result: 'No deaths recorded.' };
    const pos = lastDeath.position;
    const age = Math.round((Date.now() - lastDeath.time) / 1000);
    const b = ensureBot();
    await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
    return { result: `At death #${lastDeath.deathNumber} (${age}s ago). Lost: ${lastDeath.inventory.map(i=>`${i.name}x${i.count}`).join(', ')}` };
  },

  // ── Container Interaction ─────────────────────────
  async list_container({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) return { result: 'No block at those coordinates' };
    if (b.entity.position.distanceTo(block.position) > 4.5)
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    const chest = await b.openContainer(block);
    const items = chest.containerItems();
    const summary = items.length > 0 ? items.map(i => `${i.name}x${i.count}`).join(', ') : '(empty)';
    chest.close();
    return { result: `Container: ${summary}` };
  },

  async deposit({ x, y, z, item, count }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) return { result: 'No block there' };
    if (b.entity.position.distanceTo(block.position) > 4.5)
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    const chest = await b.openContainer(block);
    const invItem = b.inventory.items().find(i => i.name.includes(item));
    if (!invItem) { chest.close(); return { result: `No ${item} in inventory` }; }
    const qty = count && count > 0 ? Math.min(count, invItem.count) : invItem.count;
    await chest.deposit(invItem.type, null, qty);
    chest.close();
    return { result: `Deposited ${qty} ${invItem.name}` };
  },

  async withdraw({ x, y, z, item, count }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) return { result: 'No block there' };
    if (b.entity.position.distanceTo(block.position) > 4.5)
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    const chest = await b.openContainer(block);
    const chestItem = chest.containerItems().find(i => i.name.includes(item));
    if (!chestItem) { chest.close(); return { result: `No ${item} in container` }; }
    const qty = count && count > 0 ? Math.min(count, chestItem.count) : chestItem.count;
    await chest.withdraw(chestItem.type, null, qty);
    chest.close();
    return { result: `Withdrew ${qty} ${chestItem.name}` };
  },

  // ── Coordinate Memory ────────────────────────────
  async mark({ name, note }) {
    const b = ensureBot();
    const pos = posObj();
    const locs = loadLocations();
    locs[name] = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
      note: note || '', saved: new Date().toISOString() };
    saveLocations(locs);
    return { result: `Saved '${name}' at ${locs[name].x}, ${locs[name].y}, ${locs[name].z}` };
  },
  async marks() {
    const b = ensureBot();
    const locs = loadLocations();
    const entries = Object.entries(locs);
    if (!entries.length) return { result: 'No saved locations' };
    const pos = b.entity.position;
    const lines = entries.map(([name, l]) => {
      const dist = Math.round(Math.sqrt((pos.x-l.x)**2+(pos.y-l.y)**2+(pos.z-l.z)**2));
      return `${name}: ${l.x},${l.y},${l.z} (${dist}m)${l.note ? ' — '+l.note : ''}`;
    });
    return { result: lines.join('\n') };
  },
  async go_mark({ name }) {
    const locs = loadLocations();
    if (!locs[name]) return { result: `No location '${name}'` };
    const l = locs[name];
    const b = ensureBot();
    await b.pathfinder.goto(new goals.GoalNear(l.x, l.y, l.z, 2));
    return { result: `Arrived at '${name}' (${l.x},${l.y},${l.z})` };
  },
  async unmark({ name }) {
    const locs = loadLocations();
    if (!locs[name]) return { result: `No location '${name}'` };
    delete locs[name];
    saveLocations(locs);
    return { result: `Deleted '${name}'` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Advanced Combat — sneaking, shields, bows, crits, combos
  // ═══════════════════════════════════════════════════════════════

  async sneak({ enable = true }) {
    const b = ensureBot();
    b.setControlState('sneak', !!enable);
    isSneaking = !!enable;
    return { result: enable ? 'Sneaking — nameplate hidden, reduced detection range' : 'Stopped sneaking' };
  },

  async shield_block({ duration = 3 }) {
    const b = ensureBot();
    // Check for shield in offhand
    const shield = b.inventory.items().find(i => i.name === 'shield');
    if (!shield) throw new Error('No shield in inventory. Craft one first (1 iron + 6 planks).');
    
    // Equip to offhand if not already there
    if (!b.inventory.slots[45] || b.inventory.slots[45].name !== 'shield') {
      await b.equip(shield, 'off-hand');
    }
    
    // Activate shield (right-click = use = block)
    b.activateItem(true); // true = offhand
    const blockTime = Math.min(duration, 10) * 1000;
    await sleep(blockTime);
    b.deactivateItem();
    return { result: `Blocked with shield for ${duration}s` };
  },

  async shoot({ target, predict = true }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Find and equip bow
    const bow = b.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
    if (!bow) throw new Error('No bow/crossbow in inventory.');
    const arrows = b.inventory.items().find(i => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow');
    if (!arrows) throw new Error('No arrows in inventory.');
    await b.equip(bow, 'hand');
    
    // Find target entity
    let entity;
    if (target) {
      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      entity = visible.find(e =>
        (e.name || '').toLowerCase().includes(target.toLowerCase()) ||
        (e.username || '').toLowerCase().includes(target.toLowerCase())
      );
    } else {
      const hostiles = ['zombie','skeleton','spider','creeper','enderman','witch','drowned','blaze','ghast','wither_skeleton','player'];
      const rawEnts = Object.values(b.entities).filter(e => 
        e !== b.entity && hostiles.some(h => (e.name || '').includes(h)));
      const visible = filterEntitiesFairPlay(rawEnts);
      entity = visible.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
    }
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    
    // Calculate aim point (predict movement for leading shots)
    let aimPoint = entity.position.offset(0, entity.height * 0.6, 0);
    if (predict && entity.velocity) {
      const dist = entity.position.distanceTo(b.entity.position);
      const flightTime = dist / 30; // arrows travel ~30 blocks/sec
      aimPoint = aimPoint.offset(
        entity.velocity.x * flightTime * 20,
        entity.velocity.y * flightTime * 20 + 0.05 * dist, // gravity compensation
        entity.velocity.z * flightTime * 20
      );
    }
    
    await b.lookAt(aimPoint);
    // Charge bow (full charge = 1 second for bow)
    b.activateItem();
    await sleep(bow.name === 'crossbow' ? 1250 : 1000);
    b.deactivateItem();
    
    return { result: `Shot ${bow.name} at ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m)` };
  },

  async sprint_attack({ target }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Auto-equip best weapon
    const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
                     'netherite_axe','diamond_axe','iron_axe','stone_axe'];
    for (const w of weapons) {
      const item = b.inventory.items().find(i => i.name === w);
      if (item) { await b.equip(item, 'hand'); break; }
    }
    
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => ['zombie','skeleton','spider','creeper','player'].some(h => (e.name || '').includes(h)))
               .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    
    // Sprint toward and attack — extra knockback on first sprint hit
    b.setControlState('sprint', true);
    if (entity.position.distanceTo(b.entity.position) > 3.5) {
      await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
    }
    await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
    await b.attack(entity);
    b.setControlState('sprint', false);
    
    return { result: `Sprint-attacked ${entity.name || target}! (extra knockback)` };
  },

  async critical_hit({ target }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Equip best weapon
    const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','netherite_axe','diamond_axe','iron_axe'];
    for (const w of weapons) {
      const item = b.inventory.items().find(i => i.name === w);
      if (item) { await b.equip(item, 'hand'); break; }
    }
    
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => e.position.distanceTo(b.entity.position) < 6).sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible within range.`);
    
    // Approach
    if (entity.position.distanceTo(b.entity.position) > 3.5) {
      await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
    }
    
    // Jump + attack on the way down = critical hit (150% damage)
    b.setControlState('jump', true);
    await sleep(200); // apex of jump
    b.setControlState('jump', false);
    await sleep(150); // falling down
    await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
    await b.attack(entity);
    
    return { result: `Critical hit on ${entity.name || target}! (150% damage, star particles)` };
  },

  async strafe({ target, direction = 'random', duration = 5 }) {
    const b = ensureBot();
    await reactionDelay();
    
    // Equip best weapon
    const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword'];
    for (const w of weapons) {
      const item = b.inventory.items().find(i => i.name === w);
      if (item) { await b.equip(item, 'hand'); break; }
    }
    
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => e.position.distanceTo(b.entity.position) < 8)[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    
    let hits = 0;
    const endTime = Date.now() + Math.min(duration, 15) * 1000;
    const dir = direction === 'random' ? (Math.random() > 0.5 ? 'left' : 'right') : direction;
    
    while (Date.now() < endTime && entity.isValid) {
      if (b.health <= 6) return { result: `Strafing stopped — low HP (${b.health}). ${hits} hits.` };
      
      // Strafe: move perpendicular to target
      const dx = entity.position.x - b.entity.position.x;
      const dz = entity.position.z - b.entity.position.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      
      // Perpendicular direction
      const perpX = dir === 'left' ? -dz/dist : dz/dist;
      const perpZ = dir === 'left' ? dx/dist : -dx/dist;
      
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      
      // Move toward strafe position
      b.setControlState(dir === 'left' ? 'left' : 'right', true);
      b.setControlState(dir === 'left' ? 'right' : 'left', false);
      
      // Attack when in range
      if (dist < 4) {
        await b.attack(entity);
        hits++;
      }
      
      await sleep(500);
    }
    
    // Stop strafing
    b.setControlState('left', false);
    b.setControlState('right', false);
    
    return { result: `Strafed ${dir} around ${entity.name || target}. ${hits} hits in ${duration}s.` };
  },

  async combo({ target, style = 'aggressive' }) {
    const b = ensureBot();
    
    // Find target
    const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
    const visible = filterEntitiesFairPlay(rawEnts);
    const entity = target
      ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
      : visible.filter(e => e.position.distanceTo(b.entity.position) < 16)[0];
    if (!entity) throw new Error(`No ${target || 'target'} visible.`);
    const tName = entity.name || entity.username || target || 'target';
    
    const results = [];
    try {
      switch (style) {
        case 'aggressive':
          results.push((await ACTIONS.sprint_attack({ target: tName })).result);
          await sleep(600);
          results.push((await ACTIONS.critical_hit({ target: tName })).result);
          await sleep(600);
          results.push((await ACTIONS.critical_hit({ target: tName })).result);
          if (b.inventory.items().find(i => i.name === 'shield')) {
            await sleep(200);
            results.push((await ACTIONS.shield_block({ duration: 1 })).result);
          }
          break;
        case 'defensive':
          if (b.inventory.items().find(i => i.name === 'shield')) {
            results.push((await ACTIONS.shield_block({ duration: 2 })).result);
          }
          results.push((await ACTIONS.critical_hit({ target: tName })).result);
          await sleep(300);
          results.push((await ACTIONS.flee({ distance: 6 })).result);
          break;
        case 'ranged':
          results.push((await ACTIONS.shoot({ target: tName, predict: true })).result);
          await sleep(1200);
          results.push((await ACTIONS.shoot({ target: tName, predict: true })).result);
          if (entity.isValid && entity.position.distanceTo(b.entity.position) < 8) {
            results.push((await ACTIONS.sprint_attack({ target: tName })).result);
          }
          break;
        case 'berserker':
          results.push((await ACTIONS.sprint_attack({ target: tName })).result);
          for (let i = 0; i < 3 && entity.isValid && b.health > 4; i++) {
            await sleep(500);
            results.push((await ACTIONS.critical_hit({ target: tName })).result);
          }
          break;
        default:
          throw new Error(`Unknown combo style: ${style}. Use: aggressive, defensive, ranged, berserker`);
      }
    } catch (err) {
      results.push(`Combo interrupted: ${err.message}`);
    }
    
    return { result: `[${style}] ${results.join(' → ')}` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Fire-and-Forget Smelting
  // ═══════════════════════════════════════════════════════════════

  async smelt_start({ input, fuel, count = 1, x, y, z }) {
    const b = ensureBot();
    const isFurnaceBlock = (block) =>
      block.name === 'furnace' || block.name === 'lit_furnace' || block.name === 'blast_furnace' || block.name === 'smoker';
    let furnaceBlock;
    if (x != null && y != null && z != null) {
      furnaceBlock = b.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
      if (!furnaceBlock || !isFurnaceBlock(furnaceBlock)) {
        throw new Error(`No furnace at ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}.`);
      }
    } else {
      furnaceBlock = b.findBlock({ matching: isFurnaceBlock, maxDistance: 4 });
    }
    if (!furnaceBlock) throw new Error('No furnace within 4 blocks. Place one first.');

    const furnace = await b.openFurnace(furnaceBlock);
    const inputItem = b.inventory.items().find(i => i.name === input);
    if (!inputItem) { furnace.close(); throw new Error(`No ${input} in inventory.`); }

    const qty = Math.min(count, inputItem.count, 64);
    await furnace.putInput(inputItem.type, null, qty);

    if (!furnace.fuelItem()) {
      const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick', 'lava_bucket', 'blaze_rod'];
      const fuelItem = fuel
        ? b.inventory.items().find(i => i.name === fuel)
        : b.inventory.items().find(i => fuelNames.includes(i.name));
      if (!fuelItem) { furnace.close(); throw new Error('No fuel available.'); }
      // Coal smelts 8 items, planks smelt 1.5, coal_block smelts 80
      const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : fuelItem.name === 'blaze_rod' ? 12 : fuelItem.name === 'lava_bucket' ? 100 : 1.5;
      const fuelNeeded = Math.ceil(qty / fuelPer);
      await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
    }

    furnace.close();

    // Track this furnace for later retrieval
    const fp = furnaceBlock.position;
    const eta = Date.now() + qty * 10000; // 10s per item
    activeFurnaces.push({
      x: fp.x, y: fp.y, z: fp.z,
      input, count: qty, startTime: Date.now(), estimatedDone: eta,
    });

    const minutes = Math.ceil(qty * 10 / 60);
    return { result: `Loaded ${qty} ${input} into furnace at ${fp.x},${fp.y},${fp.z}. ETA: ~${minutes} min. Go do something else!` };
  },

  async furnace_check({ x, y, z }) {
    const b = ensureBot();
    const furnaceBlock = b.blockAt(new Vec3(x, y, z));
    if (!furnaceBlock || (!furnaceBlock.name.includes('furnace') && furnaceBlock.name !== 'smoker' && furnaceBlock.name !== 'blast_furnace'))
      throw new Error(`No furnace at ${x},${y},${z}`);

    if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    }
    const furnace = await b.openFurnace(furnaceBlock);
    const inputItem = furnace.inputItem();
    const fuelItem = furnace.fuelItem();
    const outputItem = furnace.outputItem();
    furnace.close();

    return {
      result: `Furnace at ${x},${y},${z}: ` +
        `Input: ${inputItem ? `${inputItem.name} x${inputItem.count}` : 'empty'} | ` +
        `Fuel: ${fuelItem ? `${fuelItem.name} x${fuelItem.count}` : 'empty'} | ` +
        `Output: ${outputItem ? `${outputItem.name} x${outputItem.count}` : 'empty'} | ` +
        `Status: ${outputItem ? 'output ready!' : inputItem ? 'smelting...' : 'idle'}`,
      ready: !!outputItem,
      output: outputItem ? { name: outputItem.name, count: outputItem.count } : null,
    };
  },

  async furnace_take({ x, y, z }) {
    const b = ensureBot();
    const furnaceBlock = b.blockAt(new Vec3(x, y, z));
    if (!furnaceBlock) throw new Error(`No block at ${x},${y},${z}`);

    if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    }
    const furnace = await b.openFurnace(furnaceBlock);
    const output = furnace.outputItem();
    if (!output) { furnace.close(); return { result: 'Furnace has no output ready yet.' }; }
    await furnace.takeOutput();
    
    // Also grab remaining input if smelting is done
    const remaining = furnace.inputItem();
    furnace.close();

    // Remove from active furnaces tracking
    activeFurnaces = activeFurnaces.filter(f => !(f.x === x && f.y === y && f.z === z));

    return { result: `Collected ${output.name} x${output.count} from furnace.${remaining ? ` (${remaining.count} ${remaining.name} still being smelted)` : ''}` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Team System — communication, coordination
  // ═══════════════════════════════════════════════════════════════

  async team_chat({ message }) {
    const b = ensureBot();
    if (!teamConfig.team) throw new Error('Not assigned to a team. Use /action/set_team first.');
    
    // Send to all teammates via /msg
    for (const mate of teamConfig.teammates) {
      b.chat(`/msg ${mate} [${teamConfig.team.toUpperCase()}] ${message}`);
      await sleep(100); // avoid spam throttle
    }
    teamConfig.teamChat.push({ time: Date.now(), from: config.mc.username, message });
    if (teamConfig.teamChat.length > 50) teamConfig.teamChat.shift();
    return { result: `[${teamConfig.team}] Sent to ${teamConfig.teammates.length} teammates: ${message}` };
  },

  async team_status() {
    const b = ensureBot();
    if (!teamConfig.team) return { result: 'Not on a team.' };
    
    // Find teammates that are visible
    const teammates = [];
    for (const name of teamConfig.teammates) {
      const entity = Object.values(b.entities).find(e => e.username === name);
      if (entity) {
        teammates.push({
          name,
          distance: fmt(entity.position.distanceTo(b.entity.position)),
          position: posObj(entity.position),
          health: entity.health ?? '?',
        });
      } else {
        teammates.push({ name, distance: '?', position: 'not visible', health: '?' });
      }
    }
    
    return {
      result: `Team ${teamConfig.team.toUpperCase()} | Role: ${teamConfig.role} | Rally: ${teamConfig.rallyPoint ? `${teamConfig.rallyPoint.x},${teamConfig.rallyPoint.y},${teamConfig.rallyPoint.z}` : 'none'}`,
      teammates,
    };
  },

  async rally({ x, y, z, message }) {
    const b = ensureBot();
    if (!teamConfig.team) throw new Error('Not on a team.');
    teamConfig.rallyPoint = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    
    // Announce to team
    const msg = message || `Rally at ${teamConfig.rallyPoint.x},${teamConfig.rallyPoint.y},${teamConfig.rallyPoint.z}!`;
    for (const mate of teamConfig.teammates) {
      b.chat(`/msg ${mate} [RALLY] ${msg}`);
      await sleep(100);
    }
    return { result: `Rally point set and announced to team: ${msg}` };
  },

  async report({ message }) {
    const b = ensureBot();
    if (!teamConfig.team) throw new Error('Not on a team.');
    const pos = posObj();
    const fullMsg = `[INTEL] ${message} (at ${pos.x},${pos.y},${pos.z})`;
    for (const mate of teamConfig.teammates) {
      b.chat(`/msg ${mate} ${fullMsg}`);
      await sleep(100);
    }
    return { result: `Report sent to team: ${fullMsg}` };
  },

  async set_team({ team, role, teammates }) {
    teamConfig.team = team;
    teamConfig.role = role || 'warrior';
    teamConfig.teammates = teammates || [];
    return { result: `Assigned to team ${team} as ${role}. Teammates: ${teammates?.join(', ') || 'none'}` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Fair Play Toggle
  // ═══════════════════════════════════════════════════════════════

  async set_fair_play({ enabled }) {
    fairPlayMode = !!enabled;
    return { result: `Fair play mode: ${fairPlayMode ? 'ON (LOS, sound, reaction delay)' : 'OFF (god-mode perception)'}` };
  },

  // ═══════════════════════════════════════════════════════════════
  // Survival skills (issue #81 — closes #59 + #61)
  // fish_for_food, farm_food, cook_food, return_home, feed_player,
  // build_shelter_for_night
  // ═══════════════════════════════════════════════════════════════

  async fish_for_food({ duration = 45 }) {
    const b = ensureBot();
    // 1. Find fishing rod in inventory
    const rod = b.inventory.items().find((i) => i.name === 'fishing_rod');
    if (!rod) return { result: "I don't have a fishing rod. Need one to fish!" };

    // 2. Find water within 16 blocks
    const waterBlock = b.findBlock({ matching: (blk) => blk.name === 'water', maxDistance: 16 });
    if (!waterBlock) return { result: "No water nearby to fish — let's find a lake or river first." };

    // 3. Pathfind close to water
    await b.pathfinder.goto(new goals.GoalNear(
      waterBlock.position.x, waterBlock.position.y, waterBlock.position.z, 2
    )).catch(() => {});

    // 4. Equip rod and cast
    await b.equip(rod, 'hand');
    await b.lookAt(waterBlock.position.offset(0.5, 0, 0.5));
    await new Promise((r) => setTimeout(r, 400));

    const fishNames = ['cod', 'salmon', 'pufferfish', 'tropical_fish'];
    const countFish = () => b.inventory.items()
      .filter((i) => fishNames.includes(i.name))
      .reduce((sum, i) => sum + i.count, 0);
    const fishBefore = countFish();
    const stopAt = Date.now() + duration * 1000;

    // 5. Fish loop — stop when edible fish appear in inventory
    while (Date.now() < stopAt && !b.interrupt_code) {
      await b.fish().catch(() => {});
      if (countFish() > fishBefore) break;
    }

    const fishCaught = countFish() - fishBefore;
    const result = fishCaught > 0
      ? `Caught ${fishCaught} fish! Fresh food ready.`
      : `Fished for ${duration}s but no bites — might need a better spot or enchanted rod.`;
    autoRememberFact(`Fished near ${waterBlock.position.floored()} — caught ${fishCaught}.`);
    return { result };
  },

  async farm_food({ radius = 4 }) {
    const b = ensureBot();
    let harvested = 0;
    let tilled = 0;

    const cropMaxAge = (name) => (name === 'beetroots' ? 3 : 7);

    // 1. Harvest mature crops within radius
    const cropBlocks = b.findBlocks({
      matching: (blk) => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(blk.name),
      maxDistance: radius,
      count: 20,
    });
    for (const pos of cropBlocks) {
      if (b.interrupt_code) break;
      const blk = b.blockAt(pos);
      if (!blk) continue;
      const age = blk.getProperties()?.age;
      if (age !== undefined && parseInt(age) < cropMaxAge(blk.name)) continue;
      try {
        await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)).catch(() => {});
        await b.dig(blk);
        harvested++;
      } catch { /* can't reach */ }
    }

    // 2. Till nearby dirt/grass and plant seeds if we have them
    const hoe = b.inventory.items().find((i) => i.name.includes('hoe'));
    const seeds = b.inventory.items().find((i) => ['wheat_seeds', 'carrot', 'potato'].includes(i.name));
    if (hoe && seeds) {
      const dirtBlocks = b.findBlocks({
        matching: (blk) => ['dirt', 'grass_block', 'rooted_dirt'].includes(blk.name),
        maxDistance: 3,
        count: 9,
      });
      for (const pos of dirtBlocks) {
        if (b.interrupt_code || tilled >= 9) break;
        const blk = b.blockAt(pos);
        if (!blk) continue;
        const above = b.blockAt(pos.offset(0, 1, 0));
        if (!above || above.name !== 'air') continue;
        try {
          await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)).catch(() => {});
          await b.equip(hoe, 'hand');
          await b.activateBlock(blk);
          tilled++;
          await new Promise((r) => setTimeout(r, 200));
          const currentSeeds = b.inventory.items().find((i) => ['wheat_seeds', 'carrot', 'potato'].includes(i.name));
          if (currentSeeds) {
            const farmland = b.blockAt(pos);
            if (farmland && farmland.name === 'farmland') {
              await b.equip(currentSeeds, 'hand');
              await b.placeBlock(farmland, new Vec3(0, 1, 0)).catch(() => {});
            }
          }
        } catch { /* can't reach or can't till */ }
      }
    }

    const result = `Farmed: harvested ${harvested} crop${harvested === 1 ? '' : 's'}, tilled+planted ${tilled} plot${tilled === 1 ? '' : 's'}.`;
    if (harvested + tilled > 0) autoRememberFact(`Farmed at ${b.entity.position.floored()} — ${harvested} harvested, ${tilled} planted.`);
    return { result };
  },

  async cook_food({ input, fuel, count = 4 }) {
    const b = ensureBot();
    const isFurnace = (blk) => ['furnace', 'lit_furnace', 'smoker'].includes(blk.name);

    let furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 16 });
    if (!furnaceBlock) {
      return { result: "No furnace nearby. Place one first or I can craft one if you have cobblestone." };
    }
    await b.pathfinder.goto(new goals.GoalNear(
      furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2
    )).catch(() => {});
    furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
    if (!furnaceBlock) {
      return { result: "Found a furnace but couldn't get within range. Move closer and try again." };
    }

    const rawFood = input || (() => {
      const raw = ['beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'rabbit', 'potato'];
      const item = b.inventory.items().find((i) => raw.includes(i.name));
      return item?.name;
    })();
    if (!rawFood) return { result: "No raw food to cook — I'd need beef, chicken, fish, or similar." };

    const fp = furnaceBlock.position;
    try {
      await ACTIONS.smelt_start({
        input: rawFood, fuel, count,
        x: fp.x, y: fp.y, z: fp.z,
      });
    } catch (err) {
      return { result: err.message || 'Could not start smelting.' };
    }
    // Wait for smelting
    await new Promise((r) => setTimeout(r, Math.min(count * 10000, 40000)));
    const takeResult = await ACTIONS.furnace_take({ x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z });
    const cooked = takeResult?.result || 'done';
    autoRememberFact(`Cooked ${rawFood} x${count} in furnace at ${furnaceBlock.position.floored()}.`);
    return { result: `Cooked ${rawFood}: ${cooked}` };
  },

  async return_home({}) {
    ensureBot();
    const HOME_NAMES = ['home', 'base', 'spawn', 'our_base'];
    const locs = loadLocations();
    const found = HOME_NAMES.find((n) => locs[n]);
    if (found) {
      return await ACTIONS.go_mark({ name: found });
    }
    // Fallback: deathpoint (deathpoint() navigates when a death is recorded)
    const dp = await ACTIONS.deathpoint({});
    const noDeathRecorded = !dp?.result || /no deaths recorded/i.test(dp.result);
    if (!noDeathRecorded) {
      return { result: `No home mark set — heading to my last deathpoint. ${dp.result}` };
    }
    return { result: "No home mark and no deathpoint yet. Use 'mc mark home' after you reach your base to set it." };
  },

  async feed_player({ player }) {
    const b = ensureBot();
    if (!player) return { result: 'No player specified — tell me who to feed.' };
    const target = player;
    // 1. Check for cooked food in inventory
    const COOKED = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
      'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'apple'];
    const cookedItem = b.inventory.items().find((i) => COOKED.includes(i.name));
    if (cookedItem) {
      return await ACTIONS.give_to_player({ player: target, item: cookedItem.name, count: 2 });
    }
    // 2. Try to cook something first
    let cookResult;
    try {
      cookResult = await ACTIONS.cook_food({ count: 2 });
    } catch (err) {
      cookResult = { result: err.message || '' };
    }
    const cookFailed = !cookResult?.result
      || /^(no |could not|found a furnace)/i.test(cookResult.result);
    if (!cookFailed) {
      const freshCooked = b.inventory.items().find((i) => COOKED.includes(i.name));
      if (freshCooked) {
        return await ACTIONS.give_to_player({ player: target, item: freshCooked.name, count: 2 });
      }
    }
    // 3. Fallback: give raw food
    const RAW = ['beef', 'porkchop', 'chicken', 'cod', 'salmon', 'potato', 'carrot', 'apple'];
    const rawItem = b.inventory.items().find((i) => RAW.includes(i.name));
    if (rawItem) {
      return await ACTIONS.give_to_player({ player: target, item: rawItem.name, count: 2 });
    }
    return { result: `Nothing to give — my food inventory is empty. We should fish or farm first!` };
  },

  async build_shelter_for_night({ x, y, z }) {
    const b = ensureBot();
    // Use the bot's current position if no coords given
    const bx = (x !== undefined ? Math.round(x) : Math.round(b.entity.position.x) + 2);
    const by = (y !== undefined ? Math.round(y) : Math.round(b.entity.position.y));
    const bz = (z !== undefined ? Math.round(z) : Math.round(b.entity.position.z));
    // Build dirt_shelter schematic
    const shelterResult = await ACTIONS.build_schematic({ name: 'dirt_shelter', x: bx, y: by, z: bz });
    const placed = shelterResult?.result || '';
    const placedFrac = placed.match(/(\d+)\/(\d+)/);
    const placedCount = placedFrac ? parseInt(placedFrac[1], 10) : 0;
    const buildFailed = !placedFrac
      ? /interrupted|couldn't|could not|is empty|needs /i.test(placed)
      : placedCount === 0;
    if (buildFailed) {
      return { result: `Couldn't build shelter at ${bx},${by},${bz}: ${placed || 'build failed.'}` };
    }
    // Light the inside
    await ACTIONS.light_area({ cx: bx + 1, cy: by + 1, cz: bz + 1, radius: 1 }).catch(() => {});
    autoRememberFact(`Built emergency shelter at ${bx},${by},${bz}. 3x3 dirt hut.`);
    return { result: `Shelter built at ${bx},${by},${bz}! ${placed} Get inside — torched it up.` };
  },
};

// ═══════════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════════

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${config.api.port}`);
  const path = url.pathname;

  try {
    // ── GET endpoints (observation) ──────────────
    if (req.method === 'GET') {
      if (path === '/health' || path === '/') {
        return respond(res, 200, {
          ok: true,
          connected: botReady,
          username: config.mc.username,
          server: `${config.mc.host}:${config.mc.port}`,
        });
      }

      if (path === '/status') {
        return respond(res, 200, { ok: true, data: getFullState() });
      }

      if (path === '/inventory') {
        return respond(res, 200, { ok: true, data: getInventory() });
      }

      if (path === '/nearby') {
        const radius = parseInt(url.searchParams.get('radius') || '32');
        return respond(res, 200, { ok: true, data: getNearby(radius) });
      }

      // ASCII top-down map of surroundings
      if (path === '/map') {
        const radius = parseInt(url.searchParams.get('radius') || '16');
        return respond(res, 200, { ok: true, data: generateMap(radius) });
      }

      // Narrative description of what you see (human-readable)
      if (path === '/look') {
        return respond(res, 200, { ok: true, data: generateLookAround() });
      }

      if (path === '/scene') {
        const range = parseInt(url.searchParams.get('range') || '16');
        return respond(res, 200, { ok: true, data: buildSceneSummary({ range: Math.min(range, 24) }) });
      }

      if (path === '/social') {
        return respond(res, 200, { ok: true, data: { summary: summarizeSocialGraph(socialGraph), recent_events: socialEvents.slice(-20) } });
      }

      if (path === '/chat') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const clear = url.searchParams.get('clear') === 'true';
        const msgs = chatLog.slice(-count);
        if (clear) chatLog.length = 0;
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/overhear') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const msgs = overheardLog.slice(-count);
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/deaths') {
        return respond(res, 200, { ok: true, data: {
          total: deathLog.length,
          last_death: lastDeath ? {
            ...lastDeath,
            seconds_ago: Math.round((Date.now() - lastDeath.time) / 1000),
            items_lost: lastDeath.inventory.map(i => `${i.name}x${i.count}`).join(', ')
          } : null
        }});
      }

      if (path === '/commands') {
        // Get pending + stale commands queued by in-game chat OR voice.
        // Stale entries (issue #68 Patch 2) surface so the brain can
        // acknowledge "you walked away — want me to finish?" on the kid's
        // next turn. Brain marks them done via complete_command like any
        // other entry once it has processed them.
        const surfaced = commandQueue.filter(c => c.status === 'pending' || c.status === 'stale');
        // Mark any voice turns as dispatched the first time the brain reads
        // them, so auto-correlate in ACTIONS.chat can match the next reply
        // to the right pending voice turn.
        const now = Date.now();
        for (const entry of surfaced) {
          if (entry.source === 'voice' && _pendingVoiceTurns.has(entry.id)) {
            const turn = _pendingVoiceTurns.get(entry.id);
            if (!turn.dispatched_ts) turn.dispatched_ts = now;
          }
        }
        // ── Pre-flight memory injection (issue #68 Phase C; gemini council
        // 2026-05-20 "Passive Perception"): when a queue entry's command body
        // matches a recall/spatial query pattern, attach memory anchors right
        // there so the brain sees them WHEN it drains the queue. Doesn't
        // require the brain to call `mc perceive` (Sonnet-discipline gap
        // proven 3 cycles in a row). Anchors travel WITH the question.
        try {
          const recallRe = /\b(?:where|what|when|do you remember|recall|hang out|our spot|fairy|spire|treehouse|beacon|lighthouse|build(?: did| we| last| together)|last build)\b/i;
          for (const entry of surfaced) {
            if (!entry || entry.memory_context) continue;
            const body = entry.command || entry.originalMessage || '';
            if (!recallRe.test(body)) continue;
            const pos = bot && bot.entity ? bot.entity.position : { x: 0, y: 64, z: 0 };
            const anchors = readMemoryAnchorsNear(pos, 300, 6);
            if (anchors.length > 0) {
              entry.memory_context = {
                hint: "the kid asked something recall-shaped; here's what's near you from your MEMORY.md — reply with the name + coords + a personal aside in YOUR voice. This IS the world-change.",
                nearby_remembered_builds: anchors,
              };
            }
          }
        } catch (e) { log(`[memory-injection] /commands enrichment failed: ${e.message}`); }
        return respond(res, 200, { ok: true, data: { commands: surfaced } });
      }

      if (path === '/sounds') {
        return respond(res, 200, { ok: true, data: { sounds: soundEvents.slice(-10) } });
      }

      if (path === '/team') {
        return respond(res, 200, { ok: true, data: teamConfig });
      }

      if (path === '/stats') {
        return respond(res, 200, { ok: true, data: combatStats });
      }

      // Post-mortem 2026-05-17: 250 STUCK events tonight = single most
      // kid-visible failure mode. Expose per-action stuck counts +
      // repath-attempt count so operators (and the
      // scripts/voice/build_design_ab_test.sh harness) can spot
      // pathfinder regressions per task verb.
      if (path === '/stuck-stats') {
        return respond(res, 200, { ok: true, data: stuckTelemetry });
      }

      if (path === '/furnaces') {
        return respond(res, 200, { ok: true, data: { furnaces: activeFurnaces.map(f => ({
          ...f,
          eta_seconds: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) : null,
        })) } });
      }

      if (path === '/task') {
        // Check background task status
        if (!currentTask) return respond(res, 200, { ok: true, data: { task: null }, state: briefState() });
        const elapsed = Math.round((Date.now() - currentTask.started) / 1000);
        return respond(res, 200, { ok: true, data: { task: { ...currentTask, elapsed_s: elapsed } }, state: briefState() });
      }
    }

    // ── POST endpoints (actions) ────────────────
    if (req.method === 'POST') {
      const body = await parseBody(req);

      // Voice utterance from the kid's mic — long-poll until the brain
      // replies via /action/chat or VOICE_TURN_TIMEOUT_MS elapses. Wire
      // contract matches scripts/voice/replies_stub.py so live_loop.py can
      // point its --delegate-url here as a drop-in replacement (issue #54).
      // Body: {transcript: string, kid?: string, character?: string}
      // Returns: {ok: true, reply: string, in_reply_to: id} on brain response
      //          {ok: false, error: "brain_timeout", id} on timeout (fail-closed)
      if (path === '/chat/voice') {
        const transcript = String(body.transcript || '').trim();
        if (!transcript) {
          return respond(res, 400, { ok: false, error: 'transcript required' });
        }
        const kid = String(body.kid || body.from || 'voice').trim().slice(0, 32) || 'voice';
        const id = nextEnvelopeId();
        const ts = Date.now();
        commandQueue.push({
          id, time: ts, from: kid, command: transcript,
          channel: 'voice', source: 'voice',
          originalMessage: transcript, status: 'pending',
        });
        trimCommandQueue();
        rememberSocialEvent({ actor: kid, kind: 'heard', channel: 'voice', command: true, message: transcript });
        log(`[voice←] (id=${id}, kid=${kid}) ${transcript.slice(0, 80)}`);

        // Hold the HTTP response open until ACTIONS.chat resolves us OR we
        // hit the fail-closed timeout. The resolver writes the response.
        let responded = false;
        const resolveOnce = (payload) => {
          if (responded) return;
          responded = true;
          const status = payload.ok ? 200 : 504;
          respond(res, status, payload);
        };
        const timer = setTimeout(() => {
          _pendingVoiceTurns.delete(id);
          const qEntry = commandQueue.find(c => c.id === id);
          if (qEntry && qEntry.status === 'pending') qEntry.status = 'timeout';
          log(`[voice✗] (id=${id}) brain_timeout after ${VOICE_TURN_TIMEOUT_MS}ms`);
          resolveOnce({ ok: false, error: 'brain_timeout', id });
        }, VOICE_TURN_TIMEOUT_MS);
        _pendingVoiceTurns.set(id, { id, kid, ts, dispatched_ts: null, timer, resolve: resolveOnce });
        // Client may give up before us (live_loop.py timeout is 90s); detect
        // and clean up so the resolver doesn't fire on a dead socket AND so
        // an orphaned turn cannot get auto-correlated to a later brain reply
        // intended for another kid. Listen on BOTH req and res — Node fires
        // them at slightly different points depending on TCP teardown shape;
        // curl --max-time consistently triggers res.on('close') first.
        const onClientGone = () => {
          if (responded) return;
          responded = true;
          clearTimeout(timer);
          _pendingVoiceTurns.delete(id);
          const qEntry = commandQueue.find(c => c.id === id);
          if (qEntry && qEntry.status === 'pending') qEntry.status = 'client_closed';
          log(`[voice✗] (id=${id}) client closed before reply`);
        };
        req.on('close', onClientGone);
        res.on('close', onClientGone);
        return; // do not call respond() now; resolver writes the response
      }

      // Cancel current task
      if (path === '/task/cancel') {
        const b = ensureBot();
        b.pathfinder.setGoal(null);
        try { b.stopDigging(); } catch {}
        if (currentTask && currentTask.status === 'running') {
          currentTask.status = 'cancelled';
        }
        return respond(res, 200, { ok: true, result: 'Task cancelled.', state: briefState() });
      }

      // Background task system: POST /task/ACTION runs async, returns task_id
      const taskMatch = path.match(/^\/task\/(\w+)$/);
      if (taskMatch) {
        const actionName = taskMatch[1];
        const actionFn = ACTIONS[actionName];
        if (!actionFn) {
          const available = Object.keys(ACTIONS).join(', ');
          return respond(res, 400, { ok: false, error: `Unknown action "${actionName}". Available: ${available}` });
        }
        if (currentTask && currentTask.status === 'running') {
          return respond(res, 409, { ok: false, error: `Task "${currentTask.action}" is already running (${Math.round((Date.now() - currentTask.started) / 1000)}s). POST /task/cancel first.`, state: briefState() });
        }
        const taskId = `${actionName}_${Date.now()}`;
        currentTask = { id: taskId, action: actionName, status: 'running', started: Date.now(), result: null, error: null, params: body };
        // Fire and forget — runs in background
        actionFn(body).then(result => {
          if (currentTask && currentTask.id === taskId && currentTask.status === 'running') {
            currentTask.status = 'done';
            currentTask.result = result;
          }
          actionHistory.push({ action: actionName, status: 'done', time: Date.now() });
          if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
        }).catch(err => {
          if (currentTask && currentTask.id === taskId && currentTask.status === 'running') {
            currentTask.status = 'error';
            currentTask.error = err.message;
          }
          actionHistory.push({ action: actionName, status: 'error', time: Date.now() });
          if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
        });
        return respond(res, 200, { ok: true, task_id: taskId, status: 'started', state: briefState() });
      }

      // Synchronous action: POST /action/ACTION (still supported for quick stuff)
      const actionMatch = path.match(/^\/action\/(\w+)$/);
      if (!actionMatch) {
        // Special: /connect
        if (path === '/connect') {
          await createBot();
          return respond(res, 200, { ok: true, result: 'Connected', state: briefState() });
        }
        return respond(res, 404, { ok: false, error: `Unknown endpoint: ${path}` });
      }

      const actionName = actionMatch[1];
      const actionFn = ACTIONS[actionName];
      if (!actionFn) {
        const available = Object.keys(ACTIONS).join(', ');
        return respond(res, 400, { ok: false, error: `Unknown action "${actionName}". Available: ${available}` });
      }

      const result = await actionFn(body);
      actionHistory.push({ action: actionName, status: 'done', time: Date.now() });
      if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();
      return respond(res, 200, { ok: true, ...result, state: briefState() });
    }

    respond(res, 404, { ok: false, error: `Not found: ${req.method} ${path}` });

  } catch (err) {
    const status = err.message.includes('not connected') ? 503 : 400;
    respond(res, status, { ok: false, error: err.message, state: briefState() });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Stuck Detection Watchdog
// ═══════════════════════════════════════════════════════════════════

let positionHistory = [];
// Per-task STUCK telemetry. Tonight (2026-05-17 post-mortem) we logged 250
// STUCK events (44 Rosie / 206 Steve) in a single live session — most
// kid-visible failure mode. Tally by action so we can spot pathfinder
// regressions in specific verbs (e.g. `collect` failing more than `goto`).
const stuckTelemetry = { byAction: Object.create(null), repaths: 0, total: 0 };
// Mining tasks block-mine in place — `collect`, `bg_collect` shouldn't trip
// the 10s "no movement" check because actually mining IS the work. Bump the
// threshold for these to 20s + grant ONE retry attempt before declaring stuck.
const SLOW_TASK_STUCK_MS = 20000;
const FAST_TASK_STUCK_MS = 10000;
const SLOW_TASK_ACTIONS = new Set(['collect', 'bg_collect', 'pickup', 'fight', 'sprint_attack']);
// In-memory map task_id → { repath_attempted: bool } — survives across the
// 5s interval so we don't repath twice for the same stuck event.
const taskRepathState = new Map();
setInterval(() => {
  if (!bot || !botReady) return;
  const pos = bot.entity.position;
  positionHistory.push({ time: Date.now(), x: pos.x, y: pos.y, z: pos.z });
  positionHistory = positionHistory.filter(p => Date.now() - p.time < 60000);
  // Stuck detection for movement-based tasks — threshold depends on action.
  const movementActions = ['goto', 'goto_near', 'follow', 'collect', 'bg_collect', 'fight', 'flee', 'go_mark', 'deathpoint', 'pickup', 'sprint_attack', 'strafe', 'combo'];
  if (currentTask && currentTask.status === 'running' && movementActions.includes(currentTask.action)) {
    const isSlow = SLOW_TASK_ACTIONS.has(currentTask.action);
    const threshold = isSlow ? SLOW_TASK_STUCK_MS : FAST_TASK_STUCK_MS;
    const old = positionHistory.find(p => Date.now() - p.time > threshold);
    if (old) {
      const dist = Math.sqrt((pos.x-old.x)**2+(pos.y-old.y)**2+(pos.z-old.z)**2);
      if (dist < 2) {
        // One repath attempt before declaring stuck. Many "STUCK detected"
        // events tonight were transient — a fresh GoalNear with radius+1
        // unblocks the pathfinder (1-block ledge, snow layer, etc.).
        const repathKey = currentTask.id || `${currentTask.action}-${currentTask.started}`;
        const state = taskRepathState.get(repathKey) || { repath_attempted: false };
        if (!state.repath_attempted && currentTask.action === 'goto' && currentTask.params) {
          try {
            const tx = currentTask.params.x, ty = currentTask.params.y, tz = currentTask.params.z;
            if (typeof tx === 'number') {
              bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(tx), Math.floor(ty), Math.floor(tz), 2));
              state.repath_attempted = true;
              taskRepathState.set(repathKey, state);
              stuckTelemetry.repaths += 1;
              log(`STUCK detected (${threshold/1000}s no movement, action=${currentTask.action}) — repathing once with radius+1`);
              return; // give the repath a chance before next 5s check
            }
          } catch {}
        }
        try { bot.pathfinder.setGoal(null); } catch {}
        try { bot.stopDigging(); } catch {}
        try { bot.clearControlStates(); } catch {}
        currentTask.status = 'stuck';
        currentTask.error = `Stuck at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} after ${threshold/1000}s — try a different approach`;
        stuckTelemetry.total += 1;
        stuckTelemetry.byAction[currentTask.action] = (stuckTelemetry.byAction[currentTask.action] || 0) + 1;
        log(`STUCK detected (${threshold/1000}s no movement, action=${currentTask.action}, total_today=${stuckTelemetry.total}) — task cancelled`);
        taskRepathState.delete(repathKey);
      }
    }
  }
  // Also detect stuck on non-bg tasks: if bot is jumping repeatedly in place
  if (!currentTask || currentTask.status !== 'running') {
    const recent = positionHistory.filter(p => Date.now() - p.time < 8000);
    if (recent.length >= 3) {
      const allSameSpot = recent.every(p => 
        Math.abs(p.x - recent[0].x) < 1.5 && Math.abs(p.z - recent[0].z) < 1.5
      );
      if (allSameSpot && !bot.entity.onGround) {
        // Jumping in place — stop all controls
        try { bot.clearControlStates(); } catch {}
        try { bot.pathfinder.setGoal(null); } catch {}
        log('Jump-stuck detected — cleared controls');
      }
    }
  }
}, 5000);

// ── Stale-intent sweep loop (issue #68 Patch 2) ───────────────────
// Independent of the 5s stuck-detection interval — STALE_SWEEP_INTERVAL_MS
// defaults to 30s so we don't burn CPU walking the queue when nothing
// can possibly be stale (entries only become stale after 120s by default).
const _staleSweepTimer = setInterval(() => {
  try { sweepStaleIntents(); } catch (e) { log(`[stale] sweep error: ${e.message}`); }
}, STALE_SWEEP_INTERVAL_MS);
// Keep `_staleSweepTimer` referenced so node doesn't warn about an
// unused identifier; the timer is implicitly cleared on process exit.
void _staleSweepTimer;

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

httpServer.listen(config.api.port, () => {
  log(`╔═══════════════════════════════════════╗`);
  log(`║     HermesCraft Bot Server v4.0      ║`);
  log(`╠═══════════════════════════════════════╣`);
  log(`║  API:  http://localhost:${config.api.port}          ║`);
  log(`║  MC:   ${config.mc.host}:${config.mc.port}                ║`);
  log(`║  User: ${config.mc.username.padEnd(28)}║`);
  log(`╚═══════════════════════════════════════╝`);

  // Connect bot
  createBot().catch(e => {
    log(`Initial connection failed: ${e.message}`);
    log('Bot server is running — POST /connect when Minecraft is ready.');
  });
});

function _clearPendingVoiceTurns(reason) {
  for (const [id, turn] of _pendingVoiceTurns) {
    clearTimeout(turn.timer);
    try {
      turn.resolve({ ok: false, error: reason, in_reply_to: id });
    } catch (e) { /* client already gone */ }
    _pendingVoiceTurns.delete(id);
  }
}

process.on('SIGTERM', () => {
  log('[voice] SIGTERM — clearing pending voice turns');
  _clearPendingVoiceTurns('server_shutdown');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('[voice] SIGINT — clearing pending voice turns');
  _clearPendingVoiceTurns('server_shutdown');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err && err.message ? err.message : err}`);
  if (err && err.stack) log(`  stack: ${err.stack.split('\n').slice(0, 6).join(' | ')}`);
});
process.on('unhandledRejection', (err) => {
  // Print a compact stack so we can root-cause silent async throws (e.g. the
  // chat-handler / perception entity-deref races that surfaced during the
  // voice integration cycle — issue #54 follow-up).
  const msg = err && err.message ? err.message : String(err);
  log(`Unhandled rejection: ${msg}`);
  if (err && err.stack) log(`  stack: ${err.stack.split('\n').slice(0, 6).join(' | ')}`);
});
