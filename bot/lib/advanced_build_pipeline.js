import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const BUILD_STATE_DIR = join(__dirname, '..', 'build_states');
/** @deprecated use buildStateFileForId — single-file path kept for tests */
export const BUILD_STATE_FILE = join(BUILD_STATE_DIR, 'build_state.json');

export function buildStateFileForId(buildId) {
  const safe = String(buildId || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return join(BUILD_STATE_DIR, `${safe}.json`);
}

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const STATE_SUFFIX_RE = /^(\[]|\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])$/;
/** Blocks placeable via /setblock but not carried as stackable inventory. */
const FOREMAN_INVENTORY_EXEMPT = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire',
  'bubble_column', 'powder_snow',
]);
const INVENTORY_BLOCK_ALIASES = {
  water: ['water_bucket'],
  lava: ['lava_bucket'],
};
const DEFAULT_HEALTH_PAUSE_THRESHOLD = 8;
const DEFAULT_HOSTILE_PAUSE_RADIUS = 10;
const HOSTILE_MOB_TYPES = new Set([
  'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'witch',
  'enderman', 'phantom', 'drowned', 'husk', 'stray', 'vindicator',
  'pillager', 'ravager', 'blaze', 'ghast', 'slime', 'magma_cube',
]);

export function normalizeBlockName(name) {
  return String(name || '').toLowerCase().replace(/^minecraft:/, '');
}

export function normalizeBlockBaseName(name) {
  const normalized = normalizeBlockName(name);
  const stateStart = normalized.lastIndexOf('[');
  if (stateStart === -1) return normalized;
  const path = normalized.slice(0, stateStart);
  const suffix = normalized.slice(stateStart);
  if (
    path.includes('[')
    || !STATE_SUFFIX_RE.test(suffix)
  ) return normalized;
  return path;
}

function expectedBlockState(name) {
  const normalized = normalizeBlockName(name);
  const base = normalizeBlockBaseName(normalized);
  const stateStart = normalized.lastIndexOf('[');
  if (stateStart === -1) return { base, properties: null, invalid: false };
  const suffix = normalized.slice(stateStart);
  if (!STATE_SUFFIX_RE.test(suffix)) return { base, properties: null, invalid: true };
  const body = suffix.slice(1, -1);
  if (!body) return { base, properties: null, invalid: false };
  const properties = Object.create(null);
  for (const part of body.split(',')) {
    const pair = part.split('=');
    if (pair.length !== 2 || !pair[0] || !pair[1]) return { base, properties: null, invalid: true };
    const [key, value] = pair;
    properties[key] = value;
  }
  return { base, properties, invalid: false };
}

function readbackName(readback) {
  if (typeof readback === 'string') return readback;
  return readback?.name || null;
}

function readbackProperties(readback) {
  if (typeof readback?.getProperties === 'function') {
    try { return readback.getProperties(); } catch {}
  }
  return readback?.properties || readback?._properties || null;
}

function blockReadbackMatches(expected, readback) {
  const actualName = readbackName(readback);
  if (actualName == null || actualName === '') return null;
  const expectedState = expectedBlockState(expected);
  if (expectedState.invalid) return false;
  if (normalizeBlockBaseName(actualName) !== expectedState.base) return false;
  if (!expectedState.properties) return true;
  const actualProperties = readbackProperties(readback);
  if (!actualProperties) return false;
  return Object.entries(expectedState.properties).every(
    ([key, value]) => String(actualProperties[key]) === value,
  );
}

export function normalizeSchematicBlocks(blocks) {
  return (blocks || [])
    .filter((b) => Array.isArray(b) && b.length >= 4)
    .map(([dx, dy, dz, block]) => ({
      dx: Math.floor(Number(dx)),
      dy: Math.floor(Number(dy)),
      dz: Math.floor(Number(dz)),
      block: normalizeBlockName(block),
    }))
    .filter((b) =>
      Number.isFinite(b.dx)
      && Number.isFinite(b.dy)
      && Number.isFinite(b.dz)
      && b.block
      && !AIR_BLOCKS.has(normalizeBlockBaseName(b.block))
    );
}

