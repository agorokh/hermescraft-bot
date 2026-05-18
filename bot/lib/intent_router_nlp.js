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
// Training data lives in lib/intent_corpus.json (see file for utterance/
// intent counts). Train-from-cold is ~30ms; production-time inference is <5ms.
// The corpus is the spec — adding/removing intents = editing JSON.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockStart } from '@nlpjs/basic';
import { findPlayerEntity, resolveAnchorPos, intFromMatch, pickTowerFootOffset } from './player_utils.js';
import { runEmoteWave, runEmoteJump, runEmoteDance, runEmoteSit } from './emotes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, 'intent_corpus.json');

// CLARIFICATION DEADZONE (council 2026-05-17, Gemini + Mistral consensus):
// - ACT_THRESHOLD (>=): fire the skill. High-confidence intent match.
// - CLARIFY_THRESHOLD (>=): don't act; return matched=false so the brain
//   can ask "did you want me to build or just talk?". Prevents
//   "I love towers" / "creepers scare me" from triggering a skill.
// - Below CLARIFY_THRESHOLD: pure brain chat (OOV).
//
// Picked ACT=0.80 (above NLP's confidence on most ambiguous skill phrasings
// in our test set) and CLARIFY=0.55 (above the OOV ceiling we observed
// for genuine conversation; below the floor where a skill-like phrase
// becomes worth a clarifying brain response). Tunable via env vars
// HERMES_NLP_ACT_THRESHOLD / HERMES_NLP_CLARIFY_THRESHOLD.
const ACT_THRESHOLD = parseFloat(process.env.HERMES_NLP_ACT_THRESHOLD || '0.80');
const CLARIFY_THRESHOLD = parseFloat(process.env.HERMES_NLP_CLARIFY_THRESHOLD || '0.55');
// Back-compat alias for existing tests that imported MATCH_THRESHOLD.
const MATCH_THRESHOLD = ACT_THRESHOLD;

// CONTEXT BUFFER (council round 2 unanimous #1 next ask: Gemini's
// "anaphora resolution" + Mistral's "action FIFO"). Per-bot rolling FIFO
// of the last N fired skills + a 5-min expiry. Two consumers:
//   1. repeat_last_action ("do it again" / "another please")
//   2. anaphora pre-processor (below): short utterances like "higher"
//      "again" "another one" "to the left" with no clear classifier
//      match try to amend the last action and re-fire.
const _ctxBufByBot = new Map();
const CTX_BUF_MAX = 5;
const CTX_BUF_TTL_MS = 5 * 60 * 1000;
let _skillSeq = 0;

function _ctxBuf(bot) {
  if (!bot || !bot.username) return null;
  const buf = _ctxBufByBot.get(bot.username);
  if (!buf) return null;
  // Drop stale entries
  const fresh = buf.filter((e) => Date.now() - e.at <= CTX_BUF_TTL_MS);
  if (fresh.length !== buf.length) _ctxBufByBot.set(bot.username, fresh);
  return fresh.length > 0 ? fresh : null;
}

export function recordLastSkill(bot, intent_name, action, body, message) {
  // Stop is a safety primitive — never pollute the repeat/anaphora buffer.
  if (!bot || !bot.username || !intent_name || intent_name === 'repeat_last_action' || intent_name === 'stop' || action === 'stop' || action === 'chat') return null;
  const entry = {
    id: ++_skillSeq,
    intent_name,
    action,
    body: { ...body },
    message: message || null,
    at: Date.now(),
    success: true,
  };
  const buf = _ctxBufByBot.get(bot.username) || [];
  buf.push(entry);
  if (buf.length > CTX_BUF_MAX) buf.shift();
  _ctxBufByBot.set(bot.username, buf);
  return entry.id;
}

export function markLastSkillFailed(bot, skillId) {
  if (!bot || !bot.username) return;
  const buf = _ctxBufByBot.get(bot.username);
  if (!buf || buf.length === 0) return;
  const entry = skillId != null
    ? buf.find((e) => e.id === skillId)
    : buf[buf.length - 1];
  if (entry) entry.success = false;
}

/** Amend the latest buffer entry in place (directional anaphora chains without FIFO churn). */
function updateLastSkillBody(bot, body) {
  if (!bot?.username) return null;
  const buf = _ctxBufByBot.get(bot.username);
  if (!buf?.length) return null;
  const entry = buf[buf.length - 1];
  entry.body = { ...body };
  entry.at = Date.now();
  return entry.id;
}

function getLastSkill(bot) {
  const buf = _ctxBuf(bot);
  if (!buf) return null;
  return buf[buf.length - 1];
}

