// NLP.js-backed intent router — drop-in replacement for the hand-rolled
// regex INTENTS table in intent_router.js. Preserves the same public API
// (tryRoute returns {matched, intent_name, action, body}) so server.js
// can swap implementations without other changes.
//
// Why this exists (post-mortem 2026-05-18 council, 4-of-5 consensus —
// see PR #57 comment thread): regex on free-form kid speech is the wrong
// tool. "treehouse" vs "house" is a tokenization problem any trained
// classifier solves on day one. The hand-rolled router accumulated 42
// patterns across 17 intents and still missed common kid phrasings.
//
// Architecture (preserves Hermes's "talk + react + build" identity):
//   1. NLP.js classifies the kid's utterance into an intent + confidence
//   2. If confidence >= MATCH_THRESHOLD (default 0.70), route to the same
//      ACTIONS handler the regex used (build_tower, place_near_player, etc.)
//   3. If confidence < threshold, return {matched: false} — falls through
//      to the brain, which produces conversational + situational responses.
//      The brain ALWAYS sees the chat regardless (server.js social-event
//      polling is independent of router fires). This is why Rosie stays
//      in-character while the router takes the latency-critical path.
//   4. `stop` keeps its regex hot-path in the original intent_router.js —
//      sub-50ms safety primitive that doesn't tolerate any classification
//      latency or error. NLP handles everything else.
//
// Training data lives in lib/intent_corpus.json (503 utterances / 17
// intents). Train-from-cold is ~30ms; production-time inference is <5ms.
// The corpus is the spec — adding/removing intents = editing JSON.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockStart } from '@nlpjs/basic';
import { Vec3 } from 'vec3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, 'intent_corpus.json');

// Confidence floor. Below this we return matched=false and let the brain
// handle it as free chat. Tuned empirically against the 6 kid-build prompts
// — 0.72 was the lowest confidence on a correct classification (torch
// prompt with 30 training utterances). 0.70 gives a small safety margin
// while still rejecting OOV like "what's the weather today" (0.62).
const MATCH_THRESHOLD = 0.70;

let _nlp = null;
let _trainPromise = null;

async function ensureTrained() {
  if (_nlp) return _nlp;
  if (_trainPromise) return _trainPromise;
  _trainPromise = (async () => {
    const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
    const dock = await dockStart({ use: ['Basic'] });
    const nlp = dock.get('nlp');
    nlp.addLanguage('en');
    for (const d of corpus.data) {
      for (const u of d.utterances) nlp.addDocument('en', u, d.intent);
    }
    await nlp.train();
    _nlp = nlp;
    return nlp;
  })();
  return _trainPromise;
}

// Same player-lookup + anchor-position helpers as the regex router. Copied
// rather than imported so this file stands alone and can be swapped without
// loading intent_router.js at all.
function findPlayerEntity(bot, name) {
  if (!name) return null;
  const lname = name.toLowerCase();
  for (const [n, p] of Object.entries(bot.players || {})) {
    if (n === bot.username) continue;
    if (n.toLowerCase() === lname || n.toLowerCase().replace(/^\./, '') === lname) {
      if (p.entity) return p.entity;
    }
  }
  return Object.values(bot.entities || {}).find((e) => {
    if (e === bot.entity) return false;
    if (e.type !== 'player') return false;
    const en = (e.username || '').toLowerCase();
    return en === lname || en.replace(/^\./, '') === lname;
  }) || null;
}

function resolveAnchorPos(bot, ctx) {
  if (ctx.senderEntity && ctx.senderEntity.position) return ctx.senderEntity.position;
  const fresh = findPlayerEntity(bot, ctx.sender);
  if (fresh && fresh.position) return fresh.position;
  if (bot.entity && bot.entity.position) return bot.entity.position;
  return null;
}

function intFromMatch(text, regex) {
  const m = text.match(regex);
  return m ? parseInt(m[1], 10) : null;
}

