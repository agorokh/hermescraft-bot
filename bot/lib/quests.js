// HermesCraft quest engine — minimal state-machine driver for kid-play
// storylines. The operator's storytelling vision: villages, quests, cities,
// "engage the journey for kids."
//
// A QUEST is a directed sequence of steps. Each step has:
//   - trigger: { kind: 'player_join' | 'player_pos_in_box' | 'player_chat'
//              | 'timer' | 'player_has_item' }
//   - actions: array of skill primitive calls to fire when the trigger
//     matches. Actions reuse the existing ACTIONS map (mc_chat, build_tower,
//     build_schematic, give_to_player, place_near_player, etc.)
//
// Quests live in vendor/hermescraft/bot/quests/*.json with an INDEX.json
// registry. The engine loads all quests on spawn, evaluates triggers via
// poll-on-tick (every 1s for position+inventory, event-driven for chat+
// join), and advances each quest's currentStep when matched. Quests can
// run in parallel across bots (Rosie + Steve can each own different quests).
//
// THIS IS V0. It's intentionally minimal: deterministic, no LLM in the
// loop, no branching. The kid-engagement bar is "thing happens after I do
// X" — that's the contract. Branching narratives + LLM-authored quests
// come in a later round.

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { actionOutcomeFailed } from './action_outcome.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const QUESTS_DIR = join(__dirname, '..', 'quests');

// In-memory state per quest per bot.
// Map<bot_username, Map<quest_name, {currentStep, state, params}>>
const _quest_state = new Map();