export function buildBillOfMaterials(blocks) {
  const materials = Object.create(null);
  for (const { block } of normalizeSchematicBlocks(blocks)) {
    const baseBlock = normalizeBlockBaseName(block);
    materials[baseBlock] = (materials[baseBlock] || 0) + 1;
  }
  return materials;
}

export function inventoryCounts(items = []) {
  const counts = Object.create(null);
  for (const item of items || []) {
    const name = normalizeBlockBaseName(item?.name || item?.displayName);
    if (!name) continue;
    counts[name] = (counts[name] || 0) + Number(item.count || 0);
  }
  return counts;
}

export function inventoryBlockCount(available, block) {
  const name = normalizeBlockBaseName(block);
  let have = Number(available?.[name] || 0);
  for (const alias of INVENTORY_BLOCK_ALIASES[name] || []) {
    have += Number(available?.[alias] || 0);
  }
  return have;
}

export function isPermanentBuildFailure(error) {
  const msg = String(error || '').toLowerCase();
  return msg.includes('missing inventory') || msg.includes('foreman rejected');
}

export function isRetryableBuildFailure(error) {
  return !isPermanentBuildFailure(error);
}

export function filterForemanRequired(required) {
  const filtered = Object.create(null);
  for (const [block, count] of Object.entries(required || {})) {
    const name = normalizeBlockBaseName(block);
    if (FOREMAN_INVENTORY_EXEMPT.has(name)) continue;
    filtered[name] = (filtered[name] || 0) + Number(count || 0);
  }
  return filtered;
}

export function foremanBillOfMaterials(required, setblockCapable = true) {
  return setblockCapable ? filterForemanRequired(required) : { ...(required || {}) };
}

export function validateBillOfMaterials(required, available, setblockCapable = true) {
  const missing = [];
  const normalizedRequired = Object.create(null);
  for (const [block, count] of Object.entries(required || {})) {
    const name = normalizeBlockBaseName(block);
    normalizedRequired[name] = (normalizedRequired[name] || 0) + Number(count || 0);
  }
  for (const [name, count] of Object.entries(normalizedRequired)) {
    const have = setblockCapable
      ? inventoryBlockCount(available, name)
      : Number(available?.[name] || 0);
    const need = Number(count || 0);
    if (have < need) missing.push({ block: name, need, have, missing: need - have });
  }
  return { ok: missing.length === 0, missing };
}

export function computeFootprint(blocks) {
  const normalized = normalizeSchematicBlocks(blocks);
  if (normalized.length === 0) {
    return { minDx: 0, maxDx: 0, minDz: 0, maxDz: 0, width: 0, length: 0 };
  }
  let minDx = Infinity, maxDx = -Infinity, minDz = Infinity, maxDz = -Infinity;
  for (const b of normalized) {
    minDx = Math.min(minDx, b.dx);
    maxDx = Math.max(maxDx, b.dx);
    minDz = Math.min(minDz, b.dz);
    maxDz = Math.max(maxDz, b.dz);
  }
  return { minDx, maxDx, minDz, maxDz, width: maxDx - minDx + 1, length: maxDz - minDz + 1 };
}

/**
 * Compute the "floor cells" of a schematic — the (dx,dz) cells that have at
 * least one block at dy=0. These are the cells that must touch ground;
 * everything above must rest on them. Used by the foundation generator and
 * by terrain-aware origin Y selection.
 */
export function computeFloorCells(blocks) {
  const normalized = normalizeSchematicBlocks(blocks);
  const cells = new Map(); // "dx,dz" -> { dx, dz, block }
  for (const b of normalized) {
    if (b.dy !== 0) continue;
    if (!b.block || AIR_BLOCKS.has(normalizeBlockBaseName(b.block))) continue;
    const key = `${b.dx},${b.dz}`;
    if (!cells.has(key)) cells.set(key, { dx: b.dx, dz: b.dz, block: b.block });
  }
  return [...cells.values()];
}