// Anaphora modifiers: short kid phrases that amend the last action.
// Each entry: { pattern, amend(lastEntry) -> new body, label }
const ANAPHORA_RULES = [
  // Height adjustments for build_tower
  {
    pattern: /^(higher|taller|bigger|go higher|make it taller|taller please)( please| pls)?$/i,
    appliesTo: ['build_tower'],
    amend: (entry) => ({ ...entry.body, height: Math.min(20, (entry.body.height || 5) + 2) }),
    label: 'higher',
  },
  {
    pattern: /^(lower|shorter|smaller|less tall)( please| pls)?$/i,
    appliesTo: ['build_tower'],
    amend: (entry) => ({ ...entry.body, height: Math.max(2, (entry.body.height || 5) - 2) }),
    label: 'shorter',
  },
  // Repeat the same action ("another one", "one more")
  {
    pattern: /^(another( one)?|one more|same again|like before|like the last one)$/i,
    appliesTo: null,  // any
    amend: (entry) => ({ ...entry.body }),
    label: 'repeat',
  },
  // Move/offset ("to the left", "over there") — shift last action's anchor.
  // appliesTo uses ACTION names (not intent names). torch_near_player omitted.
  {
    pattern: /^(to the left|left more|further left)$/i,
    appliesTo: ['build_tower', 'build_schematic', 'goto', 'light_area'],
    amend: (entry, bot, ctx) => {
      const { dx, dz } = _playerRelativeOffset(bot, ctx, 3, 'left');
      return _shiftAnchorBody(entry.body, dx, 0, dz);
    },
    label: 'left',
  },
  {
    pattern: /^(to the right|right more|further right)$/i,
    appliesTo: ['build_tower', 'build_schematic', 'goto', 'light_area'],
    amend: (entry, bot, ctx) => {
      const { dx, dz } = _playerRelativeOffset(bot, ctx, 3, 'right');
      return _shiftAnchorBody(entry.body, dx, 0, dz);
    },
    label: 'right',
  },
  {
    pattern: /^(over there|over here|right here|here)$/i,
    appliesTo: ['build_tower', 'build_schematic', 'goto', 'light_area'],
    amend: (entry, bot, ctx) => {
      const p = resolveAnchorPos(bot, ctx);
      if (!p) return { ...entry.body };
      return _setAnchorBody(entry.body, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    },
    label: 'here',
  },
];

function _playerRelativeOffset(bot, ctx, dist, side) {
  const ent = ctx.senderEntity || findPlayerEntity(bot, ctx.sender);
  const yaw = ent?.yaw ?? bot.entity?.yaw ?? 0;
  const fwdX = -Math.sin(yaw);
  const fwdZ = Math.cos(yaw);
  if (side === 'left') {
    return { dx: Math.round(fwdZ * dist), dz: Math.round(-fwdX * dist) };
  }
  return { dx: Math.round(-fwdZ * dist), dz: Math.round(fwdX * dist) };
}

function _shiftAnchorBody(body, dx, dy, dz) {
  const out = { ...body };
  if ('cx' in body || 'cy' in body || 'cz' in body) {
    out.cx = Math.floor((body.cx ?? 0) + dx);
    out.cy = Math.floor((body.cy ?? 0) + dy);
    out.cz = Math.floor((body.cz ?? 0) + dz);
  }
  if ('x' in body || 'y' in body || 'z' in body) {
    out.x = Math.floor((body.x ?? 0) + dx);
    out.y = Math.floor((body.y ?? 0) + dy);
    out.z = Math.floor((body.z ?? 0) + dz);
  }
  return out;
}

function _setAnchorBody(body, x, y, z) {
  const out = { ...body };
  if ('cx' in body || 'cy' in body || 'cz' in body) {
    out.cx = x;
    out.cy = y;
    out.cz = z;
  }
  if ('x' in body || 'y' in body || 'z' in body) {
    out.x = x;
    out.y = y;
    out.z = z;
  }
  return out;
}

function _isStrictAnaphoraPhrase(body) {
  const t = body.trim();
  return ANAPHORA_RULES.some((rule) => rule.pattern.test(t));
}

function _tryAnaphora(bot, body, ctx) {
  const last = getLastSkill(bot);
  if (!last) return null;
  // Council Gemini round 3: do NOT replay/amend a failed action. "another"
  // after a tower that bombed (no materials, blocked area) would just
  // replay the same failure. Fall through so brain can ask or kid retries.
  if (last.success === false) return null;
  for (const rule of ANAPHORA_RULES) {
    if (!rule.pattern.test(body.trim())) continue;
    if (rule.appliesTo && !rule.appliesTo.includes(last.action)) continue;
    const newBody = rule.amend(last, bot, ctx);
    return {
      action: last.action,
      body: newBody,
      intent_name: last.intent_name,
      anaphora: rule.label,
    };
  }
  return null;
}

let _nlp = null;
let _trainPromise = null;

async function ensureTrained() {
  if (_nlp) return _nlp;
  if (_trainPromise) {
    try {
      return await _trainPromise;
    } catch (e) {
      _trainPromise = null;
      throw e;
    }
  }
  _trainPromise = (async () => {
    try {
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
    } catch (e) {
      _trainPromise = null;
      throw e;
    }
  })();
  return _trainPromise;
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

  emote_wave: async (bot, ctx) => {
    await runEmoteWave(bot, ctx.dryRun);
    return { action: 'chat', body: { text: '👋' } };
  },
  emote_jump: async (bot, ctx) => {
    await runEmoteJump(bot, ctx.dryRun);
    return { action: 'chat', body: { text: '🦘' } };
  },
  emote_dance: async (bot, ctx) => {
    await runEmoteDance(bot, ctx.dryRun);
    return { action: 'chat', body: { text: '💃' } };
  },
  emote_sit: async (bot, ctx) => {
    await runEmoteSit(bot, ctx.dryRun);
    return { action: 'chat', body: { text: 'sitting :)' } };
  },

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
    const countMatch = ctx.body.match(/\b(\d+)\s*(wood|logs?|oak|dirt|stone|cobble|cobblestone|sand)\b/i);
    const count = countMatch ? parseInt(countMatch[1], 10) : 4;
    return { action: 'collect', body: { block, count: Math.min(count, 16) } };
  },

  torch_near_me: (_bot, ctx) => ({
    action: 'place_near_player',
    body: { player: ctx.sender, item: 'torch', direction: 'side' },
  }),

  flower_give: (bot, ctx) => {
    const flowers = ['poppy', 'rose_bush', 'red_tulip', 'pink_tulip', 'dandelion', 'blue_orchid'];
    const found = bot.inventory.items().find((i) => flowers.includes(i.name));
    const item = found ? found.name : 'poppy';
    return { action: 'give_to_player', body: { player: ctx.sender, item, count: 1 } };
  },

  build_schematic: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    const body = ctx.body.toLowerCase();
    let name = null;
    // Ice/snow MUST be checked BEFORE generic house/cottage — kid asking
    // for an "ice house" wants the ice castle, not the oak cottage.
    if (/\b(ice|frozen|frosty)\b.*\b(castle|fort|house|palace|home|cottage)\b/.test(body)) name = 'ice_castle';
    else if (/\bice\s*castle\b/.test(body)) name = 'ice_castle';
    else if (/\b(igloo|snow\s*house|snow\s*home|snow\s*shelter|snow\s*hut)\b/.test(body)) name = 'igloo';
    else if (/\b(treehouse|tree house|tree fort|tree home)\b/.test(body)) name = 'treehouse';
    else if (/\b(house|cottage|home|cabin)\b/.test(body)) name = 'small_house';
    else if (/\b(well|fountain)\b/.test(body)) name = 'well';
    else if (/\b(garden|flower bed|flower patch|flower garden)\b/.test(body)) name = 'garden';
    // "fancy castle with battlements" / "watchtower" / generic castle —
    // route to ice_castle (our only "castle" schematic) if no ice/snow
    // keyword, else use small_tower.
    else if (/\b(castle|fort|palace)\b/.test(body)) name = 'ice_castle';
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
    const [dx, dz] = pickTowerFootOffset(bot, p);
    return {
      action: 'build_tower',
      body: { x: Math.floor(p.x) + dx, y: baseY, z: Math.floor(p.z) + dz, height, material },
    };
  },

  come_here: (bot, ctx) => {
    // Require a resolved sender — do not fall back to bot position (no-op goto).
    if (!ctx.senderEntity?.position) return null;
    const p = ctx.senderEntity.position;
    return { action: 'goto', body: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } };
  },

  plant_flowers: (bot, ctx) => {
    if (!ctx.senderEntity?.position) return null;
    const flowers = ['poppy', 'dandelion', 'blue_orchid', 'rose_bush', 'red_tulip'];
    const found = bot.inventory.items().find((i) => flowers.includes(i.name));
    const item = found ? found.name : 'poppy';
    return {
      action: 'place_near_player',
      body: { player: ctx.sender, item, direction: 'side' },
    };
  },

  follow_me: (_bot, ctx) => ({ action: 'follow_player_v2', body: { player: ctx.sender, distance: 3 } }),

  race_to_coords: (_bot, ctx) => {
    const m = ctx.body.match(/(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
    if (!m) return null;
    return { action: 'goto', body: { x: parseInt(m[1], 10), y: parseInt(m[2], 10), z: parseInt(m[3], 10) } };
  },

  // server.js has no 'bg_collect' ACTION; that's a /task/ endpoint name.
  // Use 'collect' (find + dig + pickup) — matches the regex router's choice
  // in lib/intent_router.js mine_iron handler.
  mine_iron: (_bot, ctx) => {
    const oreMatch = ctx.body.match(/\b(iron|coal|diamond|copper|gold)\b/i);
    if (!oreMatch) return null;
    const block = `${oreMatch[1].toLowerCase()}_ore`;
    return { action: 'collect', body: { block, count: 3 } };
  },

  // ─── NEW intents from realistic kid corpus + skill-gap analysis ─────
  // For intents that need a new server.js ACTION (fish, farm, cook,
  // ride, tame), we return null → matched=false → brain handles. That's
  // graceful — the router only routes what it can execute, brain owns
  // everything else. Filed as PR follow-up issues.

  // defend_me / attack_mob: server.js ACTIONS.fight accepts
  // { target?, retreat_health?, duration? } — when target is null/omitted
  // fight auto-picks the nearest hostile in the visible-fair-play set.
  // (Previously passed bogus {target_class, mode} keys — cursor PR review
  // catch.) Use duration 30s for defend (longer holdout) vs 15s for attack
  // (one-and-done feel).
  defend_me: () => ({ action: 'fight', body: { duration: 30, retreat_health: 8 } }),
  attack_mob: (_bot, ctx) => {
    const mobMatch = ctx.body.match(/\b(zombie|skeleton|creeper|spider|enderman|witch|blaze|phantom|drowned|husk|stray|slime|ghast|silverfish|pillager|vindicator|hoglin|piglin)\b/i);
    const body = { duration: 15 };
    if (mobMatch) body.target = mobMatch[1].toLowerCase();
    return { action: 'fight', body };
  },

  // light_area: schematic-grade lighting around the kid's position.
  light_area: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    return {
      action: 'light_area',
      body: { cx: Math.floor(p.x), cy: Math.floor(p.y), cz: Math.floor(p.z), radius: 6 },
    };
  },

  // bring_food: give_to_player whatever edible thing the bot has on hand.
  // Falls through if bot has nothing edible — brain can apologize.
  bring_food: (bot, ctx) => {
    const edible = ['cooked_beef', 'bread', 'cooked_chicken', 'cooked_porkchop',
                    'apple', 'baked_potato', 'cooked_cod', 'cooked_salmon',
                    'beef', 'chicken', 'porkchop', 'carrot'];
    const found = bot.inventory.items().find((i) => edible.includes(i.name));
    if (!found) return null;
    return { action: 'give_to_player', body: { player: ctx.sender, item: found.name, count: Math.min(found.count, 4) } };
  },

  // build_shelter_for_night: emergency safe spot — reuse small_house schematic.
  build_shelter_for_night: (bot, ctx) => {
    const p = resolveAnchorPos(bot, ctx);
    if (!p) return null;
    return {
      action: 'build_schematic',
      body: { name: 'small_house', x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z) },
    };
  },

  // explore_cave: scout toward the nearest stone-y opening. For now, just
  // walk a short distance in the bot's facing direction; brain narrates.
  explore_cave: (bot) => {
    const ent = bot.entity;
    if (!ent?.position) return null;
    const p = ent.position;
    const yaw = ent.yaw ?? 0;
    const dist = 10;
    const dx = -Math.sin(yaw) * dist;
    const dz = Math.cos(yaw) * dist;
    return {
      action: 'goto',
      body: { x: Math.floor(p.x + dx), y: Math.floor(p.y), z: Math.floor(p.z + dz) },
    };
  },

  // give_compliment, show_me_diamonds, ask_about_pet: pure conversational —
  // route to a chat ACK so the kid sees instant response while brain
  // composes the longer reply. The chat ACK is intentionally minimal;
  // brain produces the personality.
  give_compliment: (_bot, ctx) => ({
    action: 'chat', body: { text: `you did awesome, ${ctx.sender}!` },
  }),
  show_me_diamonds: () => ({ action: 'chat', body: { text: 'whoaaa look at those diamonds 💎' } }),
  ask_about_pet: () => ({ action: 'chat', body: { text: "lemme check on your pet — hang on" } }),

  // Not wired to server ACTIONS yet — instant chat ACK so kids aren't left silent.
  fish_for_food: () => ({ action: 'chat', body: { text: "i'll try to catch some fish — hang on" } }),
  farm_food: () => ({ action: 'chat', body: { text: "let me set up some crops for us" } }),
  cook_food: () => ({ action: 'chat', body: { text: "i'll cook something up — one sec" } }),
  ride_horse: () => ({ action: 'chat', body: { text: "ok let's find a horse to ride" } }),
  tame_animal: () => ({ action: 'chat', body: { text: "i'll try to tame one — stay close" } }),

  // Council recommendation 2026-05-17 (Gemini + Mistral both flagged):
  // "do it again" / "another please" / "same as before" — kids constantly
  // chain a satisfying action. Replays the most recent skill the same bot
  // fired (within a 5-min window) for any kid.
  //
  // body is deep-cloned (shallow spread) so callers that mutate the body
  // — e.g. anaphora 'higher' incrementing height — don't corrupt the
  // cached context entry. (cursor PR review catch.)
  repeat_last_action: (bot) => {
    const last = getLastSkill(bot);
    if (!last || last.success === false || !last.action || !last.body) return null;
    return { action: last.action, body: { ...last.body } };
  },
};

