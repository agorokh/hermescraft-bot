import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBuildBaseY } from '../lib/player_utils.js';

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
