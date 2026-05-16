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

import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

async function loadQuest(name) {
  const idx = await loadQuestIndex();
  const entry = idx.quests?.[name];
  if (!entry) return null;
  const raw = await readFile(join(QUESTS_DIR, entry.file), 'utf8');
  return { entry, ...JSON.parse(raw) };
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
      // Poll-driven. trigger.box = [x1, y1, z1, x2, y2, z2]
      const targetName = trigger.player;
      if (!targetName) return false;
      const p = bot.players?.[targetName]?.entity;
      if (!p) return false;
      const [x1, y1, z1, x2, y2, z2] = trigger.box;
      const px = p.position.x, py = p.position.y, pz = p.position.z;
      return px >= Math.min(x1, x2) && px <= Math.max(x1, x2)
          && py >= Math.min(y1, y2) && py <= Math.max(y1, y2)
          && pz >= Math.min(z1, z2) && pz <= Math.max(z1, z2);
    }

    case 'player_has_item': {
      // Best-effort: check the player roster's last-known inventory.
      // Without a sync inventory snoop, this trigger fires when bot can
      // see the item dropped/held by the player. For v0, fire on
      // 'playerCollect' or 'itemDrop' events.
      if (!event) return false;
      if (event.kind === 'player_collected' && event.player === trigger.player
          && event.item === trigger.item) return true;
      return false;
    }

    case 'timer': {
      // trigger.delay_ms after quest step entered.
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
      return await ACTIONS.build_schematic({ name, x, y, z });
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
      return await ACTIONS.build_tower({ x, y, z, height: action.height || 5, material: action.material || 'oak_planks' });
    }
    case 'place_near_player': {
      const player = lookupPlayer(action.player);
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

  // Filter quests this bot owns (by `owner` field; default = both bots).
  const myQuests = quests.filter((q) => !q.owner || q.owner === botName);
  for (const q of myQuests) {
    if (!botState.has(q.name)) {
      botState.set(q.name, { currentStep: 0, status: 'active', step_entered_at: Date.now() });
    }
  }
  log && log(`[quests] ${botName} watching ${myQuests.length} quests: ${myQuests.map((q) => q.name).join(', ')}`);

  async function advance(q, eventCtx) {
    const qs = botState.get(q.name);
    if (!qs || qs.status !== 'active') return;
    const step = q.steps[qs.currentStep];
    if (!step) {
      qs.status = 'done';
      log && log(`[quests] ${q.name} finished`);
      return;
    }
    const ctx = { bot, event: eventCtx, now: Date.now(), qstate: qs, last_chatter: eventCtx?.player };
    if (!evalTrigger(step.trigger, ctx)) return;
    log && log(`[quests] ${q.name} step ${qs.currentStep} fired: ${step.trigger.kind}`);
    for (const action of (step.actions || [])) {
      try { await executeAction(ACTIONS, bot, action, ctx); } catch (e) { log && log(`[quests] action error: ${e.message}`); }
    }
    qs.currentStep++;
    qs.step_entered_at = Date.now();
  }

  // Wire events.
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
    const itemName = collected?.metadata?.find?.((m) => m.type === 7)?.value?.itemId; // best-effort
    for (const q of myQuests) await advance(q, { kind: 'player_collected', player: collector.username, item: itemName });
  };

  bot.on('playerJoined', onJoin);
  bot.on('chat', onChat);
  bot.on('playerCollect', onCollect);

  // Poll loop for position + timer triggers (every 1s).
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
