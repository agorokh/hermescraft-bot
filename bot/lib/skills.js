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
//   3. Cancel is via `bot._stopGeneration` bumped from /action/stop (and
//      /task/cancel). Each long skill captures the generation at start and
//      polls — a new stop request does not get cleared by a later skill.
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
import schematicPkg from 'prismarine-schematic';
const { Schematic } = schematicPkg;
import { Vec3 } from 'vec3';
import fs from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { findPlayerEntity, hasNearbyLeaves, isWoodLikeBlockName, itemNameFromCollectEntity } from './player_utils.js';
import {
  buildStateFileForId,
  buildBillOfMaterials,
  computeFloorCells,
  createBuildState,
  createLayeredPlan,
  foremanBillOfMaterials,
  generateFoundation,
  inventoryCounts,
  loadBuildState,
  markPlacementComplete,
  markPlacementFailed,
  normalizeBlockName,
  pendingPlacements,
  reconcileCompletedPlacements,
  sampleFootprintGround,
  saveBuildState,
  validateBillOfMaterials,
  waitWhileSentryRequired,
} from './advanced_build_pipeline.js';

const BUILD_STATE_SAVE_EVERY_N = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMATICS_DIR = join(__dirname, '..', 'schematics');

// Mineflayer chat throttle is ~1s; /setblock bursts must respect it.
const SETBLOCK_CHAT_INTERVAL_MS = 150;
const CLEAR_GROUND_SPACE_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'grass', 'snow',
  'fern', 'large_fern', 'dead_bush', 'dandelion', 'poppy', 'blue_orchid',
  'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip',
  'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'wither_rose', 'sunflower', 'lilac', 'rose_bush', 'peony', 'brown_mushroom',
  'red_mushroom', 'oak_sapling', 'spruce_sapling', 'birch_sapling',
  'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'mangrove_propagule',
  'cherry_sapling', 'bamboo_sapling', 'nether_sprouts', 'crimson_roots',
  'warped_roots', 'torchflower', 'pitcher_plant',
]);
const NON_GROUND_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'flowing_water', 'flowing_lava']);

function captureStopGen(bot) {
  return bot._stopGeneration || 0;
}

function skillWasStopped(bot, stopGen) {
  return (bot._stopGeneration || 0) !== stopGen;
}

// ── helpers ──────────────────────────────────────────────────────────

