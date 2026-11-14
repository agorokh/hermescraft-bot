import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { registerHighLevelSkills } from '../lib/skills.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.11');
const Item = require('prismarine-item')(registry);
const inventoryPlugin = require('mineflayer/lib/plugins/inventory');
const simpleInventoryPlugin = require('mineflayer/lib/plugins/simple_inventory');
const windows = require('prismarine-windows')(registry);
const packetEvents = ['held_item_slot', 'set_slot', 'set_player_inventory', 'set_cursor_item', 'window_items'];
const privateMarker = 'PRIVATE_ITEM_COMPONENT_MUST_NOT_APPEAR';
const copy = item => Item.fromNotch(structuredClone(Item.toNotch(item)));
// Named/count variant from the isolated real-Paper reproduction, not original NBT.
const paperStock = [['iron_axe',19],['torch',64],['cobblestone',64],['smooth_basalt',4],['bread',64],
  ['stone_pickaxe',1],['diamond',1],['cobbled_deepslate',64],['raw_iron',1],['torch',64],['stone_pickaxe',1],
  ['compass',1],['cobbled_deepslate',64],['cobbled_deepslate',64],['iron_axe',1],['redstone',48],['redstone',64],
  ['oak_log',20],['campfire',5],['oak_planks',64],['redstone',64],['bread',64],['cobbled_deepslate',64],
  ['iron_axe',64],['bread',64],['cobbled_deepslate',64],['bread',64],['iron_pickaxe',31],['torch',64],
  ['iron_pickaxe',1],['torch',64],['stone_pickaxe',19],['cobblestone',64],['cobblestone',64],['torch',64],['torch',64]];

// World/walking are in-memory; inventory prediction, equip, click semantics
// and inbound packet handlers are the installed Mineflayer implementations.
function physicalInventoryBot({ paper = false } = {}) {
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.version = '1.21.11';
  bot.supportFeature = name => registry.supportFeature(name);
  bot._client = new EventEmitter();
  bot._client.write = () => {};
  bot.username = 'Steve';
  bot.entity = { position: new Vec3(.5, 64, .5) };
  bot.players = {};
  bot.health = 20;
  inventoryPlugin(bot, { hideErrors: false });
  simpleInventoryPlugin(bot);
  bot.quickBarSlot = 0;
  for (let slot = 9; slot < 45; slot++) {
    bot.inventory.updateSlot(slot, new Item(registry.itemsByName.cobblestone.id, 64));
  }
  bot.inventory.updateSlot(9, new Item(registry.itemsByName.oak_log.id, 20));
  bot.inventory.updateSlot(10, new Item(registry.itemsByName.campfire.id, 5));
  bot.inventory.updateSlot(44, new Item(registry.itemsByName.diamond.id, 3));
  bot.inventory.slots[11].components = [{ type: 'custom_data', data: { type: 'compound', value: {
    private: { type: 'string', value: privateMarker },
  } } }];
  bot.inventory.slots[36].components = structuredClone(bot.inventory.slots[11].components);
  if (paper) {
    paperStock.forEach(([name, count], i) => bot.inventory.updateSlot(9 + i, new Item(registry.itemsByName[name].id, count)));
    bot.quickBarSlot = 4;
  }
  const server = windows.createWindow(0, 'minecraft:inventory', 'Server inventory');
  bot.inventory.slots.forEach((item, slot) => server.updateSlot(slot, item && copy(item)));
  bot.server = server;
  bot.packets = [];
  let clamped = false;
  bot._client.write = (name, packet) => {
    if (name !== 'window_click') return;
    bot.packets.push(packet);
    // Replay the observed Paper correction for returning an unsupported stack
    // to an empty source slot. Client prediction remains genuine Mineflayer.
    if (paper && packet.mode === 0 && !server.slots[packet.slot]
        && server.selectedItem?.count > server.selectedItem.stackSize) {
      const accepted = copy(server.selectedItem);
      accepted.count = accepted.stackSize;
      server.selectedItem.count -= accepted.count;
      server.updateSlot(packet.slot, accepted);
      clamped = true;
      bot._client.emit('set_slot', { windowId: 0, stateId: 5, slot: packet.slot, item: Item.toNotch(accepted) });
      bot._client.emit('set_cursor_item', { contents: Item.toNotch(server.selectedItem) });
    } else if (!clamped) server.acceptClick({ ...packet, item: server.slots[packet.slot] });
    bot.afterInventoryClick?.(packet);
  };
  bot.blocks = new Map();
  bot.placements = [];
  bot.blockAt = position => {
    const name = bot.blocks.get(`${position.x},${position.y},${position.z}`) || (position.y < 64 ? 'stone' : 'air');
    return { name, type: registry.blocksByName[name].id, position: position.clone(),
      boundingBox: ['air', 'campfire'].includes(name) ? 'empty' : 'block', getProperties: () => ({}) };
  };
  bot.pathfinder = {
    movements: new pathfinderPkg.Movements(bot), goal: null,
    setMovements(value) { this.movements = value; },
    setGoal(goal) { this.goal = goal; },
    async goto(goal) {
      this.goal = goal;
      bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
      this.goal = null;
    },
  };
  bot.clearControlStates = () => {};
  bot.chat = () => {};
  bot.lookAt = async () => {};
  bot.waitForTicks = async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (clamped && bot.placements.length === 1) {
      bot._client.emit('window_items', { windowId: 0, stateId: 9,
        items: server.slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(server.selectedItem) });
    }
  };
  bot.placeBlock = async (reference, face) => {
    const target = reference.position.plus(face);
    bot.blocks.set(`${target.x},${target.y},${target.z}`, bot.heldItem.name);
    bot.placements.push({ target, item: bot.heldItem.name });
    const held = bot.heldItem;
    const remaining = Item.fromNotch(structuredClone(Item.toNotch(held)));
    remaining.count--;
    bot.inventory.updateSlot(held.slot, remaining.count ? remaining : null);
    server.updateSlot(held.slot, remaining.count ? copy(remaining) : null);
  };
  return bot;
}

