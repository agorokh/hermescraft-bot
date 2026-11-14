import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { registerHighLevelSkills } from '../lib/skills.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
const Item = require('prismarine-item')(registry);
const windows = require('prismarine-windows')(registry);
const inventoryPlugin = require('mineflayer/lib/plugins/inventory');
const simpleInventoryPlugin = require('mineflayer/lib/plugins/simple_inventory');
const copy = item => Item.fromNotch(structuredClone(Item.toNotch(item)));
const contents = window => window.slots.map(item => structuredClone(Item.toNotch(item)));

// Exercise the installed Mineflayer transfer/toss/clickWindow functions and
// genuine PrismarineWindow click semantics on both sides of the packet boundary.
// No connection, server, or hand-written replacement for transfer() is involved.
function inventoryBot({ item = 'stone_pickaxe', count = 12, full = true, pickupCount, pickup = true } = {}) {
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.version = '1.21.11';
  bot.supportFeature = name => registry.supportFeature(name);
  bot._client = new EventEmitter();
  bot.username = 'Steve';
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.players = { Kid: { entity: { username: 'Kid', type: 'player', position: new Vec3(1, 64, 0) } } };
  bot.pathfinder = { goto: async () => {} };
  bot.lookAt = async () => {};
  inventoryPlugin(bot, { hideErrors: false });
  simpleInventoryPlugin(bot);
  bot.quickBarSlot = 0;
  const server = windows.createWindow(0, 'minecraft:inventory', 'Server inventory');
  const source = new Item(registry.itemsByName[item].id, count);
  source.components = item === 'stone_pickaxe' ? [
    { type: 'damage', data: 37 },
    { type: 'custom_data', data: { type: 'compound', value: { marker: { type: 'string', value: 'keep me' } } } },
  ] : [];
  for (let slot = 9; slot < 45; slot++) {
    const item = slot === 9 ? source : full ? new Item(registry.itemsByName.cobblestone.id, 64) : null;
    bot.inventory.updateSlot(slot, item && copy(item));
    server.updateSlot(slot, item && copy(item));
  }
  const packets = [], dropped = [], recipient = [];
  bot._client.write = (name, packet) => {
    if (name !== 'window_click') return;
    packets.push(packet);
    const at = server.slots[packet.slot];
    let drop;
    if (packet.mode === 0 && packet.slot === -999 && server.selectedItem) {
      drop = copy(server.selectedItem);
      drop.count = packet.mouseButton === 0 ? drop.count : 1;
    } else if (packet.mode === 4 && !server.selectedItem && at) {
      drop = copy(at);
      drop.count = packet.mouseButton === 0 ? 1 : drop.count;
    }
    server.acceptClick({ ...packet, item: at });
    assert.deepEqual(contents(bot.inventory), contents(server), 'client prediction and native window semantics agree');
    assert.deepEqual(Item.toNotch(bot.inventory.selectedItem), Item.toNotch(server.selectedItem));
    if (drop) {
      dropped.push(copy(drop));
      if (pickup) {
        recipient.push(copy(drop));
        const collected = copy(drop);
        if (pickupCount !== undefined) collected.count = pickupCount;
        bot.emit('playerCollect', bot.players.Kid.entity, { id: dropped.length, getDroppedItem: () => collected });
      }
    }
  };
  return { bot, server, packets, dropped, recipient, source };
}

test('installed Mineflayer toss reproduces the oversized source bug without concurrency', async () => {
  const { bot, dropped } = inventoryBot();
  await bot.toss(registry.itemsByName.stone_pickaxe.id, null, 1);
  assert.equal(dropped.reduce((n, item) => n + item.count, 0), 12);
  assert.equal(bot.inventory.slots[9], null);
});

for (const full of [false, true]) {
  test(`one native gift leaves eleven component-identical tools and an empty cursor (${full ? 'full' : 'spare'} inventory)`, async () => {
    const { bot, server, packets, dropped, recipient, source } = inventoryBot({ full });
    const before = contents(server);
    const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
    assert.equal(server.slots[9]?.count, 11);
    assert.equal(bot.inventory.slots[9]?.count, 11);
    assert.equal(dropped.reduce((n, item) => n + item.count, 0), 1);
    assert.equal(recipient.reduce((n, item) => n + item.count, 0), 1);
    assert.equal(bot.inventory.selectedItem, null);
    assert.equal(server.selectedItem, null);
    assert.deepEqual(server.slots[9].components, source.components);
    assert.deepEqual(dropped[0].components, source.components);
    assert.deepEqual(contents(server).slice(10), before.slice(10), 'all unrelated slots stay unchanged');
    assert.ok(packets.every(p => p.mode === 4 && p.slot === 9 && p.mouseButton === 0), 'drop from the source slot without carrying its remainder');
    assert.deepEqual(result.item_transfer, { item: 'stone_pickaxe', requested: 1, tossed: 1, pickup_confirmed: true });
  });
}