function findInventoryItem(bot, itemName) {
  const ln = itemName.toLowerCase();
  return bot.inventory.items().find((i) => i.name === ln || i.displayName?.toLowerCase() === ln);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isClearGroundSpaceBlock(block) {
  if (!block) return true;
  const name = block.name || '';
  if (['water', 'lava', 'flowing_water', 'flowing_lava'].includes(name)) return false;
  return CLEAR_GROUND_SPACE_BLOCKS.has(name) || block.boundingBox !== 'block';
}

function isFoundationGroundBlock(bot, block, x, y, z) {
  const name = block?.name || '';
  if (!block || block.boundingBox !== 'block') return false;
  if (NON_GROUND_BLOCKS.has(name) || CLEAR_GROUND_SPACE_BLOCKS.has(name) || name.endsWith('_leaves')) return false;
  const above = bot.blockAt(new Vec3(x, y + 1, z));
  if (!isClearGroundSpaceBlock(above)) return false;
  return !isWoodLikeBlockName(name) || !hasNearbyLeaves(bot, x, y, z);
}

function paperConsoleFifo() {
  const fifo = process.env.PAPER_CONSOLE_FIFO;
  if (!fifo || process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH !== '1') return null;
  try {
    const st = fs.statSync(fifo);
    return st.isFIFO() ? fifo : null;
  } catch {
    return null;
  }
}

function sendServerCommand(command) {
  const fifo = paperConsoleFifo();
  if (!fifo) return null;
  let fd = null;
  try {
    fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, `${command}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function safeSetblockCommand(x, y, z, block) {
  const rawCoords = [x, y, z];
  if (rawCoords.some((value) => value == null || value === '' || typeof value === 'boolean')) {
    throw new Error('Unsafe setblock command arguments');
  }
  const coords = rawCoords.map((value) => Number(value));
  const blockName = String(block || '').trim();
  if (!coords.every(Number.isInteger) || !/^[a-z0-9_:-]+$/i.test(blockName)) {
    throw new Error('Unsafe setblock command arguments');
  }
  return `setblock ${coords[0]} ${coords[1]} ${coords[2]} ${blockName}`;
}

function sendSetblockCommand(bot, x, y, z, block) {
  const command = safeSetblockCommand(x, y, z, block);
  const sent = sendServerCommand(command);
  if (sent === true) return 'console_fifo';
  if (process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH === '1'
    && process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK !== '1') {
    throw new Error('Paper console FIFO unavailable for trusted setblock');
  }
  bot.chat(`/${command}`);
  return 'bot_chat';
}

function bodyFlagEnabled(value, defaultEnabled = true) {
  if (value === undefined || value === null) return defaultEnabled;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  let s = String(value).trim().toLowerCase();
  const eq = s.indexOf('=');
  if (eq !== -1) s = s.slice(eq + 1).trim();
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return defaultEnabled;
}

function collectItemMatches(tossedItem, collectedEntity) {
  const want = normalizeBlockName(tossedItem);
  const got = normalizeBlockName(itemNameFromCollectEntity(collectedEntity));
  if (!want || !got) return false;
  return got === want || got.endsWith(`/${want}`) || want.endsWith(`/${got}`);
}

function blockAtMatches(bot, x, y, z, expected) {
  const readback = bot.blockAt(new Vec3(x, y, z));
  if (!readback) return false;
  return normalizeBlockName(readback.name) === normalizeBlockName(expected);
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
const LIQUID_BLOCKS = new Set(['water', 'lava']);
const REPLACEABLE_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'seagrass', 'tall_seagrass',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'snow', 'vine', 'glow_lichen', 'hanging_roots',
]);

// Cache for the bot's op-status. Set lazily on first placeOne call; never
// flipped within a session. Companion bots in this repo are always op'd
// (server/ops.json level 4) so this resolves to `true` immediately,
// turning every aerial-cell block into an instant /setblock chat command
// instead of a physical pathfind+placeBlock that crashes on no-adjacent.
async function _cachedSetblockAuth(bot) {
  if (bot._hc_setblock_auth === true || _setblockAuthByBot.get(bot) === true) {
    bot._hc_setblock_auth = true;
    return true;
  }
  if (!bot.entity) return false; // chunks/body not ready — retry on next placeOne
  const ok = await detectSetblockAuth(bot);
  if (ok) bot._hc_setblock_auth = true;
  return ok;
}

// Core place primitive. Returns true on success.
// allowReachRecover: if true, when placeBlock fails due to reach distance,
// move the bot closer and retry once. Skill loops set this to true; raw
// callers may set false to avoid the pathfind overhead.
//
// 2026-05-16 — op-aware fast path. If the bot is op (probed once per
// session and cached on `bot._hc_setblock_auth`), use vanilla `/setblock`
// chat command — instant, aerial-safe, no pathfind needed. This is the
// same pattern `build_schematic` uses for cheat-mode placement. It
// eliminates the 70+ `Unhandled rejection: TypeError: Cannot read
// properties of undefined (reading 'type')` errors per session that
// `bot.placeBlock` was emitting on aerial cells (treehouse roof, tower
// top, etc.), and the "STUCK detected" 10s pathfinder stalls that come
// from the bot trying to physically reach floating placements.
async function placeOne(bot, itemName, x, y, z, allowReachRecover = true) {
  const tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);

  // Skip air/cave_air targets defensively.
  if (!itemName || itemName === 'air' || itemName === 'cave_air' || itemName === 'void_air') {
    return { ok: false, reason: 'placeOne: refused to place air' };
  }

  if (await _cachedSetblockAuth(bot)) {
    // Already-matching block? Don't re-fire.
    const existing = bot.blockAt(new Vec3(tx, ty, tz));
    if (existing && existing.name === itemName) {
      return { ok: true, reason: `already ${itemName} at ${tx},${ty},${tz}` };
    }
    try {
      const transport = sendSetblockCommand(bot, tx, ty, tz, itemName);
      const outcome = await waitForSetblockOutcome(
        bot,
        { x: tx, y: ty, z: tz, block: itemName },
        transport === 'console_fifo' ? 900 : SETBLOCK_CHAT_INTERVAL_MS + 150,
      );
      if (outcome.ok === true) {
        return { ok: true };
      }
    } catch (e) {
      // /setblock chat failed for an unexpected reason — fall through to
      // physical path. Cache flip not done here to avoid permanent
      // downgrade if it was transient.
    }
    // /setblock rejected or chunk not updated — fall through to physical place.
  }

  const targetPos = new Vec3(tx, ty, tz);
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
  if (existing && REPLACEABLE_BLOCKS.has(existing.name) && !LIQUID_BLOCKS.has(existing.name)
      && existing.name !== 'air' && existing.name !== 'cave_air' && existing.name !== 'void_air') {
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
  const stopGen = captureStopGen(bot);
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
    if (skillWasStopped(bot, stopGen)) return { result: `place_near_player interrupted` };
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
  const stopGen = captureStopGen(bot);
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
  if (skillWasStopped(bot, stopGen)) return { result: `give_to_player interrupted` };

  await bot.lookAt(p);
  // Register before toss so fast LAN pickups cannot fire before we listen.
  let received = false;
  const onCollect = (collector, collected) => {
    const who = (collector?.username || collector?.name || '').toLowerCase();
    if (who === player.toLowerCase() && collectItemMatches(item, collected)) {
      received = true;
    }
  };
  bot.on('playerCollect', onCollect);
  try {
    await bot.toss(stack.type, null, Math.min(count, stack.count));
  } catch (e) {
    bot.removeListener('playerCollect', onCollect);
    return { result: `Couldn't toss ${item}: ${e.message}` };
  }

  // 3s wait for collect event (Mindcraft pattern).
  const start = Date.now();
  while (Date.now() - start < 3000 && !received) {
    if (skillWasStopped(bot, stopGen)) break;
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
  const stopGen = captureStopGen(bot);
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
  if (skillWasStopped(bot, stopGen)) return { result: `build_tower interrupted` };

  // Verify we have material.
  const matItem = findInventoryItem(bot, material);
  if (!matItem) return { result: `No ${material} in my inventory.` };
  try { await bot.equip(matItem, 'hand'); } catch (e) {
    return { result: `Couldn't equip ${material}: ${e.message}` };
  }

  let placed = 0;
  for (let i = 0; i < height; i++) {
    if (skillWasStopped(bot, stopGen)) break;

    // Find the block directly below feet — that's our reference for
    // placing the new block at feet level.
    const feetY = Math.floor(bot.entity.position.y);
    const refPos = new Vec3(baseX, feetY - 1, baseZ);
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
  const stopGen = captureStopGen(bot);
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
      if (skillWasStopped(bot, stopGen)) break;
      let ty = Math.floor(cy);
      for (let y = Math.min(319, ty + 4); y >= Math.max(-64, ty - 4); y--) {
        const n = bot.blockAt(new Vec3(tx, y, tz))?.name || 'air';
        if (n !== 'air' && n !== 'cave_air' && n !== 'void_air') {
          ty = y + 1;
          break;
        }
      }
      const r = await placeOne(bot, 'torch', tx, ty, tz);
      if (r.ok) placed++;
    }
    if (skillWasStopped(bot, stopGen)) break;
  }
  return {
    result: placed > 0
      ? `Lit the area around ${cx},${cy},${cz} with ${placed} torches.`
      : `Couldn't place any torches — area may already be lit or I don't have torches.`,
    placed,
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
  const file = join(SCHEMATICS_DIR, entry.file);
  if (entry.file.endsWith('.schem') || entry.file.endsWith('.schematic')) {
    const schematic = await Schematic.read(await readFile(file));
    const start = schematic.start();
    const blocks = [];
    schematic.forEach((block, pos) => {
      const blockName = normalizeBlockName(block?.name);
      if (!blockName || blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air') return;
      blocks.push([pos.x - start.x, pos.y - start.y, pos.z - start.z, blockName]);
    });
    const data = {
      schema_version: 1,
      name,
      footprint: [schematic.size.x, schematic.size.z],
      height: schematic.size.y,
      materials: buildBillOfMaterials(blocks),
      blocks,
    };
    return {
      entry: {
        ...entry,
        footprint: entry.footprint || data.footprint,
        height: entry.height || data.height,
        materials: entry.materials || data.materials,
      },
      data,
    };
  }
  const raw = await readFile(file, 'utf8');
  return { entry, data: JSON.parse(raw) };
}

// Per-bot cache: probe once per connection, not on every schematic build.
const _setblockAuthByBot = new WeakMap();

function shouldBypassForemanMaterials(useChatCommand) {
  return useChatCommand && process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH === '1';
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

function messageMentionsCoords(message, x, y, z) {
  const target = `${x} ${y} ${z}`;
  const triples = String(message || '')
    .toLowerCase()
    .match(/-?\d+\s*(?:,\s*|\s+)-?\d+\s*(?:,\s*|\s+)-?\d+/g) || [];
  return triples.some((triple) => triple.replace(/\s*,\s*|\s+/g, ' ').trim() === target);
}

function extractMessageText(message) {
  if (message && typeof message.toString === 'function') {
    try { return message.toString(); } catch { /* fall through */ }
  }
  return String(message || '');
}

/** Command feedback only — ignore player chat that happens to mention coords. */
function isCommandFeedbackMessage(message, position) {
  if (position === 'chat') return false;
  const text = extractMessageText(message).trim();
  if (/^<\w+>/.test(text)) return false;
  return true;
}

function isSetblockCommandFeedback(message, position) {
  if (!isCommandFeedbackMessage(message, position)) return false;
  const lower = extractMessageText(message).toLowerCase();
  return lower.includes('changed the block') || lower.includes('set block');
}

async function detectSetblockAuth(bot) {
  if (_setblockAuthByBot.get(bot) === true) return true;
  if (process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH === '1') {
    _setblockAuthByBot.set(bot, true);
    bot._hc_setblock_auth = true;
    return true;
  }
  // Probe at the bot's current position +1Y (a cell guaranteed to be in a
  // loaded chunk).  Use a sentinel block we can read back unambiguously
  // and that's cheap to roll back: white_wool (visible distinct, every
  // server has it in the registry).
  const sentinel = 'white_wool';
  const myPos = bot.entity?.position;
  if (!myPos) return false; // no bot body, no point trying /setblock
  const px = Math.floor(myPos.x);
  const pz = Math.floor(myPos.z);
  // Probe only in air so restore never wipes block state / block entities.
  const airNames = new Set(['air', 'cave_air', 'void_air']);
  let probeX = px, py = null, probeZ = pz;
  const baseY = Math.floor(myPos.y);
  const offsets = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) offsets.push([dx, dz]);
  }
  outer:
  for (let y = Math.min(319, baseY + 12); y >= Math.max(-64, baseY - 2); y--) {
    for (const [dx, dz] of offsets) {
      const n = bot.blockAt(new Vec3(px + dx, y, pz + dz))?.name || 'air';
      if (airNames.has(n)) {
        probeX = px + dx;
        py = y;
        probeZ = pz + dz;
        break outer;
      }
    }
  }
  if (py == null) return false;

  let commandFeedbackHit = false;
  const onProbeMessage = (message, position) => {
    if (!messageMentionsCoords(extractMessageText(message), probeX, py, probeZ)) return;
    if (isSetblockCommandFeedback(message, position)) commandFeedbackHit = true;
  };
  try { bot.on?.('message', onProbeMessage); } catch {}
  let afterName = 'air';
  try {
    try { sendSetblockCommand(bot, probeX, py, probeZ, sentinel); } catch (e) {}
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const after = bot.blockAt(new Vec3(probeX, py, probeZ));
      afterName = after?.name || 'air';
      if (afterName === sentinel || commandFeedbackHit) break;
      await sleep(100);
    }
  } finally {
    try { bot.removeListener?.('message', onProbeMessage); } catch {}
  }

  const ok = afterName === sentinel || commandFeedbackHit;

  // Restore air — probe cell was empty before we touched it. Readback is the
  // strongest proof, but live tests showed Paper command feedback can arrive
  // while the bot's chunk cache still reads stale air immediately after a TP.
  // Accept feedback as a secondary proof of op auth; never accept timeout alone.
  if (ok) {
    try { sendSetblockCommand(bot, probeX, py, probeZ, 'air'); } catch (e) {}
    _setblockAuthByBot.set(bot, true);
  }
  return ok;
}


async function waitForSetblockOutcome(bot, { x, y, z, block }, timeoutMs = SETBLOCK_CHAT_INTERVAL_MS + 150) {
  let feedbackOk = false;
  let feedbackFail = false;
  const onMessage = (message, position) => {
    const text = extractMessageText(message).toLowerCase();
    if (!isCommandFeedbackMessage(message, position)) return;
    if (!messageMentionsCoords(text, x, y, z)) return;
    if (text.includes('cannot') || text.includes('unknown block') || text.includes('failed')
      || text.includes('out of bounds') || text.includes('not allowed')) {
      feedbackFail = true;
    }
    if (text.includes('changed the block') || text.includes('set block')) feedbackOk = true;
  };
  try {
    try { bot.on?.('message', onMessage); } catch {}
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (feedbackFail) break;
      if (blockAtMatches(bot, x, y, z, block)) break;
      if (feedbackOk) break;
      await sleep(25);
    }
  } finally {
    try { bot.removeListener?.('message', onMessage); } catch {}
  }
  if (feedbackFail) return { ok: false, reason: 'setblock rejected' };
  if (blockAtMatches(bot, x, y, z, block)) return { ok: true };
  if (feedbackOk) return { ok: true };
  if (!bot.blockAt(new Vec3(x, y, z))) return { ok: null, reason: 'chunk unloaded' };
  return { ok: false, reason: 'readback mismatch' };
}

async function build_schematic(bot, { name, x, y, z, ...bodyArgs }) {
  const stopGen = captureStopGen(bot);
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

  const baseX = Math.floor(x), baseZ = Math.floor(z);
  const requestedBaseY = Math.floor(y);
  // baseY is `let` because terrain-aware grounding may adjust it below to
  // sit on the highest sampled ground under the schematic footprint.
  let baseY = requestedBaseY;
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
  const useChatCommand = await detectSetblockAuth(bot);
  const trustedSetblock = shouldBypassForemanMaterials(useChatCommand);
  const resumeEnabled = bodyFlagEnabled(bodyArgs.resume, false);
  const sentryEnabled = bodyFlagEnabled(bodyArgs.sentry_pause, false);
  const respectExplicitBaseY = bodyFlagEnabled(bodyArgs.respect_explicit_base_y, false);
  const buildId = `${name}-${baseX}-${requestedBaseY}-${baseZ}`;
  const stateFile = buildStateFileForId(buildId);
  let savedState = null;
  if (resumeEnabled) {
    savedState = await loadBuildState(stateFile);
  }

  // ── GROUNDING & FOUNDATION ────────────────────────────────────────────────
  // The schematic's floor (dy=0) cells must sit on solid ground or the build
  // looks "split in halves" (some buried in a hill, others floating in air).
  // Sample the actual terrain under the entire footprint and:
  //   (1) override baseY to maxGroundY+1 so nothing in the schematic is buried
  //   (2) generate foundation cells filling the gap from terrain to baseY-1
  //       for every floor cell where the ground is below the build floor
  // This grounds builds on real landscape — hills, valleys, slopes.
  // Skipped for physical placement, explicit skip requests, aerial schematics,
  // and resume attempts that already have a saved origin/foundation plan.
  let foundationPlacements = [];
  let foundationStats = null;
  const skipFoundation = !useChatCommand
    || bodyFlagEnabled(bodyArgs.skip_foundation, false)
    || name === 'sky_bridge';   // sky_bridge is the canonical aerial schematic
  const resumingBuildState = savedState?.build_id === buildId && Number.isFinite(savedState?.origin?.y);
  if (resumingBuildState) {
    baseY = Math.floor(savedState.origin.y);
    foundationPlacements = Array.isArray(savedState.foundation_placements)
      ? savedState.foundation_placements
      : [];
    foundationStats = savedState.foundation_stats || null;
  } else if (!skipFoundation) {
    try {
      const floorCells = computeFloorCells(blocks);
      const sample = sampleFootprintGround({
        blockAt: (wx, wy, wz) => bot.blockAt(new Vec3(wx, wy, wz)),
        floorCells,
        baseX,
        baseZ,
        searchTopY: Math.min(319, baseY + 32),
        searchBottomY: Math.max(-64, baseY - 32),
        isSolidGroundBlock: (block, pos) => isFoundationGroundBlock(bot, block, pos.x, pos.y, pos.z),
      });
      // If we found ground under most cells, retarget baseY to the highest
      // ground +1. This prevents the schematic from being buried into a hill.
      // Tolerate up to half the footprint having no ground (e.g. cliff edges)
      // before falling back to the caller's baseY.
      if (!respectExplicitBaseY && sample.sampledCells > 0 && sample.sampledCells * 2 >= floorCells.length) {
        const adjustedBaseY = sample.maxGroundY + 1;
        if (adjustedBaseY !== baseY) {
          console.log(`[build_schematic] terrain-aware baseY for "${name}": caller=${baseY} → adjusted=${adjustedBaseY} (maxGround=${sample.maxGroundY}, minGround=${sample.minGroundY}, spread=${sample.maxGroundY - sample.minGroundY}, sampled=${sample.sampledCells}/${floorCells.length})`);
          baseY = adjustedBaseY;
        }
      }
      // After potential Y adjustment, generate foundation under the schematic.
      // Foundation block: use stone for natural builds, dirt_shelter keeps dirt.
      const fillBlock = (name === 'dirt_shelter' || name === 'igloo') ? 'dirt' : 'stone';
      const foundationResult = generateFoundation({
        floorCells,
        groundMap: sample.groundMap,
        baseX,
        baseY,
        baseZ,
        fillBlock,
        maxFillDepth: 16,
      });
      foundationPlacements = foundationResult.placements;
      foundationStats = foundationResult.stats;
      if (foundationStats && foundationStats.blocksAdded > 0) {
        console.log(`[build_schematic] foundation for "${name}": ${foundationStats.blocksAdded} ${fillBlock} blocks across ${foundationStats.cellsFilled} cells (max depth ${foundationStats.maxDepth}, capped ${foundationStats.capped})`);
      }
    } catch (e) {
      console.log(`[build_schematic] foundation generation failed: ${e.message} — proceeding without foundation`);
      foundationPlacements = [];
      foundationStats = null;
    }
  }

  const buildPlan = createLayeredPlan({ name, blocks, origin: { x: baseX, y: baseY, z: baseZ } });
  let buildState = null;
  let placementsSinceSave = 0;
  const saveEveryN = bodyArgs.record_state === true ? 1 : BUILD_STATE_SAVE_EVERY_N;
  const persistBuildState = async (force = false) => {
    if (!buildState) return;
    if (!force && placementsSinceSave < saveEveryN) return;
    await saveBuildState(buildState, stateFile);
    placementsSinceSave = 0;
  };
  if (resumeEnabled && savedState?.build_id === buildId && savedState?.status === 'done') {
    const verifiedState = reconcileCompletedPlacements(buildPlan, savedState, (wx, wy, wz) => {
      const block = bot.blockAt(new Vec3(wx, wy, wz));
      return block?.name || null;
    });
    const doneCount = verifiedState.completed?.length || 0;
    if (doneCount >= buildPlan.totalBlocks) {
      return {
        result: `Build "${name}" at ${baseX},${baseY},${baseZ} is already complete (${doneCount}/${buildPlan.totalBlocks} blocks).`,
      };
    }
    savedState = { ...verifiedState, status: 'running' };
    await saveBuildState(savedState, stateFile);
  }
  const resumingBuild = savedState?.build_id === buildId && savedState?.status !== 'done';
  if (bodyArgs.foreman === true && !resumingBuild) {
    const required = trustedSetblock
      ? {}
      : foremanBillOfMaterials(
        entry.materials || data.materials || buildPlan.materials,
        useChatCommand,
      );
    const validation = validateBillOfMaterials(
      required,
      inventoryCounts(bot.inventory.items()),
      useChatCommand,
    );
    if (!validation.ok) {
      const miss = validation.missing.map((m) => `${m.block} need ${m.need}, have ${m.have}`).join('; ');
      return { result: `Foreman rejected "${name}" at ${baseX},${baseY},${baseZ}: missing materials — ${miss}.` };
    }
  }
  if (bodyArgs.record_state === true || resumeEnabled) {
    if (resumingBuild) {
      buildState = reconcileCompletedPlacements(buildPlan, savedState, (wx, wy, wz) => {
        const block = bot.blockAt(new Vec3(wx, wy, wz));
        return block?.name || null;
      });
    } else {
      buildState = {
        ...createBuildState(buildPlan),
        build_id: buildId,
        requested_origin: { x: baseX, y: requestedBaseY, z: baseZ },
        foundation_placements: foundationPlacements,
        foundation_stats: foundationStats,
      };
    }
    await persistBuildState(true);
  }

  bot._schematicBuildActive = true;
  let placed = 0;
  let failed = 0;
  let unverified = 0;
  let foundationPlaced = 0;
  let foundationFailed = 0;
  const missing = new Set();
  const totalPlacedSoFar = () => (buildState ? (buildState.completed?.length || 0) : placed);
  try {
  // Pathfind near the origin (footprint center) only when we'll actually
  // need to be near it. /setblock works at arbitrary range from the bot.
  if (!useChatCommand) {
    try {
      const goal = new goals.GoalNear(centerX, baseY, centerZ, 3);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000));
      await Promise.race([bot.pathfinder.goto(goal), timeout]).catch(() => {});
    } catch (e) { /* continue */ }
  }
  if (skillWasStopped(bot, stopGen)) return { result: `build_schematic interrupted` };

  // ── FOUNDATION PHASE ──────────────────────────────────────────────────────
  // Place terrain-fill foundation blocks BEFORE the schematic so layer 0 of
  // the schematic always rests on something solid. Without this, schematics
  // on uneven ground produced "split tower" symptoms (lower half buried in a
  // hill, upper half floating mid-air).
  // Only runs in /setblock mode — physical placement under terrain is too
  // expensive (would require bot to dig down + place + climb).
  if (useChatCommand && foundationPlacements.length > 0) {
    for (const fp of foundationPlacements) {
      if (skillWasStopped(bot, stopGen)) break;
      try {
        const transport = sendSetblockCommand(bot, fp.x, fp.y, fp.z, fp.block);
        const outcome = await waitForSetblockOutcome(
          bot,
          { x: fp.x, y: fp.y, z: fp.z, block: fp.block },
          transport === 'console_fifo' ? 300 : SETBLOCK_CHAT_INTERVAL_MS + 50,
        );
        if (outcome.ok === true || (outcome.ok === null && trustedSetblock)) {
          foundationPlaced++;
        } else {
          foundationFailed++;
        }
      } catch (e) {
        foundationFailed++;
      }
    }
    console.log(`[build_schematic] foundation phase: ${foundationPlaced}/${foundationPlacements.length} placed, ${foundationFailed} failed`);
  }

  const sorted = buildState
    ? pendingPlacements(buildPlan, buildState).map((p) => [p.dx, p.dy, p.dz, p.block])
    : [...blocks].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[2] - b[2];
  });
  for (const [dx, dy, dz, block] of sorted) {
    if (skillWasStopped(bot, stopGen)) break;
    // Skip explicit air cells — schematic authors sometimes encode them as
    // "negative space" placeholders.  /setblock to air is a no-op crash
    // hazard; physical placeBlock just no-ops.
    if (!block || block === 'air' || block === 'cave_air' || block === 'void_air') continue;
    const tx = baseX + dx, ty = baseY + dy, tz = baseZ + dz;
    const placementForState = { id: `${tx},${ty},${tz}:${normalizeBlockName(block)}` };

    if (sentryEnabled) {
      const sentry = await waitWhileSentryRequired(bot, { maxPauseMs: 8000, checkIntervalMs: 1000 });
      if (sentry.paused) {
        if (buildState) {
          buildState.status = 'paused_sentry';
          buildState.pause_reason = sentry.reason;
          await persistBuildState(true);
        }
        return { result: `Build "${name}" paused for Sentry Mode: ${sentry.reason}. Resume with build_schematic_advanced resume=true.` };
      }
    }

    if (useChatCommand) {
      // Rapid /setblock burst. The server processes commands in order, so
      // we don't need to wait between them — but a small rate limit keeps
      // the chat queue from tripping Paper's flood-protection.
      try {
        const transport = sendSetblockCommand(bot, tx, ty, tz, block);
        // Wait for server + world sync, then verify before counting success.
        const outcome = await waitForSetblockOutcome(
          bot,
          { x: tx, y: ty, z: tz, block },
          transport === 'console_fifo' ? 900 : SETBLOCK_CHAT_INTERVAL_MS + 150,
        );
        if (outcome.ok === true) {
          placed++;
          if (buildState) {
            buildState = markPlacementComplete(buildState, placementForState);
            placementsSinceSave++;
            await persistBuildState();
          }
        } else if (outcome.ok === null) {
          unverified++;
        } else if (trustedSetblock) {
          failed++;
          if (buildState) {
            buildState = markPlacementFailed(buildState, placementForState, outcome.reason || 'setblock failed');
            placementsSinceSave++;
            await persistBuildState();
          }
        } else {
          const readback = bot.blockAt(new Vec3(tx, ty, tz));
          if (!readback) {
            unverified++;
          } else if (blockAtMatches(bot, tx, ty, tz, block)) {
            placed++;
            if (buildState) {
              buildState = markPlacementComplete(buildState, placementForState);
              placementsSinceSave++;
              await persistBuildState();
            }
          } else {
            failed++;
            if (buildState) {
              buildState = markPlacementFailed(buildState, placementForState, 'readback mismatch');
              placementsSinceSave++;
              await persistBuildState();
            }
          }
        }
      } catch (e) {
        failed++;
        if (buildState) {
          buildState = markPlacementFailed(buildState, placementForState, e.message);
          placementsSinceSave++;
          await persistBuildState();
        }
      }
    } else {
      // Survival / non-op fallback. Requires the bot to have the block in
      // inventory AND an adjacent solid block to place against. Aerial
      // cells will fail here — that's the cost of not being op.
      if (!findInventoryItem(bot, block)) {
        missing.add(block);
        failed++;
        if (buildState) {
          buildState = markPlacementFailed(buildState, placementForState, 'missing inventory');
          placementsSinceSave++;
          await persistBuildState();
        }
        continue;
      }
      const r = await placeOne(bot, block, tx, ty, tz);
      if (r.ok) {
        placed++;
        if (buildState) {
          buildState = markPlacementComplete(buildState, placementForState);
          placementsSinceSave++;
          await persistBuildState();
        }
      } else {
        failed++;
        if (buildState) {
          buildState = markPlacementFailed(buildState, placementForState, r.reason || 'place failed');
          placementsSinceSave++;
          await persistBuildState();
        }
      }
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
  const unverifiedStr = unverified > 0 ? ` ${unverified} cells unverified (chunk unloaded).` : '';
  const foundationStr = foundationPlaced > 0
    ? ` Foundation: ${foundationPlaced} blocks filled under build to ground it (depth ${foundationStats?.maxDepth || '?'}).`
    : '';
  const mode = useChatCommand ? ' via /setblock (op)' : ' via physical placement';
  const total = buildPlan.totalBlocks;
  const placedCount = totalPlacedSoFar();
  if (placedCount === total && total > 0) {
    if (buildState) {
      buildState.status = 'done';
      buildState = { ...buildState, updated_at: Date.now() };
      await persistBuildState(true);
    }
    return { result: `Built schematic "${name}" at ${baseX},${baseY},${baseZ} — ${placedCount}/${total} blocks placed${mode}.${foundationStr}${unverifiedStr}` };
  }
  if (buildState && placed + failed >= sorted.length) {
    buildState.status = placedCount === total ? 'done' : 'partial';
    buildState = { ...buildState, updated_at: Date.now() };
    await persistBuildState(true);
  } else if (buildState) {
    await persistBuildState(true);
  }
  return {
    result: `Built ${placedCount}/${total} of "${name}" at ${baseX},${baseY},${baseZ}${mode}.${foundationStr}${missingStr}${unverifiedStr}`,
  };
  } finally {
    bot._schematicBuildActive = false;
  }
}

