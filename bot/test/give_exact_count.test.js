import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { registerHighLevelSkills } from '../lib/skills.js';
import { actionOutcomeFailed } from '../lib/action_outcome.js';

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
function inventoryBot({ item = 'stone_pickaxe', count = 12, full = true, pickupCount, pickup = true, sourceSlot = 9 } = {}) {
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
    const item = slot === sourceSlot ? source : full ? new Item(registry.itemsByName.cobblestone.id, 64) : null;
    bot.inventory.updateSlot(slot, item && copy(item));
    server.updateSlot(slot, item && copy(item));
  }
  const serverWindows = new Map([[0, server]]);
  const packets = [], dropped = [], recipient = [];
  bot._client.write = (name, packet) => {
    if (name !== 'window_click') return;
    packets.push(packet);
    const active = serverWindows.get(packet.windowId);
    const client = packet.windowId === 0 ? bot.inventory : bot.currentWindow;
    const at = active.slots[packet.slot];
    let drop;
    if (packet.mode === 0 && packet.slot === -999 && active.selectedItem) {
      drop = copy(active.selectedItem);
      drop.count = packet.mouseButton === 0 ? drop.count : 1;
    } else if (packet.mode === 4 && !active.selectedItem && at) {
      drop = copy(at);
      drop.count = packet.mouseButton === 0 ? 1 : drop.count;
    }
    active.acceptClick({ ...packet, item: at });
    assert.deepEqual(contents(client), contents(active), 'client prediction and native window semantics agree');
    assert.deepEqual(Item.toNotch(client.selectedItem), Item.toNotch(active.selectedItem));
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
  function openChest() {
    const chest = windows.createWindow(7, 'minecraft:generic_9x3', 'Chest');
    chest.updateSlot(9, new Item(registry.itemsByName.diamond.id, 10));
    for (let slot = 9; slot < 45; slot++) chest.updateSlot(27 + slot - 9, server.slots[slot] && copy(server.slots[slot]));
    serverWindows.set(7, chest);
    bot._client.emit('open_window', { windowId: 7, inventoryType: 'minecraft:generic_9x3', windowTitle: 'Chest', slotCount: 27 });
    bot._client.emit('window_items', { windowId: 7, items: chest.slots.map(item => Item.toNotch(item)) });
    assert.equal(bot.currentWindow.id, 7);
    return chest;
  }
  return { bot, server, packets, dropped, recipient, source, openChest };
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

for (const completedDrops of [0, 1]) {
  test(`an ordinary transfer error counts its cursor as owned after ${completedDrops} actual drops`, async () => {
    const { bot, server, packets, dropped, recipient, source } = inventoryBot({ item: 'cobblestone', count: 64, full: false });
    source.components = [{ type: 'custom_data', data: { type: 'compound', value: { marker: { type: 'string', value: 'preserve cursor' } } } }];
    bot.inventory.updateSlot(9, copy(source));
    server.updateSlot(9, copy(source));
    const diamond = new Item(registry.itemsByName.diamond.id, 3);
    bot.inventory.updateSlot(10, copy(diamond));
    server.updateSlot(10, copy(diamond));
    const before = contents(server);
    const acceptClick = bot.inventory.acceptClick.bind(bot.inventory);
    let outsideClicks = 0;
    bot.inventory.acceptClick = click => {
      if (click.slot === -999 && outsideClicks++ === completedDrops) throw new Error('outside click rejected');
      return acceptClick(click);
    };
    const skills = registerHighLevelSkills({}, () => bot);
    const requested = completedDrops ? 2 : 64;
    const result = await skills.give_to_player({ player: 'Kid', item: 'cobblestone', count: requested });
    assert.equal(server.slots[9], null, 'the installed transfer picked up the source stack');
    assert.deepEqual(contents(server).slice(10), before.slice(10), 'unrelated items stay unchanged');
    const remaining = copy(source);
    remaining.count -= completedDrops;
    assert.deepEqual(Item.toNotch(bot.inventory.selectedItem), Item.toNotch(remaining));
    assert.deepEqual(Item.toNotch(server.selectedItem), Item.toNotch(remaining));
    const owned = bot.inventory.items().filter(i => i.type === source.type).reduce((sum, i) => sum + i.count, 0)
      + bot.inventory.selectedItem.count;
    assert.equal(owned, 64 - completedDrops);
    assert.equal(dropped.reduce((sum, i) => sum + i.count, 0), completedDrops);
    assert.equal(recipient.reduce((sum, i) => sum + i.count, 0), completedDrops);
    if (completedDrops) {
      assert.deepEqual(result.item_transfer, { item: 'cobblestone', requested: 2, tossed: 1, pickup_confirmed: true });
      assert.equal(actionOutcomeFailed(result), false, 'real partial progress must not invite replay');
      assert.match(result.result, /stopped after 1 of 2: outside click rejected/i);
    } else {
      assert.equal(result.item_transfer, undefined, 'moving a stack to the cursor is not a toss receipt');
      assert.equal(actionOutcomeFailed(result), true);
      assert.match(result.result, /couldn't toss.*outside click rejected/i);
    }
    const packetCount = packets.length;
    const next = await skills.give_to_player({ player: 'Kid', item: 'diamond', count: 1 });
    assert.equal(next.item_transfer, undefined);
    assert.equal(actionOutcomeFailed(next), true);
    assert.match(next.result, /cursor is occupied/i);
    assert.equal(packets.length, packetCount, 'the next gift refuses to borrow the retained cursor');
    assert.deepEqual(Item.toNotch(bot.inventory.selectedItem), Item.toNotch(remaining));
  });
}

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

for (const count of [1, 12]) {
  test(`an open chest cannot receive player-inventory gift clicks (source count ${count})`, async () => {
    const { bot, server, packets, recipient, openChest } = inventoryBot({ count });
    const chest = openChest(), before = contents(chest), inventory = contents(server);
    const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
    assert.deepEqual(contents(chest), before);
    assert.deepEqual(contents(server), inventory);
    assert.equal(chest.slots[9].count, 10);
    assert.deepEqual(packets, []);
    assert.deepEqual(recipient, []);
    assert.equal(result.item_transfer, undefined);
    assert.match(result.result, /window|container/i);
  });
}

for (const stage of ['navigation', 'look']) {
  test(`a chest opened during awaited ${stage} prevents any gift click`, async () => {
    const { bot, server, packets, openChest } = inventoryBot();
    let finish;
    const pause = () => new Promise(resolve => { finish = resolve; });
    if (stage === 'navigation') bot.pathfinder.goto = pause;
    else bot.lookAt = pause;
    const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
    await new Promise(resolve => setImmediate(resolve));
    const chest = openChest(), before = contents(chest), inventory = contents(server);
    finish();
    const result = await pending;
    assert.deepEqual(contents(chest), before);
    assert.deepEqual(contents(server), inventory);
    assert.deepEqual(packets, []);
    assert.equal(result.item_transfer, undefined);
    assert.match(result.result, /window|container/i);
  });
}

test('a container opening between repeated native drops preserves the chest and partial receipt', async () => {
  const { bot, server, packets, recipient, openChest } = inventoryBot();
  let chest, before;
  bot.once('playerCollect', () => { chest = openChest(); before = contents(chest); });
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 2 });
  assert.deepEqual(contents(chest), before);
  assert.equal(server.slots[9].count, 11);
  assert.equal(packets.length, 1);
  assert.equal(recipient.reduce((sum, item) => sum + item.count, 0), 1);
  assert.equal(bot.inventory.selectedItem, null);
  assert.equal(chest.selectedItem, null);
  assert.deepEqual(result.item_transfer, { item: 'stone_pickaxe', requested: 2, tossed: 1, pickup_confirmed: true });
  assert.match(result.result, /window|container/i);
});

