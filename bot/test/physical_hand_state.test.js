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
const packetEvents = ['held_item_slot', 'set_slot', 'set_player_inventory', 'window_items'];
const privateMarker = 'PRIVATE_ITEM_COMPONENT_MUST_NOT_APPEAR';

// World/walking are in-memory; inventory prediction, equip, click semantics
// and inbound packet handlers are the installed Mineflayer implementations.
function physicalInventoryBot() {
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
  bot.waitForTicks = async () => { await new Promise(resolve => setImmediate(resolve)); };
  bot.placeBlock = async (reference, face) => {
    const target = reference.position.plus(face);
    bot.blocks.set(`${target.x},${target.y},${target.z}`, bot.heldItem.name);
    bot.placements.push({ target, item: bot.heldItem.name });
    const held = bot.heldItem;
    const remaining = Item.fromNotch(structuredClone(Item.toNotch(held)));
    remaining.count--;
    bot.inventory.updateSlot(held.slot, remaining.count ? remaining : null);
  };
  return bot;
}

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
      bot._client.emit('held_item_slot', { slot: 8, privateMarker });
      for (let i = 0; i < (flood ? 24 : 1); i++) {
        const item = Item.toNotch(new Item(registry.itemsByName.diamond.id, 4 + i));
        if (packet === 'set_slot') {
          bot._client.emit('set_slot', { windowId: 0, stateId: 2, slot: 44, item, privateMarker });
        } else if (packet === 'window_items') {
          const items = bot.inventory.slots.map(item => Item.toNotch(item));
          items[44] = item;
          bot._client.emit('window_items', { windowId: 0, stateId: 2, items, privateMarker });
        } else bot._client.emit('set_player_inventory', { slotId: 44, contents: item, privateMarker });
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
    assert.equal(trace.sourceSlot, 9);
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