/**
 * Sample the world ground Y beneath each (dx,dz) floor cell of a schematic.
 * For each cell, scan downward from `searchTopY` to find the highest solid
 * block (skipping leaves, water, air). Returns:
 *   - groundMap:    Map "dx,dz" -> groundY (the Y of the highest solid block)
 *   - maxGroundY:   the highest of all sampled groundY values
 *   - minGroundY:   the lowest of all sampled groundY values
 *   - missingCells: array of "dx,dz" cells where no ground found in scan range
 *
 * Caller decides what to do with the spread: a 1-block delta is normal, a
 * 5-block delta means the build will straddle a slope (foundation fills it),
 * a 12+ delta might mean the operator should reject the placement.
 *
 * `isSolidGroundBlock` is injected so tests can pass a stub.
 */
export function sampleFootprintGround({
  blockAt,
  floorCells,
  baseX,
  baseZ,
  searchTopY,
  searchBottomY = -64,
  isSolidGroundBlock,
}) {
  if (typeof blockAt !== 'function') {
    throw new Error('sampleFootprintGround needs blockAt(x,y,z) callback');
  }
  if (typeof isSolidGroundBlock !== 'function') {
    throw new Error('sampleFootprintGround needs isSolidGroundBlock(block) callback');
  }
  const groundMap = new Map();
  const missingCells = [];
  let maxGroundY = -Infinity;
  let minGroundY = Infinity;
  for (const cell of floorCells) {
    const wx = baseX + cell.dx;
    const wz = baseZ + cell.dz;
    let groundY = null;
    for (let y = searchTopY; y >= searchBottomY; y--) {
      const block = blockAt(wx, y, wz);
      if (isSolidGroundBlock(block, { wx, y, wz, cell })) { groundY = y; break; }
    }
    if (groundY === null) {
      missingCells.push(`${cell.dx},${cell.dz}`);
      continue;
    }
    groundMap.set(`${cell.dx},${cell.dz}`, groundY);
    if (groundY > maxGroundY) maxGroundY = groundY;
    if (groundY < minGroundY) minGroundY = groundY;
  }
  if (groundMap.size === 0) {
    return { groundMap, maxGroundY: null, minGroundY: null, missingCells, sampledCells: 0 };
  }
  return { groundMap, maxGroundY, minGroundY, missingCells, sampledCells: groundMap.size };
}

/**
 * Generate the foundation placement list for a schematic. For every floor
 * cell where the world ground is below the schematic floor (baseY-1), fill
 * the gap with `fillBlock`. This is what grounds the build to terrain so it
 * doesn't float and doesn't split on slopes.
 *
 * Cap the per-cell fill depth at `maxFillDepth` (default 16) so a schematic
 * placed over a deep cave doesn't generate thousands of foundation cells.
 *
 * Returns placements compatible with createLayeredPlan's placement schema:
 *   { id, x, y, z, dx, dy, dz, block, foundation: true }
 */
export function generateFoundation({
  floorCells,
  groundMap,
  baseX,
  baseY,
  baseZ,
  fillBlock = 'stone',
  maxFillDepth = 16,
}) {
  const placements = [];
  const stats = { cellsFilled: 0, blocksAdded: 0, maxDepth: 0, capped: 0 };
  for (const cell of floorCells) {
    const key = `${cell.dx},${cell.dz}`;
    const groundY = groundMap.get(key);
    if (groundY === undefined || groundY === null) continue;
    const targetTop = baseY - 1;
    if (groundY >= targetTop) continue; // already supported
    const wx = baseX + cell.dx;
    const wz = baseZ + cell.dz;
    let fillFrom = groundY + 1;
    const requestedDepth = targetTop - groundY;
    if (requestedDepth > maxFillDepth) {
      stats.capped++;
      fillFrom = targetTop - maxFillDepth + 1;
    }
    for (let y = fillFrom; y <= targetTop; y++) {
      placements.push({
        id: `${wx},${y},${wz}:foundation:${fillBlock}`,
        x: wx,
        y,
        z: wz,
        dx: cell.dx,
        dy: y - baseY,
        dz: cell.dz,
        block: fillBlock,
        foundation: true,
      });
      stats.blocksAdded++;
    }
    stats.cellsFilled++;
    const actualDepth = targetTop - fillFrom + 1;
    if (actualDepth > stats.maxDepth) stats.maxDepth = actualDepth;
  }
  return { placements, stats };
}