test('a stop during the native hotbar dig cooldown cannot drop a tool', async () => {
  const { bot, server, packets, recipient } = inventoryBot({ sourceSlot: 36 });
  const before = contents(server);
  bot.lastDigTime = Date.now();
  const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
  const stop = setTimeout(() => { bot._stopGeneration = 1; bot.interrupt_code = true; }, 20);
  try {
    const result = await pending;
    assert.deepEqual(contents(server), before);
    assert.deepEqual(packets, []);
    assert.deepEqual(recipient, []);
    assert.equal(result.item_transfer, undefined);
    assert.match(result.result, /interrupted/i);
  } finally { clearTimeout(stop); }
});

test('a chest opened during the native hotbar dig cooldown receives no gift clicks', async () => {
  const { bot, server, packets, openChest } = inventoryBot({ sourceSlot: 36 });
  const inventory = contents(server);
  let chest, before;
  bot.lastDigTime = Date.now();
  const pending = registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
  const open = setTimeout(() => { chest = openChest(); before = contents(chest); }, 20);
  try {
    const result = await pending;
    assert.deepEqual(contents(chest), before);
    assert.deepEqual(contents(server), inventory);
    assert.deepEqual(packets, []);
    assert.equal(result.item_transfer, undefined);
    assert.match(result.result, /window|container/i);
  } finally { clearTimeout(open); }
});

test('an undisturbed hotbar cooldown settles before exactly one component-preserving drop', async () => {
  const { bot, server, packets, recipient } = inventoryBot({ sourceSlot: 36 });
  const before = contents(server);
  bot.lastDigTime = Date.now();
  const digTime = bot.lastDigTime;
  const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
  assert.ok(Date.now() - digTime >= 500);
  assert.equal(bot.lastDigTime, digTime, 'the cooldown is observed, never reset');
  const expected = structuredClone(before);
  expected[36].itemCount = 11;
  assert.deepEqual(contents(server), expected);
  assert.equal(server.selectedItem, null);
  assert.equal(bot.inventory.selectedItem, null);
  assert.equal(recipient.length, 1);
  const given = structuredClone(before[36]);
  given.itemCount = 1;
  assert.deepEqual(Item.toNotch(recipient[0]), given);
  assert.deepEqual(packets.map(p => [p.slot, p.mouseButton, p.mode]), [[36, 0, 4]]);
  assert.equal(result.item_transfer.tossed, 1);
  assert.equal(result.item_transfer.pickup_confirmed, true);
});

test('continuing digs fail closed within a bounded cooldown wait', async () => {
  const { bot, server, packets } = inventoryBot({ sourceSlot: 36 });
  const before = contents(server);
  bot.lastDigTime = Date.now();
  const digging = setInterval(() => { bot.lastDigTime = Date.now(); }, 20);
  const start = performance.now();
  try {
    const result = await registerHighLevelSkills({}, () => bot).give_to_player({ player: 'Kid', item: 'stone_pickaxe', count: 1 });
    assert.ok(performance.now() - start < 1500, 'busy digging must not hold the gift indefinitely');
    assert.deepEqual(contents(server), before);
    assert.deepEqual(packets, []);
    assert.equal(result.item_transfer, undefined);
    assert.match(result.result, /cooldown did not settle/i);
  } finally { clearInterval(digging); }
});