// List schematics — useful for the LLM and for `mc schematics` cmd.
async function list_schematics(bot, _body) {
  try {
    const idx = await loadSchematicIndex();
    const names = Object.entries(idx.schematics || {}).map(([name, entry]) => {
      const fw = entry.footprint?.[0] ?? '?';
      const fl = entry.footprint?.[1] ?? '?';
      const h = entry.height ?? '?';
      return `${name} (${fw}x${fl}x${h}: ${entry.summary || ''})`;
    });
    return { result: names.length > 0 ? names.join('; ') : 'No schematics available.' };
  } catch (e) {
    return { result: `Couldn't load schematic index: ${e.message}` };
  }
}

async function plan_advanced_build(bot, { name, x, y, z }) {
  if (!name) return { result: `plan_advanced_build needs a schematic name` };
  if (x == null || y == null || z == null) return { result: `plan_advanced_build needs x, y, z origin` };

  let loaded;
  try {
    loaded = await loadSchematic(name);
  } catch (e) {
    return { result: `Couldn't load schematic ${name}: ${e.message}` };
  }
  if (loaded.error) return { result: loaded.error };
  const { entry, data } = loaded;
  const baseX = Math.floor(x), baseY = Math.floor(y), baseZ = Math.floor(z);
  const plan = createLayeredPlan({ name, blocks: data.blocks || [], origin: { x: baseX, y: baseY, z: baseZ } });
  const useChatCommand = await detectSetblockAuth(bot);
  const required = shouldBypassForemanMaterials(useChatCommand)
    ? {}
    : foremanBillOfMaterials(
      entry.materials || data.materials || plan.materials,
      useChatCommand,
    );
  const validation = validateBillOfMaterials(
    required,
    inventoryCounts(bot.inventory.items()),
    useChatCommand,
  );
  const layerSummary = plan.layers.map((l) => `Y=${l.y}:${l.placements.length}`).join(', ');
  const scaffoldCount = plan.scaffolding.length;
  if (!validation.ok) {
    const miss = validation.missing.map((m) => `${m.block} need ${m.need}, have ${m.have}`).join('; ');
    return { result: `Foreman rejected "${name}" at ${baseX},${baseY},${baseZ}: missing materials — ${miss}. Plan was ${plan.totalBlocks} blocks, layers ${layerSummary}, ${scaffoldCount} outside-footprint scaffold cells.` };
  }
  return { result: `Foreman approved "${name}" at ${baseX},${baseY},${baseZ}: ${plan.totalBlocks} blocks, layers ${layerSummary}, ${scaffoldCount} outside-footprint scaffold cells. Ready for build_schematic_advanced.` };
}

async function build_schematic_advanced(bot, body) {
  return build_schematic(bot, {
    ...body,
    foreman: true,
    record_state: true,
    resume: bodyFlagEnabled(body?.resume, true),
    sentry_pause: bodyFlagEnabled(body?.sentry_pause, true),
  });
}

// ── Public registration helper ──────────────────────────────────────

export function registerHighLevelSkills(ACTIONS, ensureBot) {
  ACTIONS.place_near_player = async (body) => place_near_player(ensureBot(), body);
  ACTIONS.give_to_player    = async (body) => give_to_player(ensureBot(), body);
  ACTIONS.build_tower       = async (body) => build_tower(ensureBot(), body);
  ACTIONS.light_area        = async (body) => light_area(ensureBot(), body);
  ACTIONS.follow_player_v2  = async (body) => follow_player_v2(ensureBot(), body);
  ACTIONS.build_schematic   = async (body) => build_schematic(ensureBot(), body);
  ACTIONS.plan_advanced_build = async (body) => plan_advanced_build(ensureBot(), body);
  ACTIONS.build_schematic_advanced = async (body) => build_schematic_advanced(ensureBot(), body);
  ACTIONS.list_schematics   = async (body) => list_schematics(ensureBot(), body);
  return ACTIONS;
}
