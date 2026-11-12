import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
