import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBillOfMaterials,
  createLayeredPlan,
  validateBillOfMaterials,
} from '../lib/advanced_build_pipeline.js';
import { isAdvancedSchematicName, resolveSchematicName } from '../lib/schematic_resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMATICS_DIR = join(__dirname, '..', 'schematics');

function readJson(file) {
  return JSON.parse(readFileSync(join(SCHEMATICS_DIR, file), 'utf8'));
}

test('grand_hotel is a large advanced schematic with consistent materials', () => {
  const index = readJson('INDEX.json');
  const entry = index.schematics.grand_hotel;
  const schematic = readJson(entry.file);

  assert.ok(entry, 'INDEX must expose grand_hotel');
  assert.equal(schematic.blocks.length, 752);
  assert.ok(schematic.blocks.length > 700, 'hotel must be visibly larger than legacy templates');
  assert.deepEqual(schematic.materials, { ...buildBillOfMaterials(schematic.blocks) });
  assert.deepEqual(entry.materials, schematic.materials);

  const plan = createLayeredPlan({ name: 'grand_hotel', blocks: schematic.blocks, origin: { x: 10, y: 64, z: 10 } });
  assert.equal(plan.totalBlocks, schematic.blocks.length);
  assert.deepEqual(plan.layers.map((l) => l.y), [64, 65, 66, 67, 68, 69, 70, 71, 72, 73]);
  assert.ok(plan.scaffolding.length > 0);
});

test('hotel aliases resolve to the advanced grand_hotel target', () => {
  for (const body of [
    'build me a hotel',
    'make a giant mansion here',
    'build the biggest house ever',
    'put up a resort',
  ]) {
    assert.equal(resolveSchematicName(body), 'grand_hotel', body);
  }
  assert.equal(isAdvancedSchematicName('grand_hotel'), true);
  assert.equal(isAdvancedSchematicName('small_house'), false);
});

test('Foreman validates grand_hotel inventory deterministically', () => {
  const schematic = readJson('grand_hotel.json');
  const missing = validateBillOfMaterials(schematic.materials, { oak_planks: 64 });
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.some((m) => m.block === 'cobblestone'));
  assert.ok(missing.missing.some((m) => m.block === 'oak_planks'));

  const stocked = validateBillOfMaterials(schematic.materials, {
    cobblestone: 215,
    oak_planks: 449,
    glass_pane: 32,
    torch: 9,
    oak_fence: 47,
  });
  assert.equal(stocked.ok, true);
});