test('an occupied cursor is preserved without any gift click', async () => {
  const { bot, server, packets } = inventoryBot();
  bot.inventory.selectedItem = new Item(registry.itemsByName.diamond.id, 1);
  server.selectedItem = copy(bot.inventory.selectedItem);
  const before = contents(server), cursor = Item.toNotch(server.selectedItem);
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
  assert.deepEqual(contents(server), before);
  assert.deepEqual(Item.toNotch(bot.inventory.selectedItem), cursor);
  assert.deepEqual(Item.toNotch(server.selectedItem), cursor);
  assert.deepEqual(packets, []);
  assert.equal(result.item_transfer, undefined);
  assert.match(result.result, /cursor/i);
});

test('a stop after one of two requested tools retains truthful partial progress', async () => {
  const { bot, server, dropped } = inventoryBot();
  bot.on('playerCollect', () => { bot._stopGeneration = 1; });
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 2 });
  assert.equal(server.slots[9]?.count, 11);
  assert.equal(dropped.reduce((n, item) => n + item.count, 0), 1);
  assert.equal(bot.inventory.selectedItem, null);
  assert.deepEqual(result.item_transfer, { item: 'stone_pickaxe', requested: 2, tossed: 1, pickup_confirmed: true });
  assert.match(result.result, /stopped|interrupted/i);
});

test('pickup confirmation requires the observed quantity, not only a matching item name', async () => {
  const { bot } = inventoryBot({ count: 1, pickupCount: 12 });
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
  assert.equal(result.item_transfer.tossed, 1);
  assert.equal(result.item_transfer.pickup_confirmed, false);
  assert.doesNotMatch(result.result, /^Gave 1/);
});

test('an ordinary sixty-four cobblestone gift retains the installed toss path', async () => {
  const { bot, server, packets, dropped, recipient } = inventoryBot({ item: 'cobblestone', count: 64 });
  const before = contents(server);
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'cobblestone', count: 64 });
  assert.equal(server.slots[9], null);
  assert.equal(dropped.reduce((n, item) => n + item.count, 0), 64);
  assert.equal(recipient.reduce((n, item) => n + item.count, 0), 64);
  assert.equal(bot.inventory.selectedItem, null);
  assert.deepEqual(contents(server).slice(10), before.slice(10));
  assert.deepEqual(packets.map(p => [p.slot, p.mouseButton, p.mode]), [[9, 0, 0], [-999, 0, 0]]);
  assert.deepEqual(result.item_transfer, { item: 'cobblestone', requested: 64, tossed: 64, pickup_confirmed: true });
});

test('a native error after one drop reports that quantity without losing the remainder', async () => {
  const { bot, server, recipient, source } = inventoryBot();
  const click = bot.clickWindow;
  let clicks = 0;
  bot.clickWindow = async (...args) => {
    if (++clicks === 2) throw new Error('click rejected');
    return click(...args);
  };
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 2 });
  assert.equal(server.slots[9]?.count, 11);
  assert.deepEqual(server.slots[9].components, source.components);
  assert.equal(recipient.reduce((n, item) => n + item.count, 0), 1);
  assert.equal(bot.inventory.selectedItem, null);
  assert.deepEqual(result.item_transfer, { item: 'stone_pickaxe', requested: 2, tossed: 1, pickup_confirmed: true });
  assert.match(result.result, /stopped after 1 of 2: click rejected/i);
});

test('a stop while lookAt is pending cannot perform an ordinary gift', async () => {
  const { bot, server, packets, recipient } = inventoryBot({ count: 1 });
  const before = contents(server);
  let finishLook;
  bot.lookAt = () => new Promise(resolve => { finishLook = resolve; });
  const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishLook, 'function');
  bot._stopGeneration = 1;
  finishLook();
  const result = await pending;
  assert.deepEqual(packets, []);
  assert.deepEqual(contents(server), before);
  assert.deepEqual(recipient, []);
  assert.equal(bot.inventory.selectedItem, null);
  assert.match(result.result, /interrupted/i);
});
