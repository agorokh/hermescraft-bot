// Read-only placement preflight shared by automatic and explicit library builds.
// Unknown blocks are not air. Do not raise a build onto another structure or
// invent an origin over void when no supported, clear footprint is available.
const CLEAR = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'snow',
]);
// Water can be replaced by a supporting foundation below the build, but it
// remains an obstruction in the actual build volume. Lava is never skipped.
const SUPPORT_WATER = new Set(['water', 'flowing_water']);
const NATURAL_GROUND = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'packed_mud', 'clay', 'stone', 'andesite', 'granite', 'diorite',
  'deepslate', 'tuff', 'calcite', 'sand', 'red_sand', 'gravel', 'sandstone',
  'red_sandstone', 'snow_block', 'ice', 'packed_ice', 'blue_ice', 'terracotta',
  'netherrack', 'basalt', 'blackstone', 'end_stone',
]);
const denied = (code, reason) => ({ ok: false, code, reason });
export const MAX_FOUNDATION_PLACEMENTS = 4096;

export function schematicSiteDimensions(entry, data) {
  const blocks = data.blocks || [];
  return {
    footprint: [
      Math.max(entry.footprint?.[0] || 0, data.footprint?.[0] || 0, ...blocks.map(b => b[0] + 1)),
      Math.max(entry.footprint?.[1] || 0, data.footprint?.[1] || 0, ...blocks.map(b => b[2] + 1)),
    ],
    height: Math.max(2, entry.height || 0, data.height || 0, ...blocks.map(b => b[1] + 1)),
  };
}

export function validateSchematicSite({ blockAt, footprint, height, origin, occupied = [], adjustTerrain = false }) {
  const [width, length] = footprint;
  const { x, y, z } = origin;
  if (![x, y, z, width, length, height].every(Number.isInteger)
    || width < 1 || length < 1 || height < 1 || y < -63 || y + height > 320) {
    return denied('bounds', 'the build must fit inside the world');
  }
  const ground = [];
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < length; dz++) {
      let supportY = null;
      for (let sy = adjustTerrain ? y + height - 1 : y - 1; sy >= Math.max(-64, y - 17); sy--) {
        const block = blockAt(x + dx, sy, z + dz);
        if (!block) return denied('unknown', 'part of the ground has not loaded');
        if (CLEAR.has(block.name) || SUPPORT_WATER.has(block.name)) continue;
        if (block.boundingBox !== 'block' || !NATURAL_GROUND.has(block.name)) {
          return denied('occupied_ground', 'the ground contains a structure or an unsuitable block');
        }
        supportY = sy;
        break;
      }
      if (supportY == null) return denied('unsupported', 'the whole footprint needs solid natural ground');
      ground.push(supportY);
    }
  }
  const baseY = adjustTerrain ? Math.max(...ground) + 1 : y;
  if (baseY + height > 320 || ground.some(gy => baseY - 1 - gy > 16)) {
    return denied('uneven', 'the ground is too uneven for a safe foundation');
  }
  if (ground.reduce((total, gy) => total + baseY - 1 - gy, 0) > MAX_FOUNDATION_PLACEMENTS) {
    return denied('foundation_size', 'the foundation would be too large');
  }
  // Foundation fill is part of the mutation volume, even below a raised base.
  // Include the actors' width so a hitbox crossing the footprint edge is safe too.
  const collisionBottom = Math.min(...ground) + 1;
  if (occupied.some(p => p && p.x + 0.3 > x && p.x - 0.3 < x + width
    && p.z + 0.3 > z && p.z - 0.3 < z + length
    && p.y + 2 > collisionBottom && p.y < baseY + height)) {
    return denied('occupied_player', 'a player or character is standing in the build space');
  }
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < length; dz++) {
      for (let dy = 0; dy < height; dy++) {
        const block = blockAt(x + dx, baseY + dy, z + dz);
        if (!block) return denied('unknown', 'part of the build space has not loaded');
        if (!CLEAR.has(block.name)) return denied('occupied', 'the build needs clear space, away from existing blocks');
      }
    }
  }
  return { ok: true, origin: { x, y: baseY, z } };
}

// A crowded starter island can have its first clear footprint just beyond eight
// blocks. Search up to one chunk away, retaining every support/clearance check.
export function findNearbySchematicSite({ blockAt, footprint, height, anchor, occupied = [], radius = 16 }) {
  if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) {
    return denied('anchor', 'the player position is unavailable');
  }
  const px = Math.floor(anchor.x), py = Math.floor(anchor.y), pz = Math.floor(anchor.z);
  const [width, length] = footprint;
  const candidates = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      candidates.push({ x: px + dx - Math.floor(width / 2), z: pz + dz - Math.floor(length / 2), distance: dx * dx + dz * dz });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
  let failure = null;
  let mixedReasons = false;
  for (const candidate of candidates) {
    for (const dy of [0, 1, -1]) {
      const origin = { x: candidate.x, y: py + dy, z: candidate.z };
      const site = validateSchematicSite({ blockAt, footprint, height, origin, occupied, adjustTerrain: true });
      if (site.ok) return site;
      if (!failure) failure = site;
      else if (failure.code !== site.code) mixedReasons = true;
    }
  }
  return failure && !mixedReasons ? failure
    : denied('no_room', 'we need a bigger patch of clear natural ground nearby');
}
