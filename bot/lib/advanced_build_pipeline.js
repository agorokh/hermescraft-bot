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
      && !AIR_BLOCKS.has(b.block)
    );
}

export function buildBillOfMaterials(blocks) {
  const materials = Object.create(null);
  for (const { block } of normalizeSchematicBlocks(blocks)) {
    materials[block] = (materials[block] || 0) + 1;
  }
  return materials;
}

export function inventoryCounts(items = []) {
  const counts = Object.create(null);
  for (const item of items || []) {
    const name = normalizeBlockName(item?.name || item?.displayName);
    if (!name) continue;
    counts[name] = (counts[name] || 0) + Number(item.count || 0);
  }
  return counts;
}

export function validateBillOfMaterials(required, available) {
  const missing = [];
  for (const [block, count] of Object.entries(required || {})) {
    const have = Number(available?.[normalizeBlockName(block)] || 0);
    const need = Number(count || 0);
    if (have < need) missing.push({ block: normalizeBlockName(block), need, have, missing: need - have });
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
  const failed = new Set((state.failed || []).map((f) => f.id));
  return (plan.placements || []).filter(
    (placement) => !completed.has(placement.id) && !failed.has(placement.id),
  );
}

export async function saveBuildState(state, file = BUILD_STATE_FILE) {
  await mkdir(dirname(file), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, file);
}

export async function loadBuildState(file = BUILD_STATE_FILE) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
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
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