// Intent → action dispatch. The classifier picks the intent; this maps it
// to a concrete action body (with slot extraction where needed).
const DISPATCHERS = {
  stop: () => ({ action: 'stop', body: {} }),

  report_position: (bot) => {
    const p = bot.entity.position;
    return { action: 'chat', body: { text: `at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` } };
  },

  report_inventory: (bot) => {
    const items = bot.inventory.items().slice(0, 5).map((i) => `${i.name}x${i.count}`).join(', ');
    return { action: 'chat', body: { text: items ? `got ${items}` : 'empty hands' } };
  },

  emote_wave: () => ({ action: 'chat', body: { text: '👋' } }),
  emote_jump: () => ({ action: 'chat', body: { text: '🦘' } }),
  emote_dance: () => ({ action: 'chat', body: { text: '💃' } }),
  emote_sit: () => ({ action: 'chat', body: { text: 'sitting :)' } }),

  gather_block: (_bot, ctx) => {
    const m = ctx.body.match(/\b(wood|logs?|oak|dirt|stone|cobble|cobblestone|sand)\b/i);
    if (!m) return null;
    const raw = m[1].toLowerCase();
    const blockMap = {
      wood: 'oak_log', logs: 'oak_log', log: 'oak_log', oak: 'oak_log',
      dirt: 'dirt', stone: 'stone', cobble: 'cobblestone',
      cobblestone: 'cobblestone', sand: 'sand',
    };
    const block = blockMap[raw] || 'oak_log';
    const countMatch = ctx.body.match(/\b(\d+)\s*(wood|logs?|dirt|stone|cobble|sand)/i);
    const count = countMatch ? parseInt(countMatch[1], 10) : 4;
    return { action: 'collect', body: { block, count: Math.min(count, 16) } };
  },

  torch_near_me: (_bot, ctx) => ({
    action: 'place_near_player',
    body: { player: ctx.sender, item: 'torch', direction: 'side' },
  }),

  flower_give: (_bot, ctx) => ({
    action: 'give_to_player',
    body: { player: ctx.sender, item: 'poppy', count: 1 },
  }),

  build_schematic: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    const body = ctx.body.toLowerCase();
    let name = null;
    if (/\b(treehouse|tree house|tree fort|tree home)\b/.test(body)) name = 'treehouse';
    else if (/\b(house|cottage|home|cabin)\b/.test(body)) name = 'small_house';
    else if (/\b(well|fountain)\b/.test(body)) name = 'well';
    else if (/\b(garden|flower bed|flower patch|flower garden)\b/.test(body)) name = 'garden';
    else if (/\b(tower|watchtower|outpost)\b/.test(body)) name = 'small_tower';
    else if (/\b(campfire|fire pit|firepit|sit spot|hangout)\b/.test(body)) name = 'campfire_spot';
    else if (/\b(what can|show me|list)\b/.test(body)) return { action: 'list_schematics', body: {} };
    if (!name) return null;
    return {
      action: 'build_schematic',
      body: { name, x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z) },
    };
  },

  build_tower: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    const height = intFromMatch(ctx.body, /(\d+)\s*(blocks?\s*)?(high|tall)/i) || 5;
    const buildables = ['oak_planks', 'cobblestone', 'stone', 'oak_log', 'dirt', 'spruce_planks'];
    const found = bot.inventory.items().find((i) => buildables.includes(i.name));
    const material = found ? found.name : 'oak_planks';
    const baseY = Math.floor(p.y);
    const offsets = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0]];
    let chosen = offsets[0];
    for (const [dx, dz] of offsets) {
      const targetX = Math.floor(p.x) + dx;
      const targetZ = Math.floor(p.z) + dz;
      const at = bot.blockAt(new Vec3(targetX, baseY, targetZ));
      if (!at || at.name === 'air' || at.name === 'short_grass' || at.name === 'tall_grass') {
        chosen = [dx, dz];
        break;
      }
    }
    return {
      action: 'build_tower',
      body: { x: Math.floor(p.x) + chosen[0], y: baseY, z: Math.floor(p.z) + chosen[1], height, material },
    };
  },

  come_here: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    return { action: 'goto', body: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } };
  },

  plant_flowers: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    return {
      action: 'fill',
      body: { x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z), w: 3, h: 1, d: 3, item: 'poppy' },
    };
  },

  follow_me: (_bot, ctx) => ({ action: 'follow_player_v2', body: { player: ctx.sender } }),

  race_to_coords: (_bot, ctx) => {
    const m = ctx.body.match(/(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
    if (!m) return null;
    return { action: 'goto', body: { x: parseInt(m[1]), y: parseInt(m[2]), z: parseInt(m[3]) } };
  },

  mine_iron: () => ({ action: 'bg_collect', body: { block: 'iron_ore', count: 4 } }),
};

// Public API — drop-in replacement for intent_router.tryRoute.
// Same return shape: {matched, intent_name, action, body}.
export async function tryRoute(bot, body, sender) {
  if (!bot || !body) return { matched: false };
  let nlp;
  try {
    nlp = await ensureTrained();
  } catch (e) {
    // If the corpus is malformed or training fails, fail open — the brain
    // will handle the chat. Never blocking on NLP startup is critical for
    // production health.
    return { matched: false, error: e.message };
  }
  const result = await nlp.process('en', body);
  const intent = result.intent === 'None' ? null : result.intent;
  const score = result.score || 0;
  if (!intent || score < MATCH_THRESHOLD) {
    return { matched: false, nlp_intent: intent, nlp_score: score };
  }
  const dispatch = DISPATCHERS[intent];
  if (!dispatch) {
    return { matched: false, nlp_intent: intent, nlp_score: score, error: 'no dispatcher' };
  }
  const senderEntity = findPlayerEntity(bot, sender);
  const ctx = { sender, senderEntity, message: body, body };
  const decision = dispatch(bot, ctx);
  if (!decision) {
    return { matched: false, nlp_intent: intent, nlp_score: score, error: 'dispatcher returned null' };
  }
  return {
    matched: true,
    intent_name: intent,
    action: decision.action,
    body: decision.body,
    nlp_score: score,
  };
}

export { MATCH_THRESHOLD };
