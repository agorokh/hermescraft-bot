import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSchematic = name => JSON.parse(readFileSync(
  new URL(`../schematics/${name}.json`, import.meta.url), 'utf8',
));

test('the igloo roof can be built by hand from the floor through the cap', () => {
  const { blocks } = readSchematic('igloo');
  const ordered = [...blocks].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  const solid = new Set();
  const materials = {};
  for (const [x, y, z, material] of ordered) {
    const neighbors = [
      [x - 1, y, z], [x + 1, y, z], [x, y - 1, z],
      [x, y + 1, z], [x, y, z - 1], [x, y, z + 1],
    ];
    assert.ok(y === 0 || neighbors.some(cell => solid.has(cell.join(','))),
      `placement at ${x},${y},${z} needs an existing solid face`);
    if (material === 'snow_block') solid.add([x, y, z].join(','));
    materials[material] = (materials[material] || 0) + 1;
  }
  assert.ok(solid.has('2,2,2'), 'roof center closes the dome and seats the cap');
  assert.ok(solid.has('2,3,2'), 'the dome retains its cap');
  assert.deepEqual(materials, readSchematic('INDEX').schematics.igloo.materials);
});