test('the real-Paper oversized-tool clamp replay builds13 cells without evicting unsupported hotbar stacks', async () => {
  const bot = physicalInventoryBot({ paper: true });
  const protectedSlots = [9, 32, 36, 40];
  const before = protectedSlots.map(slot => structuredClone(Item.toNotch(bot.inventory.slots[slot])));
  const counts = () => Object.fromEntries(['cobblestone', 'oak_log', 'campfire'].map(name => [name,
    bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)]));
  const stock = counts();
  const { result, diagnostics, logs } = await build(bot);
  assert.match(result.result, /13\/13 blocks placed/);
  assert.equal(bot.placements.length, 13);
  assert.equal(bot.placements.at(-1).item, 'campfire');
  assert.deepEqual(counts(), { cobblestone: stock.cobblestone - 8, oak_log: stock.oak_log - 4, campfire: stock.campfire - 1 });
  assert.deepEqual(protectedSlots.map(slot => Item.toNotch(bot.inventory.slots[slot])), before);
  for (const name of new Set(paperStock.map(([name]) => name))) {
    if (['cobblestone', 'oak_log', 'campfire'].includes(name)) continue;
    assert.equal(bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0),
      paperStock.filter(([item]) => item === name).reduce((sum, [,count]) => sum + count, 0), `${name} is preserved`);
  }
  assert.equal(bot.inventory.selectedItem, null);
  assert.equal(bot.server.selectedItem, null);
  assert.ok(bot.packets.every(packet => packet.mode === 2 && !protectedSlots.includes(36 + packet.mouseButton)));
  assert.deepEqual(diagnostics, []);
  assert.equal(logs.filter(line => line.startsWith('[physical-build] ')).length, 39);
});

