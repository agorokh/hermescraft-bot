import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { registerHighLevelSkills } from '../lib/skills.js';
import { actionOutcomeFailed, publicActionResult } from '../lib/action_outcome.js';

class GiftBot extends EventEmitter {
  constructor({ count = 8, pickup = true, tossFails = false } = {}) {
    super();
    this.username = 'Rosie';
    this.entity = { position: { x: 0, y: 64, z: 0 } };
    this.players = { Arsenyzzz: { entity: { username: 'Arsenyzzz', type: 'player', position: { x: 1, y: 64, z: 0 } } } };
    this.inventory = { items: () => count ? [{ name: 'oak_planks', type: 17, count }] : [] };
    this.pathfinder = { goto: async () => {} };
    this.lookAt = async () => {};
    this.tosses = [];
    this.toss = async (type, metadata, amount) => {
      this.tosses.push({ type, metadata, amount });
      if (tossFails) throw new Error('toss refused');
      count -= amount;
      if (pickup) this.emit('playerCollect', this.players.Arsenyzzz.entity, { getDroppedItem: () => ({ name: 'oak_planks', count: amount }) });
    };
  }
}

test('partial stock reports the actual transfer and retains requested count', async () => {
  const bot = new GiftBot({ count: 3 });
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  assert.equal(bot.tosses[0].amount, 3);
  assert.match(result.result, /^Gave 3 oak_planks/);
  assert.match(result.result, /8 requested/);
  assert.deepEqual(result.item_transfer, { item: 'oak_planks', requested: 8, tossed: 3, pickup_confirmed: true });
  assert.equal(actionOutcomeFailed(result), false, 'a real partial transfer must not be blindly replayed');
});

test('eight available items and a matching pickup produce one exact eight-item transfer', async () => {
  const bot = new GiftBot();
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  assert.deepEqual(bot.tosses, [{ type: 17, metadata: null, amount: 8 }]);
  assert.deepEqual(result.item_transfer, { item: 'oak_planks', requested: 8, tossed: 8, pickup_confirmed: true });
  assert.match(result.result, /^Gave 8 oak_planks/);
  assert.equal(actionOutcomeFailed(result), false);
});

test('a toss with unconfirmed pickup stays distinguishable from no transfer', async () => {
  const bot = new GiftBot({ pickup: false });
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  assert.equal(bot.tosses.length, 1);
  assert.equal(result.item_transfer?.tossed, 8);
  assert.equal(result.item_transfer?.pickup_confirmed, false);
  assert.equal(actionOutcomeFailed(result), false, 'pickup uncertainty must not turn a completed toss into a retry');
  assert.match(publicActionResult('give_to_player', result), /^Tossed 8 oak_planks/);
  assert.match(result.result, /not confirmed/);
});

test('actual transfer metadata prevents replay even when uncertainty text contains a failure word', () => {
  const result = { result: "Tossed 3 oak_planks; couldn't confirm pickup.",
    item_transfer: { item: 'oak_planks', requested: 8, tossed: 3, pickup_confirmed: false } };
  assert.equal(actionOutcomeFailed(result), false);
  assert.match(publicActionResult('give_to_player', result), /couldn't confirm pickup/);
});

test('zero inventory and toss rejection remain failures with no successful-transfer metadata', async () => {
  for (const opts of [{ count: 0 }, { tossFails: true }]) {
    const bot = new GiftBot(opts);
    const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
    assert.equal(result.item_transfer, undefined);
    assert.equal(actionOutcomeFailed(result), true);
  }
});

test('invalid requested quantities cannot toss items', async () => {
  for (const count of [0, -1, 1.5, NaN, true, '']) {
    const bot = new GiftBot();
    const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count });
    assert.deepEqual(bot.tosses, []);
    assert.equal(actionOutcomeFailed(result), true);
  }
});

