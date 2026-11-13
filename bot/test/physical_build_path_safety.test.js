import test from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import { Vec3 } from 'vec3';
import { physicalBuildMovements } from '../lib/skills.js';

const registry = minecraftData('1.21.11');
const Block = prismarineBlock(registry);
const { Movements, goals } = pathfinderPkg;
const damagingSupport = new Set(['magma_block', 'campfire', 'soul_campfire', 'cactus']);

function nativeWorld({ hazard, stepUp = false, actor } = {}) {
  const bot = {
    registry,
    players: actor ? { Arsenyzzz: { entity: { position: actor } } } : {},
    inventory: { items: () => [] },
    game: { minY: -64 },
    blockAt(position) {
      const p = position.floored();
      if (p.x < -2 || p.x > 4 || p.z < -2 || p.z > 2 || p.y < 60 || p.y > 68) return null;
      const floorY = stepUp && p.x >= 1 ? 64 : 63;
      let name = p.y <= floorY ? 'stone' : 'air';
      if (hazard && p.x === 1 && p.y === 63 && p.z === 0) name = hazard;
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const movements = physicalBuildMovements(bot, new Movements(bot));
  const goal = new goals.GoalBlock(2, stepUp ? 65 : 64, 0);
  const search = new AStar(new Move(0, 64, 0, 0), movements, goal, 1000, 1000, 8);
  return { bot, goal, result: search.compute() };
}

function assertReadOnlyPath(result) {
  assert.ok(['success', 'noPath'].includes(result.status), `unexpected search result: ${result.status}`);
  for (const node of result.path) {
    assert.deepEqual(node.toBreak, [], 'physical walking must not dig');
    assert.deepEqual(node.toPlace, [], 'physical walking must not scaffold');
  }
}

for (const hazard of damagingSupport) {
  test(`native physical route avoids intermediate ${hazard} support`, () => {
    const { bot, result } = nativeWorld({ hazard });
    assertReadOnlyPath(result);
    // Both endpoints have ordinary stone support. The dangerous cell lies
    // between them, so destination-only stance checks cannot protect this walk.
    assert.equal(bot.blockAt(new Vec3(0, 63, 0)).name, 'stone');
    assert.equal(bot.blockAt(new Vec3(2, 63, 0)).name, 'stone');
    for (const node of result.path) {
      const support = bot.blockAt(new Vec3(node.x, node.y - 1, node.z));
      assert.ok(support && !damagingSupport.has(support.name),
        `native ${result.status} path steps onto ${support?.name} at ${node.x},${node.y},${node.z}`);
    }
  });
}

test('native physical walking still reaches an ordinary supported destination', () => {
  const { goal, result } = nativeWorld();
  assertReadOnlyPath(result);
  assert.equal(result.status, 'success');
  assert.ok(result.path.length > 0);
  assert.ok(goal.isEnd(result.path.at(-1)));
});

test('native physical walking preserves ordinary one-block step-ups', () => {
  const { bot, goal, result } = nativeWorld({ stepUp: true });
  assertReadOnlyPath(result);
  assert.equal(result.status, 'success');
  assert.ok(goal.isEnd(result.path.at(-1)));
  assert.ok(result.path.some(node => node.y === 65));
  for (const node of result.path) {
    assert.equal(bot.blockAt(new Vec3(node.x, node.y - 1, node.z)).name, 'stone');
  }
});

test('native physical step-ups do not route through an intermediate player', () => {
  const actor = new Vec3(1.5, 65, .5);
  const { result } = nativeWorld({ stepUp: true, actor });
  assertReadOnlyPath(result);
  for (const node of result.path) {
    assert.ok(Math.abs(node.x + .5 - actor.x) >= .8 || Math.abs(node.z + .5 - actor.z) >= .8
      || Math.abs(node.y - actor.y) >= 2, 'intermediate step enters the player hitbox');
  }
});