for (const invalid of ['all hotbar stacks oversized', 'unknown slots', 'unknown stack limit', 'oversized material', 'container', 'cursor']) {
  test(`physical equip refuses ${invalid} before inventory mutation`, async () => {
    const bot = physicalInventoryBot({ paper: true });
    if (invalid === 'all hotbar stacks oversized') {
      for (let slot = 36; slot < 45; slot++) bot.inventory.updateSlot(slot, new Item(registry.itemsByName.iron_pickaxe.id, 31));
    } else if (invalid === 'unknown slots') bot.inventory.hotbarStart = undefined;
    else if (invalid === 'unknown stack limit') bot.inventory.slots[26].stackSize = undefined;
    else if (invalid === 'oversized material') bot.inventory.slots[26].count = 65;
    else if (invalid === 'container') bot.currentWindow = windows.createWindow(7, 'minecraft:generic_9x3', 'Chest');
    else bot.inventory.selectedItem = new Item(registry.itemsByName.diamond.id, 1);
    const before = bot.inventory.slots.map(item => Item.toNotch(item));
    const cursor = Item.toNotch(bot.inventory.selectedItem);
    const { result } = await build(bot);
    assert.equal(result.site_refused, true);
    assert.equal(bot.placements.length, 0);
    assert.deepEqual(bot.packets, []);
    assert.deepEqual(bot.inventory.slots.map(item => Item.toNotch(item)), before);
    assert.deepEqual(Item.toNotch(bot.inventory.selectedItem), cursor);
  });
}

test('an empty known hotbar slot accepts one native atomic material swap', async () => {
  const bot = physicalInventoryBot({ paper: true });
  bot.inventory.updateSlot(37, null);
  bot.server.updateSlot(37, null);
  const { result } = await build(bot);
  assert.match(result.result, /13\/13 blocks placed/);
  assert.deepEqual([bot.packets[0].slot, bot.packets[0].mouseButton, bot.packets[0].mode], [26, 1, 2]);
  assert.equal(bot.inventory.slots[36].count, 31);
  assert.equal(bot.inventory.selectedItem, null);
});

for (const change of ['stop', 'container', 'server cursor']) {
  test(`physical equip stops after an atomic swap when ${change} changes across its await`, async () => {
    const bot = physicalInventoryBot({ paper: true });
    bot.afterInventoryClick = () => {
      if (change === 'stop') bot._stopGeneration = 1;
      else if (change === 'container') bot.currentWindow = windows.createWindow(7, 'minecraft:generic_9x3', 'Chest');
      else bot._client.emit('set_cursor_item', { contents: Item.toNotch(new Item(registry.itemsByName.iron_pickaxe.id, 30)) });
    };
    const { result } = await build(bot);
    assert.equal(result.site_refused, true);
    assert.equal(bot.placements.length, 0);
    assert.equal(bot.packets.length, 1);
    assert.equal(bot.packets[0].mode, 2);
    assert.equal(bot.inventory.selectedItem, null);
  });
}

for (const [label, components, removed, allowed] of [
  ['known override', [{ type: 'max_stack_size', data: 32 }], [], true],
  ['lower override', [{ type: 'max_stack_size', data: 16 }], [], false],
  ['malformed override', [{ type: 'max_stack_size', data: {} }], [], false],
  ['duplicate override', [{ type: 'max_stack_size', data: 32 }, { type: 'max_stack_size', data: 64 }], [], false],
  ['removed limit', [], ['max_stack_size'], false],
]) {
  test(`physical material stack limits respect a ${label}`, async () => {
    const bot = physicalInventoryBot({ paper: true });
    bot.inventory.slots[26].components = components;
    bot.inventory.slots[26].removedComponents = removed;
    bot.server.updateSlot(26, copy(bot.inventory.slots[26]));
    const { result } = await build(bot);
    if (allowed) assert.match(result.result, /13\/13 blocks placed/);
    else {
      assert.equal(result.site_refused, true);
      assert.equal(bot.placements.length, 0);
      assert.deepEqual(bot.packets, []);
    }
  });
}