async function loadQuestIndex() {
  try {
    const raw = await readFile(join(QUESTS_DIR, 'INDEX.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { quests: {} };
  }
}

async function loadAllQuests() {
  const idx = await loadQuestIndex();
  const quests = [];
  for (const [name, entry] of Object.entries(idx.quests || {})) {
    try {
      const raw = await readFile(join(QUESTS_DIR, entry.file), 'utf8');
      quests.push({ name, ...JSON.parse(raw) });
    } catch (e) { /* skip broken quest */ }
  }
  return quests;
}

function normalizeQuestItemName(item) {
  if (item == null) return '';
  return String(item).toLowerCase().replace(/^minecraft:/, '');
}

function itemNameFromCollectEntity(collected) {
  if (!collected) return null;
  if (typeof collected.getDroppedItem === 'function') {
    const stack = collected.getDroppedItem();
    if (stack?.name) return stack.name;
    if (stack?.displayName) return stack.displayName;
  }
  const metaItem = collected.metadata?.find?.((m) => m && m.type === 7)?.value?.itemId;
  if (metaItem) return metaItem;
  return collected.name || collected.displayName || null;
}

function questItemNamesMatch(triggerItem, eventItem) {
  const want = normalizeQuestItemName(triggerItem);
  const got = normalizeQuestItemName(eventItem);
  if (!want || !got) return false;
  return got === want || got.endsWith(`/${want}`) || want.endsWith(`/${got}`);
}

function resolvePosBox(trigger, qs) {
  if (trigger.box === 'quest_anchor' && qs.anchor) {
    const r = trigger.radius || 5;
    const { x, y, z } = qs.anchor;
    return [x - r, y - r, z - r, x + r, y + r, z + r];
  }
  if (!Array.isArray(trigger.box) || trigger.box.length < 6) return null;
  return trigger.box;
}

function shouldBindQuestParticipant(trigger, event) {
  if (!event?.player) return false;
  switch (trigger.kind) {
    case 'player_chat':
    case 'player_join':
      return !trigger.player || trigger.player === event.player;
    case 'player_has_item':
      return event.kind === 'player_collected'
        && (!trigger.player || trigger.player === '@last_chatter' || trigger.player === event.player);
    default:
      return false;
  }
}

function evalTrigger(trigger, ctx) {
  // ctx: { bot, event (optional), now, player_pos_cache }
  const { bot, event, now } = ctx;
  switch (trigger.kind) {
    case 'player_join':
      return event && event.kind === 'player_join'
          && (!trigger.player || event.player === trigger.player);

    case 'player_chat': {
      if (!event || event.kind !== 'player_chat') return false;
      if (trigger.player && event.player !== trigger.player) return false;
      try {
        const re = new RegExp(trigger.regex, trigger.flags || 'i');
        return re.test(event.message);
      } catch (e) { return false; }
    }

    case 'player_pos_in_box': {
      const targetName = trigger.player === '@last_chatter'
        ? ctx.last_chatter
        : trigger.player;
      if (!targetName) return false;
      const box = resolvePosBox(trigger, ctx.qstate);
      if (!box) return false;
      const p = bot.players?.[targetName]?.entity;
      if (!p) return false;
      const [x1, y1, z1, x2, y2, z2] = box;
      const px = p.position.x, py = p.position.y, pz = p.position.z;
      return px >= Math.min(x1, x2) && px <= Math.max(x1, x2)
          && py >= Math.min(y1, y2) && py <= Math.max(y1, y2)
          && pz >= Math.min(z1, z2) && pz <= Math.max(z1, z2);
    }

    case 'player_has_item': {
      if (!event || event.kind !== 'player_collected') return false;
      const targetPlayer = trigger.player === '@last_chatter'
        ? ctx.last_chatter
        : trigger.player;
      if (targetPlayer && event.player !== targetPlayer) return false;
      return questItemNamesMatch(trigger.item, event.item);
    }

    case 'timer': {
      const qstate = ctx.qstate;
      if (!qstate || !qstate.step_entered_at) return false;
      return (now - qstate.step_entered_at) >= (trigger.delay_ms || 0);
    }

    case 'always': return true;
    default: return false;
  }
}

async function executeAction(ACTIONS, bot, action, ctx) {
  const { kind } = action;
  const lookupPlayer = (name) => {
    if (!name || name === '@last_chatter') return ctx.last_chatter || null;
    return name;
  };
  switch (kind) {
    case 'chat': {
      const text = String(action.text || '').slice(0, 250);
      try { bot.chat(text); } catch (e) {}
      return { ok: true };
    }
    case 'build_schematic': {
      const name = action.name;
      let x = action.x, y = action.y, z = action.z;
      if (action.relative_to_player) {
        const pn = lookupPlayer(action.relative_to_player);
        const p = bot.players?.[pn]?.entity?.position;
        if (p) {
          x = Math.floor(p.x) + (action.dx || 0);
          y = Math.floor(p.y) + (action.dy || 0);
          z = Math.floor(p.z) + (action.dz || 0);
        }
      }
      if (!ACTIONS.build_schematic) return { error: 'no build_schematic action' };
      const result = await ACTIONS.build_schematic({ name, x, y, z });
      if (x != null && y != null && z != null && !actionOutcomeFailed(result)) {
        ctx.qstate.anchor = { x, y, z };
      }
      return result;
    }
    case 'give_to_player': {
      const player = lookupPlayer(action.player);
      if (!ACTIONS.give_to_player) return { error: 'no give_to_player action' };
      return await ACTIONS.give_to_player({ player, item: action.item, count: action.count || 1 });
    }
    case 'build_tower': {
      let x = action.x, y = action.y, z = action.z;
      if (action.relative_to_player) {
        const pn = lookupPlayer(action.relative_to_player);
        const p = bot.players?.[pn]?.entity?.position;
        if (p) {
          x = Math.floor(p.x) + (action.dx || 1);
          y = Math.floor(p.y) + (action.dy || 0);
          z = Math.floor(p.z) + (action.dz || 0);
        }
      }
      if (!ACTIONS.build_tower) return { error: 'no build_tower action' };
      return await ACTIONS.build_tower({ x, y, z, height: action.height || 5, material: action.material || 'oak_planks' });
    }
    case 'place_near_player': {
      const player = lookupPlayer(action.player);
      if (!ACTIONS.place_near_player) return { error: 'no place_near_player action' };
      return await ACTIONS.place_near_player({ player, item: action.item, direction: action.direction || 'side' });
    }
    case 'goto': {
      let x = action.x, y = action.y, z = action.z;
      if (action.relative_to_player) {
        const pn = lookupPlayer(action.relative_to_player);
        const p = bot.players?.[pn]?.entity?.position;
        if (p) {
          x = Math.floor(p.x) + (action.dx || 0);
          y = Math.floor(p.y) + (action.dy || 0);
          z = Math.floor(p.z) + (action.dz || 0);
        }
      }
      if (!ACTIONS.goto) return { error: 'no goto action' };
      return await ACTIONS.goto({ x, y, z });
    }
    default:
      return { error: `unknown action kind: ${kind}` };
  }
}

// ── Public installer ──────────────────────────────────────────────────

export async function installQuestEngine(bot, ACTIONS, log) {
  const botName = bot.username || 'unknown';
  let botState = _quest_state.get(botName);
  if (!botState) { botState = new Map(); _quest_state.set(botName, botState); }

  const quests = await loadAllQuests();
  if (quests.length === 0) {
    log && log('[quests] no quests installed (vendor/hermescraft/bot/quests/INDEX.json empty)');
    return () => {};
  }

  const myQuests = quests.filter((q) => !q.owner || q.owner === 'both' || q.owner === botName);
  for (const q of myQuests) {
    if (!botState.has(q.name)) {
      botState.set(q.name, { currentStep: 0, status: 'active', step_entered_at: Date.now(), anchor: null });
    } else if (botState.get(q.name).status === 'done') {
      botState.set(q.name, { currentStep: 0, status: 'active', step_entered_at: Date.now(), anchor: null, last_chatter: null });
    }
  }
  log && log(`[quests] ${botName} watching ${myQuests.length} quests: ${myQuests.map((q) => q.name).join(', ')}`);

  async function advance(q, eventCtx) {
    const qs = botState.get(q.name);
    if (!qs || qs.status !== 'active' || qs._advancing) return;
    const step = q.steps[qs.currentStep];
    if (!step) {
      qs.status = 'done';
      log && log(`[quests] ${q.name} finished`);
      return;
    }
    const ctx = {
      bot,
      event: eventCtx,
      now: Date.now(),
      qstate: qs,
      last_chatter: qs.last_chatter,
    };
    if (!evalTrigger(step.trigger, ctx)) return;

    if (eventCtx && shouldBindQuestParticipant(step.trigger, eventCtx)) {
      qs.last_chatter = eventCtx.player;
      ctx.last_chatter = eventCtx.player;
    }

    qs._advancing = true;
    try {
      log && log(`[quests] ${q.name} step ${qs.currentStep} fired: ${step.trigger.kind}`);
      let stepOk = true;
      for (const action of (step.actions || [])) {
        try {
          const result = await executeAction(ACTIONS, bot, action, ctx);
          if (actionOutcomeFailed(result)) {
            stepOk = false;
            log && log(`[quests] action failed: ${result?.error || result?.result || 'unknown'}`);
          }
        } catch (e) {
          stepOk = false;
          log && log(`[quests] action error: ${e.message}`);
        }
      }
      if (stepOk) {
        qs.currentStep++;
        qs.step_entered_at = Date.now();
      }
    } finally {
      qs._advancing = false;
    }
  }

  const onJoin = async (player) => {
    if (player.username === bot.username) return;
    for (const q of myQuests) await advance(q, { kind: 'player_join', player: player.username });
  };
  const onChat = async (username, message) => {
    if (username === bot.username) return;
    for (const q of myQuests) await advance(q, { kind: 'player_chat', player: username, message });
  };
  const onCollect = async (collector, collected) => {
    if (!collector || collector.username === bot.username) return;
    const itemName = itemNameFromCollectEntity(collected);
    for (const q of myQuests) await advance(q, { kind: 'player_collected', player: collector.username, item: itemName });
  };

  bot.on('playerJoined', onJoin);
  bot.on('chat', onChat);
  bot.on('playerCollect', onCollect);

  const interval = setInterval(async () => {
    for (const q of myQuests) await advance(q, null);
  }, 1000);

  return function tearDown() {
    clearInterval(interval);
    try { bot.removeListener('playerJoined', onJoin); } catch {}
    try { bot.removeListener('chat', onChat); } catch {}
    try { bot.removeListener('playerCollect', onCollect); } catch {}
  };
}
