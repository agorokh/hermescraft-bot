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
// allowReachRecover: if true, when placeBlock fails due to reach distance,
// move the bot closer and retry once. Skill loops set this to true; raw
// callers may set false to avoid the pathfind overhead.
async function placeOne(bot, itemName, x, y, z, allowReachRecover = true) {
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

  // If bot is too far for reach, pathfind closer once before placing.
  // Mineflayer's place-block reach is ~5 blocks from eye height.
  if (allowReachRecover) {
    const myPos = bot.entity.position;
    const eye = new Vec3(myPos.x, myPos.y + 1.62, myPos.z);
    const dist = Math.sqrt(
      (eye.x - targetPos.x - 0.5) ** 2 +
      (eye.y - targetPos.y - 0.5) ** 2 +
      (eye.z - targetPos.z - 0.5) ** 2
    );
    if (dist > 4.5) {
      try {
        const goal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2);
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
        await Promise.race([bot.pathfinder.goto(goal), timeout]);
      } catch (e) { /* continue and try place anyway */ }
    }
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

// build_tower — pillar-up implementation (Minecraft classic technique).
//
// The kid's request: "build a 5-tall tower right here".
// Mechanic: bot pathfinds onto the column base, then for each layer:
//   1. Look straight down (so placeBlock targets the block-below).
//   2. Jump — bot's feet leave the floor.
//   3. While airborne, place a block at feet level (referenced from the
//      block-below; faceVec=(0,1,0) means "the face above the ref").
//   4. Land on the new block (one Y higher than before).
//   5. Repeat.
//
// This is the standard speedrun "block-up" — Mineflayer handles it via
// placeBlock when the ref is exactly below feet.

async function build_tower(bot, { x, y, z, height = 5, material = 'oak_planks' }) {
  if (x == null || y == null || z == null) return { result: `build_tower needs x, y, z` };
  height = Math.max(1, Math.min(20, Math.floor(height)));

  const baseX = Math.floor(x), baseY = Math.floor(y), baseZ = Math.floor(z);

  // Pathfind to STAND ON the column position. GoalNear with range 0 forces
  // exact tile occupancy. The bot's feet should end up at (baseX, baseY,
  // baseZ) standing on the ground block at (baseX, baseY-1, baseZ).
  try {
    const goal = new goals.GoalNear(baseX, baseY, baseZ, 0);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
    await Promise.race([bot.pathfinder.goto(goal), timeout]);
  } catch (e) { /* continue — close-enough is fine */ }
  if (bot.interrupt_code) return { result: `build_tower interrupted` };

  // Verify we have material.
  const matItem = findInventoryItem(bot, material);
  if (!matItem) return { result: `No ${material} in my inventory.` };
  try { await bot.equip(matItem, 'hand'); } catch (e) {
    return { result: `Couldn't equip ${material}: ${e.message}` };
  }

  let placed = 0;
  for (let i = 0; i < height; i++) {
    if (bot.interrupt_code) break;

    // Find the block directly below feet — that's our reference for
    // placing the new block at feet level.
    const feetY = Math.floor(bot.entity.position.y);
    const refPos = new Vec3(Math.floor(bot.entity.position.x), feetY - 1, Math.floor(bot.entity.position.z));
    const refBlock = bot.blockAt(refPos);
    if (!refBlock || refBlock.boundingBox !== 'block') {
      // We're floating — can't place. Bail.
      break;
    }

    // Look straight down.
    try { await bot.look(bot.entity.yaw, Math.PI / 2, true); } catch (e) {}
    await sleep(80);

    // Jump + place at feet (the cell above ref). Apex timing matters:
    // - 0-90ms after jump-start: bot still rising fast; placeBlock too early may collide with bot's hitbox.
    // - 90-200ms: at/near apex (~1.25 block above floor). Block placement fits in the cell-just-vacated.
    // - 200ms+: starting to fall; risk of placing AT bot's feet which won't fit.
    bot.setControlState('jump', true);
    await sleep(180);  // peak of the jump
    let ok = false;
    try {
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      ok = true;
    } catch (err) {
      // Sometimes the apex window is wrong; retry with one re-jump cycle.
      bot.setControlState('jump', false);
      await sleep(250);  // land
      bot.setControlState('jump', true);
      await sleep(180);
      try {
        await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        ok = true;
      } catch (err2) {}
    }
    bot.setControlState('jump', false);
    if (ok) placed++;
    await sleep(450);  // wait for landing on the new block (longer = safer)
  }

  return {
    result: placed === height
      ? `Built ${height}-tall ${material} tower at ${baseX},${baseY},${baseZ}.`
      : (placed > 0
          ? `Built ${placed}/${height} ${material} blocks of the tower at ${baseX},${baseY},${baseZ}.`
          : `Couldn't start the tower at ${baseX},${baseY},${baseZ} — pillar-up failed (likely no solid ground or bot can't reach position).`),
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

// ── build_schematic(name, x, y, z) ──────────────────────────────────
//
// Loads a JSON template from vendor/hermescraft/bot/schematics/<name>.json
// and places each block at (origin + offset). This is the foundation for
// the operator's storytelling/quest/village vision — same contract a
// real .schem loader would use, just with a JSON manifest backend until
// we curate community schematics (mineflayer-schem is installed and ready
// for that swap).

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMATICS_DIR = join(__dirname, '..', 'schematics');

let _schem_index_cache = null;
async function loadSchematicIndex() {
  if (_schem_index_cache) return _schem_index_cache;
  const raw = await readFile(join(SCHEMATICS_DIR, 'INDEX.json'), 'utf8');
  _schem_index_cache = JSON.parse(raw);
  return _schem_index_cache;
}

async function loadSchematic(name) {
  const idx = await loadSchematicIndex();
  const entry = idx.schematics?.[name];
  if (!entry) {
    const available = Object.keys(idx.schematics || {}).join(', ');
    return { error: `Unknown schematic "${name}". Available: ${available}` };
  }
  const raw = await readFile(join(SCHEMATICS_DIR, entry.file), 'utf8');
  return { entry, data: JSON.parse(raw) };
}

// Detect whether the bot has op-level permission for /setblock.  Council
// review (Mistral, 2026-05-16) flagged a critical bug in the
// listen-for-server-message-only version: a non-op bot on a server with
// `sendCommandFeedback=false` (Paper default for some configs) silently
// fails every /setblock, then the message-listener times out and assumes
// op — producing the worst possible outcome, an apparent "88/88 blocks
// placed" with nothing in the world.  We now PROBE-AND-VERIFY: place a
// known sentinel block in a cell the bot's worldview already has loaded
// (its own position +1Y), wait briefly, then read the block back.  If
// the block matches the sentinel, /setblock works; otherwise fall back
// to physical placement.  Clamps Y to <= 319 (vanilla 1.21 build limit)
// to avoid the probe firing above world height.
async function detectSetblockAuth(bot, _x, _y, _z) {
  // Probe at the bot's current position +1Y (a cell guaranteed to be in a
  // loaded chunk).  Use a sentinel block we can read back unambiguously
  // and that's cheap to roll back: white_wool (visible distinct, every
  // server has it in the registry).
  const sentinel = 'white_wool';
  const myPos = bot.entity?.position;
  if (!myPos) return false; // no bot body, no point trying /setblock
  const px = Math.floor(myPos.x);
  const pz = Math.floor(myPos.z);
  let py = Math.floor(myPos.y) + 3; // overhead so we don't suffocate
  if (py > 319) py = 319; // vanilla 1.21 build limit
  if (py < -64) py = -64; // floor for completeness

  // Capture what's currently there so we restore it after probing.
  const before = bot.blockAt(new Vec3(px, py, pz));
  const beforeName = before?.name || 'air';

  try { bot.chat(`/setblock ${px} ${py} ${pz} ${sentinel}`); } catch (e) {}
  await sleep(250); // wait for the chunk update to round-trip

  const after = bot.blockAt(new Vec3(px, py, pz));
  const afterName = after?.name || 'air';
  const ok = afterName === sentinel;

  // Restore the previous block so the probe is invisible to the player.
  // Best-effort — if op was lost between probe and restore, we leave the
  // sentinel and report `false` honestly.
  if (ok) {
    try { bot.chat(`/setblock ${px} ${py} ${pz} ${beforeName}`); } catch (e) {}
  }
  return ok;
}

async function build_schematic(bot, { name, x, y, z }) {
  if (!name) return { result: `build_schematic needs a schematic name` };
  if (x == null || y == null || z == null) return { result: `build_schematic needs x, y, z origin` };

  let loaded;
  try {
    loaded = await loadSchematic(name);
  } catch (e) {
    return { result: `Couldn't load schematic ${name}: ${e.message}` };
  }
  if (loaded.error) return { result: loaded.error };
  const { entry, data } = loaded;
  const blocks = data.blocks || [];
  if (blocks.length === 0) return { result: `Schematic ${name} is empty.` };

  const baseX = Math.floor(x), baseY = Math.floor(y), baseZ = Math.floor(z);
  const [fw, fl] = entry.footprint || [data.footprint?.[0] || 5, data.footprint?.[1] || 5];
  const centerX = baseX + Math.floor(fw / 2);
  const centerZ = baseZ + Math.floor(fl / 2);

  // Cheat-mode / op path: vanilla `/setblock x y z block` per cell, instant
  // and aerial-safe. This is the same pattern Mindcraft's `placeBlock` uses
  // in cheat mode (kolbytn/mindcraft `src/agent/library/skills.js`). Mineflayer's
  // physical `placeBlock` requires an adjacent solid block to place against,
  // so floating cells (treehouse floor, walls, tower roof) cause the
  // "Cannot read properties of undefined (reading 'type')" unhandled rejection.
  // Detect once, then route every cell through chat commands until proven
  // otherwise. Companion bots in this repo are always op (`server/ops.json`).
  const useChatCommand = await detectSetblockAuth(bot, baseX, baseY + 200, baseZ);

  // Pathfind near the origin (footprint center) only when we'll actually
  // need to be near it. /setblock works at arbitrary range from the bot.
  if (!useChatCommand) {
    try {
      const goal = new goals.GoalNear(centerX, baseY, centerZ, 3);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000));
      // Tail .catch(): mineflayer-pathfinder's `goto` spawns subtasks whose
      // rejections survive Promise.race's outer await, producing the
      // observed `Unhandled rejection: TypeError: Cannot read properties of
      // undefined (reading 'type')` log spam during aerial / unloaded-chunk
      // attempts. Consuming the rejection explicitly silences it.
      await Promise.race([bot.pathfinder.goto(goal), timeout]).catch(() => {});
    } catch (e) { /* continue */ }
  }
  if (bot.interrupt_code) return { result: `build_schematic interrupted` };

  // Place each block in the manifest. Order matters for physical placement
  // stability (foundation-up so each placement has an adjacent block to
  // hold against); harmless but free for /setblock.
  const sorted = [...blocks].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    return (a[0] + a[2]) - (b[0] + b[2]);
  });

  let placed = 0;
  let failed = 0;
  const missing = new Set();
  for (const [dx, dy, dz, block] of sorted) {
    if (bot.interrupt_code) break;
    // Skip explicit air cells — schematic authors sometimes encode them as
    // "negative space" placeholders.  /setblock to air is a no-op crash
    // hazard; physical placeBlock just no-ops.
    if (!block || block === 'air' || block === 'cave_air' || block === 'void_air') continue;
    const tx = baseX + dx, ty = baseY + dy, tz = baseZ + dz;

    if (useChatCommand) {
      // Rapid /setblock burst. The server processes commands in order, so
      // we don't need to wait between them — but a small rate limit keeps
      // the chat queue from tripping Paper's flood-protection.
      try {
        bot.chat(`/setblock ${tx} ${ty} ${tz} ${block}`);
        placed++;
      } catch (e) {
        failed++;
      }
      // 30ms between commands → ~60 blocks/2s, well under flood limits.
      await sleep(30);
    } else {
      // Survival / non-op fallback. Requires the bot to have the block in
      // inventory AND an adjacent solid block to place against. Aerial
      // cells will fail here — that's the cost of not being op.
      if (!findInventoryItem(bot, block)) {
        missing.add(block);
        failed++;
        continue;
      }
      const r = await placeOne(bot, block, tx, ty, tz);
      if (r.ok) placed++;
      else failed++;
      // Move closer if we drift out of reach (every 8 placements).
      if ((placed + failed) % 8 === 0) {
        try {
          const goal = new goals.GoalNear(centerX, ty, centerZ, 3);
          const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000));
          await Promise.race([bot.pathfinder.goto(goal), timeout]).catch(() => {});
        } catch (e) {}
      }
    }
  }

  const missingStr = missing.size > 0 ? ` Missing materials: ${[...missing].join(', ')}.` : '';
  const mode = useChatCommand ? ' via /setblock (op)' : ' via physical placement';
  if (placed === blocks.length) {
    return { result: `Built schematic "${name}" at ${baseX},${baseY},${baseZ} — ${placed}/${blocks.length} blocks placed${mode}.` };
  }
  return {
    result: `Built ${placed}/${blocks.length} of "${name}" at ${baseX},${baseY},${baseZ}${mode}.${missingStr}`,
  };
}

