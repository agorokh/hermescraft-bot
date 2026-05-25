import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitSchematicBaseY, normalizeBuildBaseY, schematicBuildBaseY } from '../lib/player_utils.js';

function mockBot(blockAtFn) {
  return { blockAt: blockAtFn };
}

test('normalizeBuildBaseY does not return above world ceiling', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 319) return { name: 'stone', boundingBox: 'block' };
    if (pos.y === 320) return { name: 'air' };
    return { name: 'air' };
  });
  assert.equal(normalizeBuildBaseY(bot, 10, 10, 319), 319);
});

test('normalizeBuildBaseY skips canopy leaves and logs', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 70) return { name: 'oak_leaves', boundingBox: 'block' };
    if (pos.y === 68) return { name: 'oak_log', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'dirt', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(normalizeBuildBaseY(bot, 10, 10, 65), 65);
});

test('normalizeBuildBaseY accepts clear log platforms', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 68) return { name: 'oak_log', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'dirt', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(normalizeBuildBaseY(bot, 10, 10, 65), 69);
});

test('raised sky bridge base Y is clamped to world ceiling', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 318) return { name: 'stone', boundingBox: 'block' };
    if (pos.y === 319) return { name: 'air' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'sky_bridge', 'raised sky bridge', 10, 10, 319), 319);
});

test('schematicBuildBaseY honors clear requested gallery floor below stale elevated blocks', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 69) return { name: 'oak_planks', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'market_square', 'set up a market square here', 290, 288, 65), 65);
});

test('schematicBuildBaseY skips requested tree-canopy footing', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 68) return { name: 'oak_log', boundingBox: 'block' };
    if (pos.y === 69 && pos.x === 10 && pos.z === 10) return { name: 'air' };
    if (pos.y === 70 && Math.abs(pos.x - 10) <= 1 && Math.abs(pos.z - 10) <= 1) {
      return { name: 'oak_leaves', boundingBox: 'block' };
    }
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'well', 'build a well here', 10, 10, 69), 65);
});

test('explicit schematic base Y overrides terrain normalization for prepared gallery prompts', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 70) return { name: 'oak_planks', boundingBox: 'block' };
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(explicitSchematicBaseY('set up a market square at base y 65'), 65);
  assert.equal(schematicBuildBaseY(bot, 'market_square', 'set up a market square at base y 65', 290, 288, 65), 65);
  assert.equal(schematicBuildBaseY(bot, 'sky_bridge', 'build a raised sky bridge at base y 69', 262, 286, 65), 69);
});

test('explicit schematic base Y rejects out-of-world values instead of clamping', () => {
  assert.equal(explicitSchematicBaseY('build a market square at base y 999'), null);
  assert.equal(explicitSchematicBaseY('build a market square at base y -99'), null);
});

test('explicit schematic base Y is ignored for non-gallery schematics', () => {
  const bot = mockBot((pos) => {
    if (pos.y === 64) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air' };
  });
  assert.equal(schematicBuildBaseY(bot, 'small_house', 'build a small house at base y 70', 10, 10, 65), 65);
});