function pathfinderGiftBot(opts = {}) {
  const bot = new GiftBot(opts);
  bot.registry = minecraftData('1.21.4');
  bot.entity.position = new Vec3(0, 64, 0);
  bot.entity.velocity = new Vec3(0, 0, 0);
  bot.players.Arsenyzzz.entity.position = new Vec3(4, 64, 0);
  bot.entities = { 2: bot.players.Arsenyzzz.entity };
  bot.clearControlStates = () => {};
  pathfinderPkg.pathfinder(bot);
  return bot;
}

test('a no-path gift releases its own installed navigation goal before tossing', async () => {
  const bot = pathfinderGiftBot({ pickup: false });
  const toss = bot.toss;
  let goalWhenTossed;
  bot.toss = async (...args) => { goalWhenTossed = bot.pathfinder.goal; return toss(...args); };
  const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  assert.ok(bot.pathfinder.goal instanceof pathfinderPkg.goals.GoalNear);
  bot.emit('path_update', { path: [], status: 'noPath' });
  try {
    const result = await pending;
    assert.equal(goalWhenTossed, null, 'navigation ownership ends before the pickup wait');
    assert.equal(bot.pathfinder.goal, null, 'completed gift leaves no idle-blocking static goal');
    assert.deepEqual(result.item_transfer, { item: 'oak_planks', requested: 8, tossed: 8, pickup_confirmed: false });
  } finally { bot.pathfinder.setGoal(null); }
});

test('a real ten-second navigation timeout releases the gift goal and retains its transfer receipt', async () => {
  const bot = pathfinderGiftBot();
  const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  assert.ok(bot.pathfinder.goal instanceof pathfinderPkg.goals.GoalNear);
  // No physics/path result: the real skill's ten-second Promise.race expires.
  try {
    const result = await pending;
    assert.equal(bot.pathfinder.goal, null, 'the external timeout must cancel its exact surviving goal');
    assert.deepEqual(result.item_transfer, { item: 'oak_planks', requested: 8, tossed: 8, pickup_confirmed: true });
  } finally { bot.pathfinder.setGoal(null); }
});

for (const kind of ['static', 'dynamic follow']) {
  test(`gift navigation cleanup preserves a newer ${kind} goal`, async () => {
    const bot = pathfinderGiftBot();
    const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
    const replacement = kind === 'static'
      ? new pathfinderPkg.goals.GoalNear(9, 64, 9, 2)
      : new pathfinderPkg.goals.GoalFollow(bot.players.Arsenyzzz.entity, 3);
    bot.pathfinder.setGoal(replacement, kind !== 'static');
    try {
      const result = await pending;
      assert.equal(bot.pathfinder.goal, replacement, 'only the gift-owned object may be cleared');
      assert.equal(result.item_transfer.tossed, 8);
    } finally { bot.pathfinder.setGoal(null); }
  });
}

test('stopping during navigation retains stop and performs no gift', async () => {
  const bot = pathfinderGiftBot();
  const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  bot._stopGeneration = 1;
  bot.interrupt_code = true;
  bot.pathfinder.setGoal(null);
  const result = await pending;
  assert.match(result.result, /interrupted/);
  assert.equal(bot.interrupt_code, true);
  assert.equal(bot.pathfinder.goal, null);
  assert.deepEqual(bot.tosses, []);
});

test('navigation cleanup stays with the original bot across a connection replacement', async () => {
  const original = pathfinderGiftBot(), replacement = pathfinderGiftBot();
  let current = original;
  const actions = registerHighLevelSkills({}, () => current);
  const pending = actions.give_to_player({ player: 'Arsenyzzz', item: 'oak_planks', count: 8 });
  const newGoal = new pathfinderPkg.goals.GoalFollow(replacement.players.Arsenyzzz.entity, 3);
  replacement.pathfinder.setGoal(newGoal, true);
  current = replacement;
  original.emit('path_update', { path: [], status: 'noPath' });
  try {
    await pending;
    assert.equal(original.pathfinder.goal, null);
    assert.equal(replacement.pathfinder.goal, newGoal);
  } finally { original.pathfinder.setGoal(null); replacement.pathfinder.setGoal(null); }
});
