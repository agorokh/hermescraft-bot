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

function isValidTowerFooting(bot, footX, footY, footZ) {
  const ground = bot.blockAt(new Vec3(footX, footY - 1, footZ));
  const space = bot.blockAt(new Vec3(footX, footY, footZ));
  const groundSolid = ground
    && ground.boundingBox === 'block'
    && !NON_GROUND_BLOCKS.has(ground.name);
  const spaceClear = !space || CLEAR_FOOT_BLOCKS.has(space.name);
  return groundSolid && spaceClear;
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
