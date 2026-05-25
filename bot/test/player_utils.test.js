import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBuildBaseY, schematicBuildBaseY } from '../lib/player_utils.js';

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