test('atomic physical equip preserves material and displaced-stack components', async () => {
  const bot = physicalInventoryBot({ paper: true });
  const components = [{ type: 'custom_data', data: { type: 'compound', value: {
    marker: { type: 'string', value: privateMarker },
  } } }];
  for (const slot of [26, 37]) {
    bot.inventory.slots[slot].components = structuredClone(components);
    bot.server.updateSlot(slot, copy(bot.inventory.slots[slot]));
  }
  const { result } = await build(bot);
  assert.match(result.result, /13\/13 blocks placed/);
  const torch = bot.inventory.items().find(item => item.name === 'torch' && item.components.length);
  const log = bot.inventory.items().find(item => item.name === 'oak_log');
  assert.equal(torch.count, 64);
  assert.equal(log.count, 16);
  assert.deepEqual(torch.components, components);
  assert.deepEqual(log.components, components);
});

test('a valid matching hotbar material avoids an oversized source of the same material', async () => {
  const bot = physicalInventoryBot({ paper: true });
  bot.inventory.slots[26].count = 65;
  bot.server.updateSlot(26, copy(bot.inventory.slots[26]));
  const logs = new Item(registry.itemsByName.oak_log.id, 20);
  bot.inventory.updateSlot(38, logs);
  bot.server.updateSlot(38, copy(logs));
  const { result } = await build(bot);
  assert.match(result.result, /13\/13 blocks placed/);
  assert.equal(bot.inventory.slots[26].count, 65);
  assert.ok(bot.packets.every(packet => packet.slot !== 26));
});

const listeners = bot => [bot.listenerCount('heldItemChanged'), ...packetEvents.map(name => bot._client.listenerCount(name))];
async function build(bot) {
  const prior = process.env.HERMESCRAFT_PHYSICAL_BUILDS;
  process.env.HERMESCRAFT_PHYSICAL_BUILDS = '1';
  const logs = [], log = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const result = await registerHighLevelSkills({}, () => bot).build_schematic({ name: 'campfire_spot', x: 10, y: 64, z: 10 });
    return { result, logs, diagnostics: logs.filter(line => line.startsWith('[physical-hand-state] '))
      .map(line => JSON.parse(line.slice('[physical-hand-state] '.length))) };
  } finally {
    console.log = log;
    if (prior == null) delete process.env.HERMESCRAFT_PHYSICAL_BUILDS;
    else process.env.HERMESCRAFT_PHYSICAL_BUILDS = prior;
  }
}

