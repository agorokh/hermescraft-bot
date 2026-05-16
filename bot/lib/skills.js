// HermesCraft high-level skill primitives — Mindcraft-shaped intent verbs.
//
// Design contract (lifted from Mindcraft's actions.js + skills.js):
//   1. Each skill takes (bot, body) and returns { result: "english sentence" }.
//      The English string goes back into the next LLM turn as system context —
//      designed to be READ BY CLAUDE, not by code. That's why we don't return
//      structured JSON; we return narrative.
//   2. Skills loop INTERNALLY until done or interrupted. The LLM emits ONE
//      tool call ("build_tower"); we emit N Mineflayer calls. This is the
//      bandwidth fix for the chat-promise-without-tool-call failure mode.
//   3. Cancel is via `bot.interrupt_code` boolean polled at 500ms intervals
//      (Mindcraft pattern). Set it from /action/stop.
//   4. Failures don't retry indefinitely — return a descriptive English
//      sentence so the LLM can replan. "Couldn't reach -180 65 70 — pathfinder
//      blocked. Try a closer coord." beats { ok: false, code: "ETIMEDOUT" }.
//
// Skills implemented (2026-05-16 deep night — square-zero architecture rebuild):
//   - place_near_player(player, item, [direction]) — solves run #6 torch failure
//   - give_to_player(player, item, count) — playerCollect handshake
//   - build_tower(x, y, z, height, material) — jump-place loop
//   - light_area(cx, cy, cz, radius) — torch grid
//   - follow_player_v2(player, [distance]) — interrupt_code-aware follow

import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';

// ── helpers ──────────────────────────────────────────────────────────

function findPlayerEntity(bot, name) {
  // Mindcraft pattern: bot.players is the server roster (populated on
  // playerJoined); bot.players[name].entity is the live entity if the
  // player is loaded in our view. Case-insensitive name match per
  // Floodgate's leading-dot Bedrock-prefix convention.
  if (!name) return null;
  const lname = name.toLowerCase();
  for (const [n, p] of Object.entries(bot.players || {})) {
    if (n === bot.username) continue;
    if (n.toLowerCase() === lname || n.toLowerCase().replace(/^\./, '') === lname) {
      if (p.entity) return p.entity;
    }
  }
  // Fallback: scan bot.entities for visible player entities.
  return Object.values(bot.entities || {}).find((e) => {
    if (e === bot.entity) return false;
    if (e.type !== 'player') return false;
    const en = (e.username || '').toLowerCase();
    return en === lname || en.replace(/^\./, '') === lname;
  }) || null;
}

function findInventoryItem(bot, itemName) {
  const ln = itemName.toLowerCase();
  return bot.inventory.items().find((i) => i.name === ln || i.displayName?.toLowerCase() === ln);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pick an adjacent solid block we can place against. Mindcraft's 6-face scan.
function findBuildOffBlock(bot, x, y, z) {
  const faces = [
    { dx: 0, dy: -1, dz: 0, faceVec: new Vec3(0, 1, 0) },   // below us
    { dx: 1, dy: 0,  dz: 0, faceVec: new Vec3(-1, 0, 0) },
    { dx: -1, dy: 0, dz: 0, faceVec: new Vec3(1, 0, 0) },
    { dx: 0, dy: 0,  dz: 1, faceVec: new Vec3(0, 0, -1) },
    { dx: 0, dy: 0,  dz: -1, faceVec: new Vec3(0, 0, 1) },
    { dx: 0, dy: 1,  dz: 0, faceVec: new Vec3(0, -1, 0) },
  ];
  for (const f of faces) {
    const pos = new Vec3(x + f.dx, y + f.dy, z + f.dz);
    const block = bot.blockAt(pos);
    if (block && block.boundingBox === 'block' && block.name !== 'air') {
      return { block, faceVec: f.faceVec };
    }
  }
  return null;
}

// Blocks that vanilla placement replaces silently — same set Minecraft uses.
// If we try to place at a coord occupied by one of these, the place call
// just works (the existing block becomes the drop).
const REPLACEABLE_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'seagrass', 'tall_seagrass',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'snow', 'vine', 'glow_lichen', 'hanging_roots',
]);

