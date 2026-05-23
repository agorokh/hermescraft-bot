import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildBillOfMaterials,
  buildStateFileForId,
  filterForemanRequired,
  computeFootprint,
  createBuildState,
  createLayeredPlan,
  inventoryBlockCount,
  inventoryCounts,
  loadBuildState,
  markPlacementComplete,
  markPlacementFailed,
  pendingPlacements,
  saveBuildState,
  shouldPauseForSentry,
  validateBillOfMaterials,
  waitWhileSentryRequired,
} from '../lib/advanced_build_pipeline.js';

const blocks = [
  [1, 1, 0, 'minecraft:oak_planks'],
  [0, 0, 0, 'oak_planks'],
  [1, 0, 0, 'air'],
  [0, 1, 0, 'glass_pane'],
  [0, 2, 0, 'oak_planks'],
];

test('filterForemanRequired skips fluids not carried in inventory', () => {
  assert.deepEqual(
    { ...filterForemanRequired({ cobblestone: 24, water: 1, lava: 2 }) },
    { cobblestone: 24 },
  );
});

test('buildBillOfMaterials ignores air and normalizes minecraft namespace', () => {
  assert.deepEqual({ ...buildBillOfMaterials(blocks) }, {
    oak_planks: 3,
    glass_pane: 1,
  });
});

test('validateBillOfMaterials rejects missing inventory deterministically', () => {
  const available = inventoryCounts([
    { name: 'oak_planks', count: 2 },
    { name: 'glass_pane', count: 1 },
  ]);
  const result = validateBillOfMaterials(buildBillOfMaterials(blocks), available);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [
    { block: 'oak_planks', need: 3, have: 2, missing: 1 },
  ]);
});

test('createLayeredPlan sorts bottom-up and produces outside-footprint scaffold ring', () => {
  const plan = createLayeredPlan({ name: 'tiny', blocks, origin: { x: 10, y: 64, z: -5 } });
  assert.deepEqual(plan.layers.map((l) => l.y), [64, 65, 66]);
  assert.deepEqual(plan.layers.map((l) => l.placements.length), [1, 2, 1]);
  assert.deepEqual(computeFootprint(blocks), {
    minDx: 0,
    maxDx: 1,
    minDz: 0,
    maxDz: 0,
    width: 2,
    length: 1,
  });
  assert.equal(plan.scaffolding.length, 10);
  for (const scaffold of plan.scaffolding) {
    const insideFootprint = scaffold.x >= 10 && scaffold.x <= 11 && scaffold.z === -5;
    assert.equal(insideFootprint, false, `scaffold ${JSON.stringify(scaffold)} is inside footprint`);
  }
});

test('build state resumes without duplicating completed placements', () => {
  const plan = createLayeredPlan({ name: 'tiny', blocks, origin: { x: 0, y: 70, z: 0 } });
  const state = markPlacementComplete(createBuildState(plan, 1000), plan.placements[0], 2000);
  const pending = pendingPlacements(plan, state);
  assert.equal(pending.length, plan.totalBlocks - 1);
  assert.equal(pending.some((p) => p.id === plan.placements[0].id), false);
});

test('pendingPlacements skips permanent failures but retries transient ones', () => {
  const plan = createLayeredPlan({ name: 'tiny', blocks, origin: { x: 0, y: 70, z: 0 } });
  const permanent = markPlacementFailed(createBuildState(plan), plan.placements[0], 'missing inventory');
  assert.equal(pendingPlacements(plan, permanent).some((p) => p.id === plan.placements[0].id), false);

  const transient = markPlacementFailed(
    createBuildState(plan),
    plan.placements[0],
    'no adjacent block to place against at 0,70,0',
  );
  assert.equal(pendingPlacements(plan, transient).some((p) => p.id === plan.placements[0].id), true);
});

test('inventoryBlockCount accepts bucket aliases for fluids', () => {
  const counts = inventoryCounts([{ name: 'water_bucket', count: 2 }]);
  assert.equal(inventoryBlockCount(counts, 'water'), 2);
});

test('buildStateFileForId namespaces state per build', () => {
  const a = buildStateFileForId('well-10-64-10');
  const b = buildStateFileForId('tower-0-70-0');
  assert.notEqual(a, b);
  assert.match(a, /build_states\/well-10-64-10\.json$/);
});

test('build state can be saved and loaded from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-build-state-'));
  const file = join(dir, 'build_state.json');
  try {
    const plan = createLayeredPlan({ name: 'tiny', blocks, origin: { x: 1, y: 2, z: 3 } });
    const state = createBuildState(plan, 1234);
    await saveBuildState(state, file);
    assert.deepEqual(await loadBuildState(file), state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('waitWhileSentryRequired returns immediately when pause not required', async () => {
  const bot = {
    health: 20,
    entities: {},
    entity: { position: { distanceTo: () => 999 } },
  };
  assert.deepEqual(
    await waitWhileSentryRequired(bot, { maxPauseMs: 0, checkIntervalMs: 1 }),
    { paused: false, reason: null },
  );
});

test('waitWhileSentryRequired honors maxPauseMs of zero', async () => {
  const bot = {
    health: 6,
    entities: {},
    entity: { position: { distanceTo: () => 999 } },
  };
  const result = await waitWhileSentryRequired(bot, { maxPauseMs: 0, checkIntervalMs: 1 });
  assert.equal(result.paused, true);
  assert.match(result.reason, /health/);
});

test('waitWhileSentryRequired treats invalid timing opts as defaults', async () => {
  const bot = {
    health: 20,
    entities: {},
    entity: { position: { distanceTo: () => 999 } },
  };
  assert.deepEqual(
    await waitWhileSentryRequired(bot, { maxPauseMs: 'nope', checkIntervalMs: -5 }),
    { paused: false, reason: null },
  );
});

test('shouldPauseForSentry triggers on low health or nearby hostile', () => {
  assert.deepEqual(shouldPauseForSentry({ health: 6, hostiles: [] }), {
    pause: true,
    reason: 'health 6 <= 8',
  });
  assert.deepEqual(shouldPauseForSentry({ health: 20, hostiles: [{ name: 'creeper', distance: 4.25 }] }), {
    pause: true,
    reason: 'creeper at 4.3m',
  });
  assert.deepEqual(shouldPauseForSentry({ health: 20, hostiles: [{ name: 'zombie', distance: 20 }] }), {
    pause: false,
    reason: null,
  });
});