export function scaffoldRingForFootprint(footprint, origin, block = 'dirt') {
  const baseX = Math.floor(origin.x);
  const baseY = Math.floor(origin.y);
  const baseZ = Math.floor(origin.z);
  const ring = [];
  const minX = baseX + footprint.minDx - 1;
  const maxX = baseX + footprint.maxDx + 1;
  const minZ = baseZ + footprint.minDz - 1;
  const maxZ = baseZ + footprint.maxDz + 1;
  for (let x = minX; x <= maxX; x++) {
    ring.push({ x, y: baseY, z: minZ, block, scaffold: true });
    ring.push({ x, y: baseY, z: maxZ, block, scaffold: true });
  }
  for (let z = minZ + 1; z <= maxZ - 1; z++) {
    ring.push({ x: minX, y: baseY, z, block, scaffold: true });
    ring.push({ x: maxX, y: baseY, z, block, scaffold: true });
  }
  return ring;
}

export function createLayeredPlan({ name, blocks, origin, scaffoldBlock = 'dirt' }) {
  const baseX = Math.floor(origin.x);
  const baseY = Math.floor(origin.y);
  const baseZ = Math.floor(origin.z);
  const normalized = normalizeSchematicBlocks(blocks);
  const placements = normalized
    .map((b) => ({
      id: `${baseX + b.dx},${baseY + b.dy},${baseZ + b.dz}:${b.block}`,
      x: baseX + b.dx,
      y: baseY + b.dy,
      z: baseZ + b.dz,
      dx: b.dx,
      dy: b.dy,
      dz: b.dz,
      block: b.block,
    }))
    .sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      if (a.x !== b.x) return a.x - b.x;
      return a.z - b.z;
    });
  const footprint = computeFootprint(blocks);
  const layers = [];
  for (const placement of placements) {
    let layer = layers.find((l) => l.y === placement.y);
    if (!layer) {
      layer = { y: placement.y, placements: [] };
      layers.push(layer);
    }
    layer.placements.push(placement);
  }
  return {
    name,
    origin: { x: baseX, y: baseY, z: baseZ },
    totalBlocks: placements.length,
    materials: buildBillOfMaterials(blocks),
    footprint,
    scaffolding: scaffoldRingForFootprint(footprint, { x: baseX, y: baseY, z: baseZ }, scaffoldBlock),
    layers,
    placements,
  };
}

export function createBuildState(plan, now = Date.now()) {
  return {
    schema_version: 1,
    build_id: `${plan.name}-${plan.origin.x}-${plan.origin.y}-${plan.origin.z}`,
    name: plan.name,
    origin: plan.origin,
    totalBlocks: plan.totalBlocks,
    started_at: now,
    updated_at: now,
    status: 'running',
    completed: [],
    failed: [],
    scaffolding: plan.scaffolding,
  };
}

export function markPlacementComplete(state, placement, now = Date.now()) {
  const completed = new Set(state.completed || []);
  completed.add(placement.id);
  return { ...state, completed: [...completed], updated_at: now };
}

export function markPlacementFailed(state, placement, error, now = Date.now()) {
  return {
    ...state,
    failed: [...(state.failed || []), { id: placement.id, error: String(error || 'unknown') }],
    updated_at: now,
  };
}

export function pendingPlacements(plan, state = {}) {
  const completed = new Set(state.completed || []);
  const permanentFailed = new Set(
    (state.failed || [])
      .filter((f) => isPermanentBuildFailure(f.error))
      .map((f) => f.id),
  );
  return (plan.placements || []).filter(
    (placement) => !completed.has(placement.id) && !permanentFailed.has(placement.id),
  );
}