// Core place primitive. Returns true on success.
async function placeOne(bot, itemName, x, y, z) {
  const targetPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  // Already occupied? (treat plant/decoration blocks as replaceable per vanilla)
  const existing = bot.blockAt(targetPos);
  if (existing && existing.name === itemName) {
    return { ok: true, reason: `already placed at ${targetPos.x},${targetPos.y},${targetPos.z}` };
  }
  if (existing && !REPLACEABLE_BLOCKS.has(existing.name) && (existing.boundingBox === 'block')) {
    return { ok: false, reason: `${existing.name} already at ${targetPos.x},${targetPos.y},${targetPos.z}` };
  }
  // If a replaceable plant is in the way, break it first so the place call
  // doesn't no-op or fail (placeBlock on tall_grass works in vanilla, but
  // Mineflayer is inconsistent across versions; explicit dig is safest).
  if (existing && REPLACEABLE_BLOCKS.has(existing.name) && existing.name !== 'air' && existing.name !== 'cave_air' && existing.name !== 'void_air') {
    try { await bot.dig(existing); } catch (e) { /* swallow */ }
    await sleep(120);
  }
  const item = findInventoryItem(bot, itemName);
  if (!item) return { ok: false, reason: `no ${itemName} in inventory` };

  const buildOff = findBuildOffBlock(bot, targetPos.x, targetPos.y, targetPos.z);
  if (!buildOff) return { ok: false, reason: `no adjacent block to place against at ${targetPos.x},${targetPos.y},${targetPos.z}` };

  try {
    await bot.equip(item, 'hand');
    await bot.lookAt(buildOff.block.position.offset(0.5, 0.5, 0.5));
    await bot.placeBlock(buildOff.block, buildOff.faceVec);
    await sleep(200); // settle (Mindcraft uses 200ms)
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── place_near_player(player, item, [direction]) ────────────────────
//
// Solves run #6 prompt 5 directly: "rosie put a torch next to me to light up
// this spot". The brain emits ONE tool call; we look up the player's actual
// position via entity state, pick an adjacent open cell, and place.

async function place_near_player(bot, { player, item, direction = 'side' }) {
  if (!player || !item) {
    return { result: `place_near_player needs player + item` };
  }
  const entity = findPlayerEntity(bot, player);
  if (!entity) {
    return { result: `Can't see ${player} nearby — they may be too far away.` };
  }
  const p = entity.position;
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);

  // Pick the offset: side = +x or +z, above = +y, below = -y.
  let candidates;
  if (direction === 'above') {
    candidates = [[0, 2, 0], [0, 3, 0]];
  } else if (direction === 'below') {
    candidates = [[0, -1, 0]];
  } else {
    // side: try N, E, S, W (skipping blocks the player overlaps)
    candidates = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
  }

  // Move closer if too far away so place range is reachable.
  const myPos = bot.entity.position;
  const dist = Math.sqrt((myPos.x - p.x) ** 2 + (myPos.z - p.z) ** 2);
  if (dist > 4) {
    try {
      const goalCloser = new goals.GoalNear(px, py, pz, 3);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000));
      await Promise.race([bot.pathfinder.goto(goalCloser), timeout]);
    } catch (e) {
      // Continue — we may still be in range to reach
    }
  }

  for (const [dx, dy, dz] of candidates) {
    if (bot.interrupt_code) return { result: `place_near_player interrupted` };
    const tx = px + dx, ty = py + dy, tz = pz + dz;
    const r = await placeOne(bot, item, tx, ty, tz);
    if (r.ok) {
      return { result: `Placed ${item} at ${tx},${ty},${tz} (next to ${player}).` };
    }
  }
  return { result: `Couldn't place ${item} near ${player} — every adjacent spot was blocked or no ${item} in inventory.` };
}

// ── give_to_player(player, item, count) ──────────────────────────────
//
// Walk to player, drop item, wait up to 3s for playerCollect event to
// confirm pickup. Returns English description.

async function give_to_player(bot, { player, item, count = 1 }) {
  if (!player || !item) return { result: `give_to_player needs player + item` };
  const entity = findPlayerEntity(bot, player);
  if (!entity) return { result: `Can't see ${player} nearby.` };
  const stack = findInventoryItem(bot, item);
  if (!stack) return { result: `No ${item} in my inventory to give.` };

  // Pathfind close.
  const p = entity.position;
  try {
    const goal = new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 2);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000));
    await Promise.race([bot.pathfinder.goto(goal), timeout]);
  } catch (e) {
    // Continue — toss anyway.
  }
  if (bot.interrupt_code) return { result: `give_to_player interrupted` };

  await bot.lookAt(p);
  try {
    await bot.toss(stack.type, null, Math.min(count, stack.count));
  } catch (e) {
    return { result: `Couldn't toss ${item}: ${e.message}` };
  }

  // 3s wait for collect event (Mindcraft pattern).
  let received = false;
  const onCollect = (collector, _collected) => {
    if (collector && (collector.username || collector.name || '').toLowerCase() === player.toLowerCase()) {
      received = true;
    }
  };
  bot.on('playerCollect', onCollect);
  const start = Date.now();
  while (Date.now() - start < 3000 && !received) {
    if (bot.interrupt_code) break;
    await sleep(200);
  }
  bot.removeListener('playerCollect', onCollect);

  return {
    result: received
      ? `Gave ${count} ${item} to ${player} (they picked it up).`
      : `Tossed ${count} ${item} toward ${player} — couldn't confirm pickup within 3s.`,
  };
}

// ── build_tower(x, y, z, height, material) ───────────────────────────
//
// N-tall pillar at (x, y, z). Each iteration places one block at the next
// Y level. The bot pillars up with `setControlState('jump')` to follow the
// growing pillar. Returns "Built N-tall <material> tower at X,Y,Z (placed
// k/N blocks)."

