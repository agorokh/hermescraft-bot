import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { formatStuckPos, startSurvivalTick } from '../lib/survival.js';

// Regression: unstuck loop crashed with `pos.toFloor is not a function`
// because Vec3's method is `.floored()`, not `.toFloor()`. The format
// helper sidesteps the Vec3 method-name trap entirely.
test('formatStuckPos floors plain {x,y,z} without calling Vec3 methods', () => {
  assert.equal(formatStuckPos({ x: 10.7, y: 64.2, z: -3.9 }), '10,64,-4');
});

test('formatStuckPos works on a Vec3-like instance', () => {
  const vec = { x: 0.1, y: 65.99, z: 0.0 };
  assert.equal(formatStuckPos(vec), '0,65,0');
});

test('hungry companions keep the building block equipped until physical placement finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const brick = { name: 'stone_bricks' };
  const bread = { name: 'bread' };
  const equips = [];
  let consumed = 0;
  const bot = {
    _schematicBuildActive: true,
    entity: { position: new Vec3(0, 64, 0) },
    food: 10,
    heldItem: brick,
    inventory: { items: () => [bread, brick] },
    pathfinder: { isMoving: () => false },
    equip: async (item) => { bot.heldItem = item; equips.push(item); },
    consume: async () => { consumed++; },
  };
  const down = startSurvivalTick(bot, () => {}, { fleeEnabled: false, torchEnabled: false, unstuckEnabled: false });
  try {
    t.mock.timers.tick(1500);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(bot.heldItem, brick, 'the food reflex cannot replace the held placement material');
    assert.deepEqual(equips, []);
    assert.equal(consumed, 0);
    bot._schematicBuildActive = false;
    t.mock.timers.tick(1500);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(equips, [bread], 'idle hunger behavior resumes after physical building');
    assert.equal(consumed, 1);
  } finally {
    down();
    t.mock.timers.tick(10000);
    await Promise.resolve();
  }
});