export function reconcileCompletedPlacements(plan, state = {}, blockNameAt) {
  if (
    !plan
    || !Array.isArray(plan.placements)
    || !state
    || !Array.isArray(state.completed)
    || typeof blockNameAt !== 'function'
  ) {
    return state;
  }
  const expectedById = new Map((plan.placements || []).map((p) => [p.id, p]));
  const kept = [];
  const removed = [];
  for (const id of state.completed) {
    const placement = expectedById.get(id);
    if (!placement) {
      removed.push({ id, reason: 'not in plan' });
      continue;
    }
    const readback = blockNameAt(placement.x, placement.y, placement.z);
    const matches = blockReadbackMatches(placement.block, readback);
    if (matches == null) {
      kept.push(id);
      continue;
    }
    if (matches) {
      kept.push(id);
    } else {
      const actual = normalizeBlockBaseName(readbackName(readback));
      removed.push({ id, reason: `world has ${actual || 'unknown'}, expected ${placement.block}` });
    }
  }
  if (removed.length === 0 && kept.length === state.completed.length) return state;
  return {
    ...state,
    completed: kept,
    resume_reconciled_at: Date.now(),
    resume_reconciled_missing: removed,
  };
}

export async function saveBuildState(state, file = BUILD_STATE_FILE) {
  await mkdir(dirname(file), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, file);
}

export async function loadBuildState(file = BUILD_STATE_FILE) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

export function entityIsHostile(entity) {
  if (!entity || entity.type !== 'mob') return false;
  const name = normalizeBlockName(entity.name || entity.mobType || '');
  return HOSTILE_MOB_TYPES.has(name);
}

export function shouldPauseForSentry({ health, hostiles = [] } = {}, opts = {}) {
  const healthThreshold = opts.healthThreshold ?? DEFAULT_HEALTH_PAUSE_THRESHOLD;
  const hostileRadius = opts.hostileRadius ?? DEFAULT_HOSTILE_PAUSE_RADIUS;
  if (Number.isFinite(health) && health <= healthThreshold) {
    return { pause: true, reason: `health ${health} <= ${healthThreshold}` };
  }
  const nearest = hostiles
    .filter((h) => Number.isFinite(h.distance) && h.distance <= hostileRadius)
    .sort((a, b) => a.distance - b.distance)[0];
  if (nearest) {
    return { pause: true, reason: `${nearest.name || 'hostile'} at ${nearest.distance.toFixed(1)}m` };
  }
  return { pause: false, reason: null };
}

export function safetySnapshotFromBot(bot) {
  const hostiles = [];
  for (const entity of Object.values(bot?.entities || {})) {
    if (!entityIsHostile(entity) || !bot?.entity?.position || !entity.position) continue;
    hostiles.push({
      name: normalizeBlockName(entity.name || entity.mobType || 'hostile'),
      distance: bot.entity.position.distanceTo(entity.position),
    });
  }
  return { health: bot?.health, hostiles };
}

function normalizePauseMs(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function normalizeIntervalMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(100, n) : fallback;
}

export async function waitWhileSentryRequired(bot, opts = {}) {
  const maxPauseMs = normalizePauseMs(opts.maxPauseMs, 15000);
  const checkIntervalMs = normalizeIntervalMs(opts.checkIntervalMs, 1000);
  const snapshot = () => shouldPauseForSentry(safetySnapshotFromBot(bot), opts);
  if (maxPauseMs <= 0) {
    const decision = snapshot();
    return { paused: decision.pause, reason: decision.pause ? decision.reason : null };
  }
  const started = Date.now();
  let lastDecision = { pause: false, reason: null };
  while (Date.now() - started < maxPauseMs) {
    lastDecision = snapshot();
    if (!lastDecision.pause) return { paused: false, reason: null };
    await new Promise((r) => setTimeout(r, checkIntervalMs));
  }
  return { paused: true, reason: lastDecision.reason };
}