async function build_tower(bot, { x, y, z, height = 5, material = 'oak_planks' }) {
  if (x == null || y == null || z == null) return { result: `build_tower needs x, y, z` };
  height = Math.max(1, Math.min(20, Math.floor(height)));

  // Path to a spot 2 blocks away from the build column so we don't end up
  // standing on the column ourselves (which would block placeBlock at the
  // first y level).
  const baseX = Math.floor(x), baseY = Math.floor(y), baseZ = Math.floor(z);
  try {
    const goal = new goals.GoalNear(baseX, baseY, baseZ, 2);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
    await Promise.race([bot.pathfinder.goto(goal), timeout]);
  } catch (e) {
    // Continue — might still be close enough.
  }
  if (bot.interrupt_code) return { result: `build_tower interrupted` };

  // If we ended up standing on the column itself, step one block aside.
  const myPos = bot.entity.position;
  if (Math.abs(myPos.x - baseX) < 0.6 && Math.abs(myPos.z - baseZ) < 0.6) {
    try {
      const aside = new goals.GoalNear(baseX + 2, baseY, baseZ, 1);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
      await Promise.race([bot.pathfinder.goto(aside), timeout]);
    } catch (e) {}
  }

  // Find the first non-blocked Y level to start from. If our requested
  // baseY has an existing block (oak_planks from an old test, glass, etc.),
  // step up until we hit air.
  let startY = baseY;
  for (let dy = 0; dy < 6; dy++) {
    const candY = baseY + dy;
    const probe = bot.blockAt(new Vec3(baseX, candY, baseZ));
    if (!probe || probe.name === 'air' || REPLACEABLE_BLOCKS.has(probe.name)) {
      startY = candY;
      break;
    }
  }

  let placed = 0;
  for (let i = 0; i < height; i++) {
    if (bot.interrupt_code) break;
    // Move on top of the previous block by jumping (only after the first).
    if (i > 0) {
      bot.setControlState('jump', true);
      await sleep(150);
      bot.setControlState('jump', false);
      await sleep(150);
    }
    const r = await placeOne(bot, material, baseX, startY + i, baseZ);
    if (r.ok) placed++;
    // If first placement failed, abort — we can't pillar up from nothing.
    if (i === 0 && !r.ok) break;
  }

  return {
    result: placed === height
      ? `Built ${height}-tall ${material} tower at ${baseX},${startY},${baseZ}.`
      : (placed > 0
          ? `Built ${placed}/${height} ${material} blocks of the tower at ${baseX},${startY},${baseZ}. (Pillar-up got stuck after block ${placed}.)`
          : `Couldn't start the tower at ${baseX},${startY},${baseZ} — every Y from ${baseY} to ${baseY+5} was blocked or unreachable. Try a different spot.`),
  };
}

// ── light_area(cx, cy, cz, radius) ───────────────────────────────────
//
// Place a sparse grid of torches in a radius around (cx, cy, cz). Spacing
// is 6 blocks (vanilla torch effective light-suppression range is ~7).

async function light_area(bot, { cx, cy, cz, radius = 6 }) {
  if (cx == null || cy == null || cz == null) return { result: `light_area needs cx, cy, cz` };
  radius = Math.max(2, Math.min(16, Math.floor(radius)));
  const stride = 6;
  const startX = Math.floor(cx) - radius;
  const endX = Math.floor(cx) + radius;
  const startZ = Math.floor(cz) - radius;
  const endZ = Math.floor(cz) + radius;
  let placed = 0;
  for (let tx = startX; tx <= endX; tx += stride) {
    for (let tz = startZ; tz <= endZ; tz += stride) {
      if (bot.interrupt_code) break;
      const r = await placeOne(bot, 'torch', tx, Math.floor(cy), tz);
      if (r.ok) placed++;
    }
    if (bot.interrupt_code) break;
  }
  return {
    result: placed > 0
      ? `Lit the area around ${cx},${cy},${cz} with ${placed} torches.`
      : `Couldn't place any torches — area may already be lit or I don't have torches.`,
  };
}

// ── follow_player_v2(player, [distance]) ─────────────────────────────
//
// Sustained companion follow using GoalFollow + interrupt_code polling.
// Returns immediately — body keeps following until interrupted. Caller
// should use /action/stop to end.

async function follow_player_v2(bot, { player, distance = 3 }) {
  if (!player) return { result: `follow_player_v2 needs player` };
  const entity = findPlayerEntity(bot, player);
  if (!entity) return { result: `Can't see ${player} to follow.` };
  bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);
  return { result: `Following ${player} (will stay within ${distance} blocks). Use mc stop to stop.` };
}

// ── Public registration helper ──────────────────────────────────────

export function registerHighLevelSkills(ACTIONS, ensureBot) {
  ACTIONS.place_near_player = async (body) => place_near_player(ensureBot(), body);
  ACTIONS.give_to_player    = async (body) => give_to_player(ensureBot(), body);
  ACTIONS.build_tower       = async (body) => build_tower(ensureBot(), body);
  ACTIONS.light_area        = async (body) => light_area(ensureBot(), body);
  ACTIONS.follow_player_v2  = async (body) => follow_player_v2(ensureBot(), body);
  return ACTIONS;
}
