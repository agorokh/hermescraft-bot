// Shared player lookup and anchor helpers for intent routers and skills.

import { Vec3 } from 'vec3';

export function findPlayerEntity(bot, name) {
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

// Resolve the position to build "near" — preferring the kid's player entity,
// falling back to the bot's own position when the player roster hasn't synced.
export function resolveAnchorPos(bot, ctx) {
  if (ctx.senderEntity && ctx.senderEntity.position) return ctx.senderEntity.position;
  const fresh = findPlayerEntity(bot, ctx.sender);
  if (fresh && fresh.position) return fresh.position;
  if (bot.entity && bot.entity.position) return bot.entity.position;
  return null;
}

export function intFromMatch(text, regex) {
  const m = text.match(regex);
  return m ? parseInt(m[1], 10) : null;
}

const CLEAR_FOOT_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass']);
const NON_GROUND_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);

const MIN_BUILD_BASE_Y = -64;
const MAX_BUILD_BASE_Y = 319;

function clampBuildBaseY(y) {
  return Math.min(MAX_BUILD_BASE_Y, Math.max(MIN_BUILD_BASE_Y, Math.floor(y)));
}



function isSolidGround(block) {
  return block
    && block.boundingBox === 'block'
    && !NON_GROUND_BLOCKS.has(block.name);
}

function isValidTowerFooting(bot, footX, footY, footZ) {
  const ground = bot.blockAt(new Vec3(footX, footY - 1, footZ));
  const space = bot.blockAt(new Vec3(footX, footY, footZ));
  const groundSolid = isSolidGround(ground);
  const spaceClear = !space || CLEAR_FOOT_BLOCKS.has(space.name);
  return groundSolid && spaceClear;
}

// Entity Y can lag after teleports or come through as a low/feet coordinate
// in live Mineflayer sessions. For schematic builds, prefer the closest solid
// surface near the requested base so "build here" does not bury the structure.
export function normalizeBuildBaseY(bot, x, z, rawY) {
  const baseY = Math.floor(rawY);
  const startY = Math.min(319, baseY + 5);
  const endY = Math.max(-64, baseY - 8);
  const columns = [
    [x, z],
    [x - 1, z],
    [x + 1, z],
    [x, z - 1],
    [x, z + 1],
  ];
  for (let y = startY; y >= endY; y--) {
    // Prefer the build column before neighbors so canopy/structure in adjacent
    // columns does not steal the foot Y.
    const [centerX, centerZ] = columns[0];
    const centerGround = bot.blockAt(new Vec3(centerX, y, centerZ));
    const centerSpace = bot.blockAt(new Vec3(centerX, y + 1, centerZ));
    const centerFootY = y + 1;
    if (centerFootY <= MAX_BUILD_BASE_Y
      && isSolidGround(centerGround) && (!centerSpace || CLEAR_FOOT_BLOCKS.has(centerSpace.name))) {
      return centerFootY;
    }
    for (let i = 1; i < columns.length; i++) {
      const [cx, cz] = columns[i];
      const ground = bot.blockAt(new Vec3(cx, y, cz));
      const space = bot.blockAt(new Vec3(cx, y + 1, cz));
      const footY = y + 1;
      if (footY <= MAX_BUILD_BASE_Y
        && isSolidGround(ground) && (!space || CLEAR_FOOT_BLOCKS.has(space.name))) {
        return footY;
      }
    }
  }
  if (baseY >= 0 && baseY < 64) return clampBuildBaseY(baseY + 2);
  return clampBuildBaseY(baseY);
}

// Pick a tower footprint offset: solid ground at footY-1 and buildable air at footY.
export function pickTowerFootOffset(bot, anchorPos) {
  const baseY = Math.floor(anchorPos.y);
  const px = Math.floor(anchorPos.x);
  const pz = Math.floor(anchorPos.z);
  const offsets = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0]];
  for (const [dx, dz] of offsets) {
    if (isValidTowerFooting(bot, px + dx, baseY, pz + dz)) return [dx, dz];
  }
  return offsets[0];
}

export function itemNameFromCollectEntity(collected) {
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