// Public API — drop-in replacement for intent_router.tryRoute.
// Same return shape: {matched, intent_name, action, body}.
export async function tryRoute(bot, body, sender, opts = {}) {
  if (!bot || !body) return { matched: false };
  // ANAPHORA PRE-PROCESSOR (council round 2 unanimous): short modifier
  // phrases ("higher", "again", "over there") amend the last fired skill
  // BEFORE NLP gets a vote. NLP doesn't know the previous action; only
  // the per-bot context buffer does. Wins precedence so "higher" after a
  // tower build means "rebuild the same tower 2 blocks taller", not
  // some classifier guess.
  const senderEntity = findPlayerEntity(bot, sender);
  const ctx = { sender, senderEntity, message: body, body, dryRun: opts.dryRun };
  const anaphora = _isStrictAnaphoraPhrase(body) ? _tryAnaphora(bot, body, ctx) : null;
  if (anaphora) {
    let skill_id = null;
    if (!opts.dryRun) {
      if (['higher', 'shorter', 'left', 'right', 'here'].includes(anaphora.anaphora)) {
        skill_id = updateLastSkillBody(bot, anaphora.body);
      } else if (anaphora.anaphora === 'repeat') {
        skill_id = getLastSkill(bot)?.id ?? null;
      }
    }
    return {
      matched: true,
      intent_name: anaphora.intent_name,
      action: anaphora.action,
      body: anaphora.body,
      skill_id,
      nlp_score: null,
      nlp_zone: 'anaphora',
      anaphora_rule: anaphora.anaphora,
    };
  }
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
  // Three-zone confidence band (council 2026-05-17):
  //   score >= ACT_THRESHOLD       → fire the skill
  //   CLARIFY <= score < ACT       → defer to brain; brain may clarify
  //   score < CLARIFY              → OOV; brain handles as free chat
  // All zones return matched=false unless we ACT. The "clarify" status is
  // a hint for the brain (server.js can read .nlp_zone for prompt context).
  if (!intent || score < CLARIFY_THRESHOLD) {
    return { matched: false, nlp_intent: intent, nlp_score: score, nlp_zone: 'oov' };
  }
  if (score < ACT_THRESHOLD) {
    return { matched: false, nlp_intent: intent, nlp_score: score, nlp_zone: 'clarify' };
  }
  const dispatch = DISPATCHERS[intent];
  if (!dispatch) {
    return { matched: false, nlp_intent: intent, nlp_score: score, nlp_zone: 'no_dispatcher', error: 'no dispatcher for ' + intent };
  }
  // ctx already constructed above for anaphora; reuse to avoid double-lookup
  const decision = await Promise.resolve(dispatch(bot, ctx));
  if (!decision) {
    return { matched: false, nlp_intent: intent, nlp_score: score, nlp_zone: 'dispatcher_null', error: 'dispatcher returned null' };
  }
  // Record this for future repeat_last_action — only if NOT a repeat itself
  // (avoid recursion on "do it again ... do it again").
  const skill_id = opts.dryRun
    ? null
    : (intent === 'repeat_last_action'
      ? (getLastSkill(bot)?.id ?? null)
      : recordLastSkill(bot, intent, decision.action, decision.body, body));
  return {
    matched: true,
    intent_name: intent,
    action: decision.action,
    body: decision.body,
    skill_id,
    nlp_score: score,
    nlp_zone: 'act',
  };
}

export { MATCH_THRESHOLD, ACT_THRESHOLD, CLARIFY_THRESHOLD };
