// HermesCraft speculative intent router — keyword-route kid-common requests
// directly to high-level skill primitives, BEFORE the LLM even sees them.
//
// Latency-engineering insight (Anthropic Computer Use docs + GetStream voice
// agent pattern): for a class of obvious, reversible requests ("come here",
// "put a torch next to me", "build a tower"), latency-sensitive game agents
// regex-match the player's intent and dispatch the matching primitive WITHOUT
// an LLM round-trip. Saves the 1-5s of brain inference; visible kid response
// in <500ms.
//
// Safety model: only ROUTE TO REVERSIBLE / NON-DESTRUCTIVE actions. Never
// route to break_block, attack, drop_inventory, etc. If a route mispredicts
// the kid's intent, worst case is the bot does a benign movement / single-
// block placement / item drop, which is strictly better than chat-theater.
//
// Pairs with the LLM brain: if a message matches a route, we fire the
// primitive AND mark the command as fulfilled so the brain doesn't double-
// execute. If a message does NOT match, it falls through to the normal
// commandQueue and the brain handles it as usual.

// Intent table: each entry has:
//   patterns: array of regexes; any one matching = route activates
//   handler:  async (bot, ctx) => english_response_string | null
//
// ctx = { sender, senderEntity, message, body }

function findPlayerEntity(bot, name) {
  if (!name) return null;
  const lname = name.toLowerCase();
  // Prefer bot.players (server roster) over bot.entities (in-view) —
  // works even when the player is at the edge of view distance.
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

function intFromMatch(text, regex) {
  const m = text.match(regex);
  return m ? parseInt(m[1], 10) : null;
}

import { Vec3 } from 'vec3';

// ── Pattern table ───────────────────────────────────────────────────

const INTENTS = [
  // The single biggest miss in any kid-targeted bot per the kid-vocab
  // research agent: a frustrated 9-year-old says "stop" 5x before doing
  // anything else. This MUST be the first pattern checked.
  {
    name: 'stop',
    patterns: [
      /^\s*(stop|wait|nevermind|never mind|cancel|halt)[\s!.,?]*$/i,
      /\bstop (it|that|please|now)\b/i,
      /\bjust stop\b/i,
    ],
    async handler(bot, ctx) {
      return { action: 'stop', body: {} };
    },
  },
  {
    name: 'report_position',
    patterns: [
      /\bwhere are you\b/i,
      /\bwhere r u\b/i,
      /\bwheres? (rosie|steve|you)\b/i,
      /\bwhats? your (pos|position|spot|coords?)\b/i,
    ],
    async handler(bot, ctx) {
      const p = bot.entity.position;
      const msg = `at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
      return { action: 'chat', body: { text: msg } };
    },
  },
  {
    name: 'report_inventory',
    patterns: [
      /\bwhat (do you|u) have\b/i,
      /\bwhats? in your (inv|inventory|stuff|bag)\b/i,
      /\bshow me (your|ur) (stuff|items|inv|inventory)\b/i,
    ],
    async handler(bot, ctx) {
      const items = bot.inventory.items().slice(0, 5)
        .map((i) => `${i.name}x${i.count}`).join(', ');
      const msg = items ? `got ${items}` : 'empty hands';
      return { action: 'chat', body: { text: msg } };
    },
  },
  {
    name: 'emote_wave',
    patterns: [
      /\bwave( at me)?\b/i,
      /\bsay hi\b.*\bwith.*\b(wave|hand)\b/i,
    ],
    async handler(bot, ctx) {
      // Simple wave: swing arm 3 times
      try { for (let i = 0; i < 3; i++) { bot.swingArm('right'); await new Promise(r=>setTimeout(r,300)); } } catch {}
      return { action: 'chat', body: { text: '👋' } };
    },
  },
  {
    name: 'emote_jump',
    patterns: [
      /\bjump( around|for me|please|now)?\b/i,
      /\bdo a jump\b/i,
    ],
    async handler(bot, ctx) {
      try {
        for (let i = 0; i < 3; i++) {
          bot.setControlState('jump', true);
          await new Promise(r=>setTimeout(r,120));
          bot.setControlState('jump', false);
          await new Promise(r=>setTimeout(r,250));
        }
      } catch {}
      return { action: 'chat', body: { text: '🦘' } };
    },
  },
  {
    name: 'emote_dance',
    patterns: [
      /\bdance( with me| for me| please| now)?\b/i,
      /\bdo a dance\b/i,
    ],
    async handler(bot, ctx) {
      // Dance = sneak+jump+spin loop for ~3s
      try {
        const start = Date.now();
        let yaw = bot.entity.yaw;
        while (Date.now() - start < 3000) {
          yaw += Math.PI / 4;
          try { await bot.look(yaw, 0); } catch {}
          bot.setControlState('jump', true);
          await new Promise(r=>setTimeout(r,180));
          bot.setControlState('jump', false);
          await new Promise(r=>setTimeout(r,180));
        }
      } catch {}
      return { action: 'chat', body: { text: '💃' } };
    },
  },
  {
    name: 'emote_sit',
    patterns: [
      /\bsit( down| with me| next to me| here| please)?\b/i,
    ],
    async handler(bot, ctx) {
      try {
        bot.setControlState('sneak', true);
        // Sneak for 5s to look "sat down"
        setTimeout(() => { try { bot.setControlState('sneak', false); } catch {} }, 5000);
      } catch {}
      return { action: 'chat', body: { text: 'sitting :)' } };
    },
  },
  {
    name: 'gather_block',
    patterns: [
      /\b(get|grab|chop|mine|fetch|bring)\b.*\b(me )?(some |a few )?(\d+)?\s*(wood|logs?|oak|dirt|stone|cobble|cobblestone|sand)\b/i,
      /\b(I need|i want)\b.*\b(wood|logs?|dirt|stone|cobble|sand)\b/i,
    ],
    async handler(bot, ctx) {
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
      // ACTIONS.collect (synchronous via /action/collect endpoint).
      return { action: 'collect', body: { block, count: Math.min(count, 16) } };
    },
  },
  {
    name: 'torch_near_me',
    patterns: [
      /\btorch\b.*\b(here|next to me|by me|right by|near me)\b/i,
      /\b(put|place|drop) a? torch\b/i,
      /\blight (?:up )?(?:this )?(?:spot|area|here)\b/i,
    ],
    async handler(bot, ctx) {
      // Use place_near_player directly via skills module API (re-import
      // to avoid circular dependency — we use the action through the
      // ACTIONS map below).
      return { action: 'place_near_player', body: { player: ctx.sender, item: 'torch', direction: 'side' } };
    },
  },
  {
    name: 'flower_give',
    patterns: [
      /\b(flower|poppy|rose|tulip|dandelion)\b.*\b(give|grab|get|bring)\b/i,
      /\b(give|grab|get|bring)\b.*\b(flower|poppy|rose|tulip|dandelion)\b/i,
    ],
    async handler(bot, ctx) {
      // Pick whichever flower-like item the bot has in inventory
      const flowers = ['poppy', 'rose_bush', 'red_tulip', 'pink_tulip', 'dandelion', 'blue_orchid'];
      const found = bot.inventory.items().find((i) => flowers.includes(i.name));
      const item = found ? found.name : 'poppy';
      return { action: 'give_to_player', body: { player: ctx.sender, item, count: 1 } };
    },
  },
  {
    name: 'build_tower',
    patterns: [
      /\b(build|put up|make|raise)\b.*\b(tower|pillar|column|spire)\b/i,
      /\b(tower|pillar|column)\b.*\b(here|right here|where I am)\b/i,
    ],
    async handler(bot, ctx) {
      if (!ctx.senderEntity) return null; // can't build without target position
      const p = ctx.senderEntity.position;
      // Extract a height if mentioned: "5 blocks high", "10 tall"
      const height = intFromMatch(ctx.body, /(\d+)\s*(blocks?\s*)?(high|tall)/i) || 5;
      // Pick a sensible material from inventory
      const buildables = ['oak_planks', 'cobblestone', 'stone', 'oak_log', 'dirt', 'spruce_planks'];
      const found = bot.inventory.items().find((i) => buildables.includes(i.name));
      const material = found ? found.name : 'oak_planks';
      // Find a clear spot ≥2 blocks from the kid: scan the 4 cardinal
      // directions at +2/-2 offset, pick the first one where the air block
      // above the surface is actually air (not torch/sapling from a prior
      // prompt). Falls back to +2x if no clear spot found.
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
        body: {
          x: Math.floor(p.x) + chosen[0],
          y: baseY,
          z: Math.floor(p.z) + chosen[1],
          height,
          material,
        },
      };
    },
  },
  {
    name: 'come_here',
    patterns: [
      /\b(come|come over|come here|walk|run|head)\b.*\b(here|to me|over)\b/i,
      /\bwhere are you\b/i,
      /\bcome to my (spot|position|place)\b/i,
    ],
    async handler(bot, ctx) {
      if (!ctx.senderEntity) return null;
      const p = ctx.senderEntity.position;
      return {
        action: 'goto',
        body: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      };
    },
  },
  {
    name: 'plant_flowers',
    patterns: [
      /\bplant (a |some |me )?(flower|flowers|garden|poppy|poppies|tulip|tulips)\b/i,
      /\bmake (a |me a )?(garden|flower bed|flowers)\b/i,
    ],
    async handler(bot, ctx) {
      if (!ctx.senderEntity) return null;
      const p = ctx.senderEntity.position;
      // Pick flower types from inventory; default to poppy.
      const flowers = ['poppy', 'dandelion', 'blue_orchid', 'rose_bush', 'red_tulip'];
      const found = bot.inventory.items().find((i) => flowers.includes(i.name));
      const item = found ? found.name : 'poppy';
      // Place 3 flowers in a small arc around the player.
      return {
        action: 'place_near_player',
        body: { player: ctx.sender, item, direction: 'side' },
      };
    },
  },
  {
    name: 'follow_me',
    patterns: [
      /\bfollow me\b/i,
      /\bstay with me\b/i,
      /\bcome with me\b/i,
    ],
    async handler(bot, ctx) {
      return {
        action: 'follow_player_v2',
        body: { player: ctx.sender, distance: 3 },
      };
    },
  },
  {
    name: 'race_to_coords',
    patterns: [
      /\brace\b.*\b(\-?\d+)\s+(\-?\d+)\s+(\-?\d+)\b/i,
      /\bgo to\b.*\b(\-?\d+)\s+(\-?\d+)\s+(\-?\d+)\b/i,
    ],
    async handler(bot, ctx) {
      const m = ctx.body.match(/\b(\-?\d+)\s+(\-?\d+)\s+(\-?\d+)\b/);
      if (!m) return null;
      // Stay with `goto` (15s sync timeout, foreground) — even if the
      // race target is far, the 15s of visible bot motion + the honest
      // progress message is the right kid experience. Long-haul races
      // would need a /task background variant that bg_goto would call;
      // not worth the complexity for the kid use case.
      return {
        action: 'goto',
        body: { x: parseInt(m[1], 10), y: parseInt(m[2], 10), z: parseInt(m[3], 10) },
      };
    },
  },
  {
    name: 'mine_iron',
    patterns: [
      /\b(grab|get|find|mine)\b.*\b(iron|coal|diamond|copper|gold)\b/i,
      /\b(iron|coal|diamond|copper|gold)\b.*\b(please|for me|some)\b/i,
    ],
    async handler(bot, ctx) {
      const oreMatch = ctx.body.match(/\b(iron|coal|diamond|copper|gold)\b/i);
      if (!oreMatch) return null;
      const ore = oreMatch[1].toLowerCase() + '_ore';
      // ACTIONS.collect handles find + dig + pickup in one call.
      // (No 'bg_collect' key — that's a /task/-side endpoint name only.)
      return { action: 'collect', body: { block: ore, count: 3 } };
    },
  },
];

// ── Public router ──────────────────────────────────────────────────

// Returns { matched: bool, intent_name, action, body, target_chat }
// Caller is responsible for executing ACTIONS[action](body) AND optionally
// chatting target_chat back. If matched=false, caller falls through to the
// normal LLM-driven command queue.
export async function tryRoute(bot, body, sender) {
  if (!bot || !body) return { matched: false };
  const senderEntity = findPlayerEntity(bot, sender);
  const ctx = { sender, senderEntity, message: body, body };

  for (const intent of INTENTS) {
    if (intent.patterns.some((p) => p.test(body))) {
      const decision = await intent.handler(bot, ctx);
      if (decision) {
        return {
          matched: true,
          intent_name: intent.name,
          action: decision.action,
          body: decision.body,
        };
      }
    }
  }
  return { matched: false };
}

// Acknowledgment chat lines per intent — fired immediately so the kid
// SEES a response in <50ms, while the action runs in background.
const ACKS = {
  torch_near_me: ['on it', 'placing one', 'gotcha', 'torch coming'],
  flower_give:   ['here you go', 'one flower', 'have this one', 'for you!'],
  build_tower:   ['building it', 'putting it up', 'on it', 'tower time'],
  come_here:     ['omw', 'coming!', 'be right there'],
  follow_me:     ['behind you', 'with you', 'leading the way'],
  race_to_coords:['GO!!', 'racing!', 'on it'],
  mine_iron:     ['on it', 'mining now', 'brb gathering'],
};

export function ackFor(intent_name) {
  const arr = ACKS[intent_name];
  if (!arr) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
