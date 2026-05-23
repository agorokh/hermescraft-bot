import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import minecraftData from 'minecraft-data';
import {
  buildBillOfMaterials,
  createLayeredPlan,
  validateBillOfMaterials,
} from '../lib/advanced_build_pipeline.js';
import { isAdvancedSchematicName, resolveSchematicName } from '../lib/schematic_resolve.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMATICS_DIR = join(__dirname, '..', 'schematics');
const mcData = minecraftData('1.21');
const knownBlocks = new Set(Object.keys(mcData.blocksByName || {}));

function readJson(file) {
  return JSON.parse(readFileSync(join(SCHEMATICS_DIR, file), 'utf8'));
}

const GALLERY = [
  ['crystal_observatory', 260, 'amethyst_block'],
  ['wizard_tower', 260, 'purple_wool'],
  ['market_square', 300, 'barrel'],
  ['sky_bridge', 120, 'oak_fence'],
  ['beacon_plaza', 170, 'beacon'],
];

test('advanced gallery schematics are large, valid, and Foreman-readable', () => {
  const index = readJson('INDEX.json');
  for (const [name, minBlocks, signatureBlock] of GALLERY) {
    const entry = index.schematics[name];
    assert.ok(entry, `INDEX must expose ${name}`);
    assert.equal(isAdvancedSchematicName(name), true);

    const schematic = readJson(entry.file);
    assert.equal(schematic.name, name);
    assert.ok(schematic.blocks.length >= minBlocks, `${name} should be visibly substantial`);
    assert.deepEqual(schematic.materials, { ...buildBillOfMaterials(schematic.blocks) });
    assert.deepEqual(entry.materials, schematic.materials);
    assert.ok(schematic.materials[signatureBlock] > 0, `${name} should include ${signatureBlock}`);

    for (const [, , , block] of schematic.blocks) {
      assert.ok(knownBlocks.has(block), `${name} uses unknown Minecraft block ${block}`);
    }

    const plan = createLayeredPlan({ name, blocks: schematic.blocks, origin: { x: 100, y: 70, z: 100 } });
    assert.equal(plan.totalBlocks, schematic.blocks.length);
    assert.ok(plan.layers.length >= 3, `${name} should have meaningful vertical shape`);
    assert.ok(plan.scaffolding.length > 0, `${name} should produce an outside-footprint scaffold ring`);
    assert.equal(validateBillOfMaterials(schematic.materials, schematic.materials).ok, true);
  }
});


test('generic bridge and beacon words do not hijack gallery schematics', () => {
  assert.equal(resolveSchematicName('build a castle with a bridge'), 'small_tower');
  assert.equal(resolveSchematicName('build a house near the bridge'), 'small_house');
  assert.equal(resolveSchematicName('place a beacon on the hill'), null);
  assert.equal(resolveSchematicName('build a sky bridge over the river'), 'sky_bridge');
});

test('kid gallery aliases route to the advanced Foreman path', () => {
  for (const [body, expected] of [
    ['rosie build a crystal observatory here', 'crystal_observatory'],
    ['make me a wizard tower', 'wizard_tower'],
    ['set up a village square market', 'market_square'],
    ['build a sky bridge over there', 'sky_bridge'],
    ['make a bright beacon plaza', 'beacon_plaza'],
  ]) {
    assert.equal(resolveSchematicName(body), expected, body);
    assert.equal(isAdvancedSchematicName(expected), true, body);
  }
});