// List schematics — useful for the LLM and for `mc schematics` cmd.
async function list_schematics(bot, _body) {
  try {
    const idx = await loadSchematicIndex();
    const names = Object.entries(idx.schematics || {}).map(
      ([name, entry]) => `${name} (${entry.footprint?.join('x')}x${entry.height}: ${entry.summary})`
    );
    return { result: names.length > 0 ? names.join('; ') : 'No schematics available.' };
  } catch (e) {
    return { result: `Couldn't load schematic index: ${e.message}` };
  }
}

// ── Public registration helper ──────────────────────────────────────

export function registerHighLevelSkills(ACTIONS, ensureBot) {
  ACTIONS.place_near_player = async (body) => place_near_player(ensureBot(), body);
  ACTIONS.give_to_player    = async (body) => give_to_player(ensureBot(), body);
  ACTIONS.build_tower       = async (body) => build_tower(ensureBot(), body);
  ACTIONS.light_area        = async (body) => light_area(ensureBot(), body);
  ACTIONS.follow_player_v2  = async (body) => follow_player_v2(ensureBot(), body);
  ACTIONS.build_schematic   = async (body) => build_schematic(ensureBot(), body);
  ACTIONS.list_schematics   = async (body) => list_schematics(ensureBot(), body);
  return ACTIONS;
}