for (const packet of ['set_player_inventory', 'burst', 'set_slot', 'window_items']) {
  test(`hypothetical inbound ${packet} hand changes refuse the second placement and produce bounded diagnostics`, async () => {
    const bot = physicalInventoryBot(), before = listeners(bot);
    const flood = packet === 'burst';
    let injected = false;
    bot.waitForTicks = async () => {
      await new Promise(resolve => setImmediate(resolve));
      if (bot.placements.length !== 1 || injected) return;
      injected = true;
      const carried = new Item(registry.itemsByName.iron_pickaxe.id, 30);
      carried.components = structuredClone(bot.inventory.slots[11].components);
      bot._client.emit('set_cursor_item', { contents: Item.toNotch(carried), privateMarker });
      bot._client.emit('held_item_slot', { slot: 8, privateMarker });
      for (let i = 0; i < (flood ? 24 : 1); i++) {
        const item = Item.toNotch(new Item(registry.itemsByName.diamond.id, 4 + i));
        if (packet === 'set_slot') {
          bot._client.emit('set_slot', { windowId: 0, stateId: 2, slot: 44, item, privateMarker });
        } else if (packet === 'window_items') {
          const items = bot.inventory.slots.map(item => Item.toNotch(item));
          items[44] = item;
          bot._client.emit('window_items', { windowId: 0, stateId: 2, items,
            carriedItem: Item.toNotch(carried), privateMarker });
        } else bot._client.emit('set_player_inventory', { slotId: 44, contents: item, privateMarker });
        if (flood) bot._client.emit('set_cursor_item', { contents: Item.toNotch(carried) });
      }
    };
    const { result, logs, diagnostics } = await build(bot);
    assert.equal(bot.placements.length, 1, 'the guard prevents a second placement');
    assert.equal(result.site_refused, true);
    assert.match(result.result, /held building material changed/);
    assert.equal(diagnostics.length, 1);
    const trace = diagnostics[0];
    assert.equal(trace.expected, 'cobblestone');
    assert.equal(trace.beforeEquip.held.name, 'oak_log');
    assert.equal(trace.afterEquip.held.name, 'cobblestone');
    assert.equal(trace.current.held.name, 'diamond');
    assert.equal(trace.current.held.count, flood ? 27 : 4);
    assert.equal(trace.current.held.slot, 44);
    assert.equal(trace.current.quickBarSlot, 8);
    assert.equal(trace.current.windowId, 0);
    assert.equal(trace.current.cursor, null);
    assert.equal(trace.sourceSlot, 37);
    assert.equal(trace.serverCursor.name, 'iron_pickaxe');
    assert.equal(trace.serverCursor.count, 30);
    assert.ok(trace.events.some(event => event.serverCursor?.count === 30 && event.state.cursor === null),
      'actual packet cursor stays distinct from the SDK-predicted empty cursor');
    assert.equal(typeof trace.target.x, 'number');
    assert.ok(trace.events.length <= 16);
    const expectedEvent = flood ? 'set_player_inventory' : packet;
    assert.ok(trace.events.some(event => event.event === expectedEvent
      && (packet === 'window_items' ? event.windowId === 0 : event.slot === 44)));
    if (['set_slot', 'window_items'].includes(packet)) {
      assert.ok(trace.events.some(event => event.event === packet && event.stateId === 2));
    }
    if (flood) assert.ok(trace.eventsDropped > 0);
    else assert.ok(trace.events.some(event => event.event === 'held_item_slot' && event.slot === 8));
    for (const event of trace.events) {
      assert.ok(!event.stack || event.stack.length <= 6);
      assert.ok(!event.stack || event.stack.every(frame => frame.length <= 200));
      assert.ok(!event.stack || event.stack.every(frame => !frame.includes('file:///') && !frame.includes('/Users/')));
    }
    assert.ok(trace.events.some(event => event.event === 'heldItemChanged'
      && event.stack.some(frame => /inventory\.js:\d/.test(frame))), 'native handler caller hints remain useful after sanitizing');
    assert.ok(!logs.join('\n').includes(privateMarker), 'components and raw packet extras never enter diagnostics');
    assert.ok(!JSON.stringify(trace).includes('components'));
    assert.deepEqual(listeners(bot), before);
    assert.equal(logs.filter(line => line.startsWith('[physical-build] ')).length, 4,
      'the three first-cell receipts and second approach keep their existing prefix');
  });
}

for (const outcome of ['success', 'equip error', 'stop']) {
  test(`hand diagnostics clean up all scoped listeners after ${outcome}`, async () => {
    const bot = physicalInventoryBot(), before = listeners(bot);
    if (outcome === 'equip error') bot.inventory.acceptClick = () => { throw new Error('native equip click rejected'); };
    if (outcome === 'stop') bot.waitForTicks = async () => { bot._stopGeneration = 1; };
    const { result, diagnostics, logs } = await build(bot);
    assert.deepEqual(listeners(bot), before);
    assert.deepEqual(diagnostics, [], 'no mismatch means no hand-state log');
    if (outcome === 'success') {
      assert.equal(bot.placements.length, 13);
      assert.match(result.result, /13\/13 blocks placed/);
      assert.equal(logs.filter(line => line.startsWith('[physical-build] ')).length, 39);
    } else {
      assert.equal(bot.placements.length, 0);
      assert.equal(result.site_refused, true);
    }
  });
}
