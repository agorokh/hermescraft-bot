// Creative-studio hand building with flight (agorokh/hermescraft#592).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { registerHighLevelSkills } from '../lib/skills.js';
import { flyToPhysicalPlacement, orderForHandPlacement, planFlight, segmentClear } from '../lib/studio_flight.js';
import { buildStateFileForId, loadBuildState } from '../lib/advanced_build_pipeline.js';
import { rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stacks set aside for a build are noted here, never in the real home directory.
process.env.HERMESCRAFT_STUDIO_BORROW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-studio-borrow-'));
const borrowFile = name => path.join(process.env.HERMESCRAFT_STUDIO_BORROW_DIR, `${name}.json`);

const registry = minecraftData('1.21.11');
const { Movements } = pathfinderPkg;
const GROUND_Y = 63; // top solid layer; builds start at y=64

class StudioBot extends EventEmitter {
  constructor({ gameMode = 'creative' } = {}) {
    super();
    this.registry = registry;
    this.username = 'Rosie';
    this.game = { gameMode };
    this.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) };
    this.players = { Rosie: { entity: this.entity } };
    this.blocks = new Map();
    this.trace = [];
    this.quickBarSlot = 0;
    const slots = Array(46).fill(null);
    this.inventory = { id: 0, inventoryStart: 9, inventoryEnd: 45, hotbarStart: 36, selectedItem: null,
      slots, items: () => slots.filter(Boolean) };
    this.creative = {
      flyTo: async destination => {
        this.trace.push({ kind: 'fly', from: this.entity.position.clone(), to: destination.clone() });
        if (!segmentClear(this, this.entity.position, destination)) this.flewThroughBlock = true;
        if (!this.rubberBand) this.entity.position = destination.clone();
      },
      setInventorySlot: async (slot, item) => {
        this.trace.push({ kind: 'creative_stock', slot, item: item?.name });
        if (this.creativeRefused) throw new Error('Server rejected');
        if (item) item.slot = slot;
        slots[slot] = item;
      },
      startFlying: () => { this.flying = true; },
      stopFlying: () => { this.flying = false; this.trace.push({ kind: 'land', position: this.entity.position.clone() }); },
    };
    this._client = { write: (name, data) => this.trace.push({ kind: 'packet', name, data }) };
    this.pathfinder = {
      movements: new Movements(this), goal: null,
      setMovements: value => { this.pathfinder.movements = value; },
      setGoal: goal => { this.pathfinder.goal = goal; },
      goto: async goal => {
        this.trace.push({ kind: 'walk', goal });
        this.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
      },
    };
  }
  blockAt(p) {
    const name = this.blocks.get(`${p.x},${p.y},${p.z}`) || (p.y <= GROUND_Y ? 'grass_block' : 'air');
    return { name, type: registry.blocksByName[name]?.id, position: p.clone(),
      boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => ({}) };
  }
  chat(text) { this.trace.push({ kind: 'chat', text }); }
  get heldItem() { return this.inventory.slots[36 + this.quickBarSlot]; }
  setQuickBarSlot(slot) { this.quickBarSlot = slot; }
  async clickWindow() { throw new Error('a studio stack is always put in the hotbar'); }
  async lookAt() {}
  async waitForTicks() {}
  clearControlStates() {}
  async placeBlock(reference, face) {
    const target = reference.position.plus(face);
    const eye = this.entity.position.offset(0, 1.62, 0);
    this.trace.push({ kind: 'hand', target, position: this.entity.position.clone(), item: this.heldItem?.name,
      reach: eye.distanceTo(target.offset(.5, .5, .5)), flying: this.flying });
    if (this.missNext > 0) { this.missNext--; return; }
    this.blocks.set(`${target.x},${target.y},${target.z}`, this.heldItem.name);
  }
}

async function studio(bot, body, { flight = '1', physical = '1' } = {}) {
  const env = { HERMESCRAFT_PHYSICAL_BUILDS: physical, HERMESCRAFT_STUDIO_FLIGHT: flight,
    HERMESCRAFT_TRUST_SETBLOCK_AUTH: '1', HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK: '1' };
  const prior = Object.keys(env).map(k => process.env[k]);
  Object.entries(env).forEach(([k, v]) => { if (v == null) delete process.env[k]; else process.env[k] = v; });
  try {
    return await registerHighLevelSkills({}, () => bot).build_schematic(body);
  } finally {
    Object.keys(env).forEach((k, i) => { if (prior[i] == null) delete process.env[k]; else process.env[k] = prior[i]; });
  }
}

const FLAGPOLE = { name: 'flagpole', x: 10, y: 64, z: 10 };
const hands = bot => bot.trace.filter(e => e.kind === 'hand');
const commands = bot => bot.trace.filter(e => e.kind === 'chat' && e.text.startsWith('/'));

test('a creative character flies up and hand-places all 20 flagpole blocks to 17 high', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /Built schematic "flagpole" at 10,64,10 — 20\/20 blocks placed via physical placement \(flight\)/);
  assert.equal(hands(bot).length, 20);
  assert.equal(Math.max(...hands(bot).map(e => e.target.y)), 80);
  assert.ok(hands(bot).every(e => e.flying && e.reach <= 4.01), 'every block is placed from a hover within hand reach');
  assert.ok(hands(bot).some(e => e.position.y >= 76), 'the character really is high up for the top blocks');
  for (let dy = 0; dy < 17; dy++) assert.equal(bot.blocks.get(`10,${64 + dy},10`), 'smooth_quartz');
  assert.deepEqual(['11,79,10', '11,80,10', '12,80,10'].map(k => bot.blocks.get(k)), ['red_wool', 'red_wool', 'red_wool']);
});

test('studio flight never issues a command, never walks a path, never flies through a block', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  await studio(bot, FLAGPOLE);
  assert.deepEqual(commands(bot), []);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'walk'), []);
  assert.notEqual(bot.flewThroughBlock, true);
  assert.ok(bot.trace.filter(e => e.kind === 'fly').length >= 3);
  // The body is never parked in a cell the design still has to fill.
  const cells = new Set([...Array(17).keys()].map(dy => `10,${64 + dy},10`).concat(['11,79,10', '11,80,10', '12,80,10']));
  for (const e of hands(bot)) {
    const p = e.position.floored();
    assert.ok(!cells.has(`${p.x},${p.y},${p.z}`) && !cells.has(`${p.x},${p.y + 1},${p.z}`));
  }
});

test('materials come from the creative inventory, one stack per material', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  await studio(bot, FLAGPOLE);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'creative_stock' && e.item).map(e => e.item), ['smooth_quartz', 'red_wool']);
  assert.ok(hands(bot).every(e => ['smooth_quartz', 'red_wool'].includes(e.item)));
});

test('creative materials are handed back, and nothing the character carried is touched', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit = { name: 'campfire', count: 1, slot: 36, type: registry.itemsByName.campfire.id, stackSize: 64,
    components: [], removedComponents: [] };
  bot.inventory.slots[36] = kit;
  await studio(bot, FLAGPOLE);
  assert.deepEqual(bot.inventory.items(), [kit]);
  assert.ok(bot.trace.filter(e => e.kind === 'creative_stock').every(e => e.slot !== 36));
});

test('a full hotbar with nothing plain to set aside is refused rather than overwritten', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  for (let slot = 36; slot <= 44; slot++) {
    // A named stack: putting back a bare stack of the same type would lose the name.
    bot.inventory.slots[slot] = { name: 'campfire', count: 1, slot, type: registry.itemsByName.campfire.id,
      stackSize: 64, components: [{ type: 'custom_name', data: 'Gift' }], removedComponents: [] };
  }
  const result = await studio(bot, FLAGPOLE);
  assert.equal(result.site_refused, true);
  assert.match(result.result, /no empty hotbar slot/);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'creative_stock'), []);
  assert.equal(bot.inventory.items().length, 9);
  assert.equal(fs.existsSync(borrowFile('Rosie')), false);
});

// What a character has carried for weeks on the family server: all 36 slots full.
function fullInventory(bot) {
  const names = ['oak_log', 'cobblestone', 'bread', 'torch', 'oak_planks', 'campfire'];
  const kit = [];
  for (let slot = 9; slot <= 44; slot++) {
    const name = names[slot % names.length];
    bot.inventory.slots[slot] = { name, count: 1 + (slot % 60), slot, type: registry.itemsByName[name].id,
      stackSize: 64, components: [], removedComponents: [] };
    kit.push({ slot, name, count: 1 + (slot % 60) });
  }
  return kit;
}
const carried = bot => bot.inventory.items().map(({ slot, name, count }) => ({ slot, name, count }));

test('a full inventory sets one plain hotbar stack aside and gives the same stack back', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit = fullInventory(bot);
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /20\/20 blocks placed via physical placement \(flight\)/);
  const stocked = bot.trace.filter(e => e.kind === 'creative_stock');
  assert.ok(stocked.every(e => e.slot === 44), 'only the one set-aside slot is ever written');
  assert.deepEqual(carried(bot), kit, 'every slot holds what it held before, same type and count');
  assert.equal(fs.existsSync(borrowFile('Rosie')), false, 'nothing is left waiting to be given back');
});

test('a stack set aside by a body that died mid-build goes back at the next studio build', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit = fullInventory(bot);
  const kit44 = kit.find(k => k.slot === 44);
  // The previous process put red wool where that stack was, then died.
  bot.inventory.slots[44] = { name: 'red_wool', count: 64, slot: 44, type: registry.itemsByName.red_wool.id,
    stackSize: 64, components: [], removedComponents: [] };
  fs.writeFileSync(borrowFile('Rosie'), JSON.stringify({ ...kit44, materials: ['red_wool'] }));
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /20\/20 blocks placed/);
  assert.deepEqual(stockedNames(bot)[0], { slot: 44, item: kit44.name }, 'the stack goes back before anything is stocked');
  assert.deepEqual(carried(bot), kit);
  assert.equal(fs.existsSync(borrowFile('Rosie')), false);
});
const stockedNames = bot => bot.trace.filter(e => e.kind === 'creative_stock').map(({ slot, item }) => ({ slot, item }));

test('a set-aside stack that cannot be given back stays noted for the next build', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit44 = fullInventory(bot).find(k => k.slot === 44);
  const original = bot.creative.setInventorySlot;
  let writes = 0;
  bot.creative.setInventorySlot = async (slot, item) => {
    writes++;
    if (writes > 1) bot.creativeRefused = true; // switched to survival after the first stock
    return original(slot, item);
  };
  await studio(bot, FLAGPOLE);
  const record = JSON.parse(fs.readFileSync(borrowFile('Rosie'), 'utf8'));
  assert.equal(record.slot, 44);
  assert.equal(record.name, kit44.name);
  assert.equal(record.count, kit44.count);
  // Back in creative: the next studio build returns it first.
  bot.creativeRefused = false;
  bot.creative.setInventorySlot = original;
  bot.blocks.clear();
  await studio(bot, FLAGPOLE);
  assert.equal(bot.inventory.slots[44].name, kit44.name);
  assert.equal(bot.inventory.slots[44].count, kit44.count);
  assert.equal(fs.existsSync(borrowFile('Rosie')), false);
});

test('a give-back whose readback timed out is not repeated after some of the stack is used', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit44 = fullInventory(bot).find(k => k.slot === 44);
  // The give-back reached the server; the record still says it was in flight.
  // Since then the survival tick used 3 of the stack.
  bot.inventory.slots[44] = { name: kit44.name, count: kit44.count - 3, slot: 44, type: registry.itemsByName[kit44.name].id,
    stackSize: 64, components: [], removedComponents: [] };
  fs.writeFileSync(borrowFile('Rosie'), JSON.stringify({ ...kit44, materials: ['smooth_quartz'], givingBack: true }));
  await studio(bot, FLAGPOLE);
  assert.equal(bot.inventory.items().filter(i => i.name === kit44.name && i.slot !== 44).length,
    fullInventory(new StudioBot()).filter(k => k.name === kit44.name && k.slot !== 44).length, 'no second copy is written');
  assert.equal(bot.inventory.slots[44].count, kit44.count - 3);
  assert.equal(fs.existsSync(borrowFile('Rosie')), false);
});

test('a same-type stack found before any give-back was sent is the character\'s own; the owed stack goes elsewhere', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit44 = fullInventory(bot).find(k => k.slot === 44);
  bot.inventory.slots[44] = { name: kit44.name, count: 5, slot: 44, type: registry.itemsByName[kit44.name].id,
    stackSize: 64, components: [], removedComponents: [] };
  bot.inventory.slots[9] = null; // one empty slot to give the owed stack back into
  fs.writeFileSync(borrowFile('Rosie'), JSON.stringify({ ...kit44, materials: ['smooth_quartz'] }));
  await studio(bot, FLAGPOLE);
  assert.equal(bot.inventory.slots[44].count, 5);
  assert.equal(bot.inventory.slots[9]?.name, kit44.name);
  assert.equal(bot.inventory.slots[9]?.count, kit44.count);
  assert.equal(fs.existsSync(borrowFile('Rosie')), false);
});

test('one free hotbar slot is enough: materials swap through the slot the build stocked itself', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  const kit = [];
  for (let slot = 36; slot <= 43; slot++) {
    bot.inventory.slots[slot] = { name: 'campfire', count: 1, slot, type: registry.itemsByName.campfire.id,
      stackSize: 64, components: [], removedComponents: [] };
    kit.push(bot.inventory.slots[slot]);
  }
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /20\/20 blocks placed via physical placement \(flight\)/);
  const stocked = bot.trace.filter(e => e.kind === 'creative_stock');
  assert.ok(stocked.every(e => e.slot === 44), 'only the one empty slot is ever written');
  assert.deepEqual([...new Set(stocked.filter(e => e.item).map(e => e.item))].sort(), ['red_wool', 'smooth_quartz']);
  assert.deepEqual(bot.inventory.items(), kit, 'the eight carried items are untouched and the stock is handed back');
});

test('the character lands beside the finished build and tells the server it stopped flying', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  await studio(bot, FLAGPOLE);
  const landing = bot.trace.filter(e => e.kind === 'land').at(-1);
  assert.equal(landing.position.y, 64);
  assert.ok(landing.position.x < 9 || landing.position.x > 14 || landing.position.z < 9 || landing.position.z > 12);
  assert.equal(bot.flying, false);
  const packets = bot.trace.filter(e => e.kind === 'packet');
  assert.deepEqual(packets[0], { kind: 'packet', name: 'abilities', data: { flags: 0x0f } });
  assert.deepEqual(packets.at(-1), { kind: 'packet', name: 'abilities', data: { flags: 0x0d } });
  assert.equal(bot._schematicBuildActive, false);
});

test('one narration line per studio build, not one per layer', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  await studio(bot, FLAGPOLE);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'chat').map(e => e.text), ["I'm building the flagpole by hand."]);
});

test('a missed block is re-placed without being asked', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  bot.missNext = 1;
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /20\/20 blocks placed/);
  assert.equal(hands(bot).length, 21);
});

test('a block that keeps failing stops the build with honest progress', { timeout: 30000 }, async () => {
  const bot = new StudioBot();
  bot.missNext = 99;
  const result = await studio(bot, FLAGPOLE);
  assert.equal(result.site_refused, true);
  assert.match(result.result, /Refused further "flagpole" placements after 0\/20 blocks/);
  assert.equal(hands(bot).length, 3);
  assert.equal(bot.flying, false);
});

test('studio flight never replaces something already built in the design space', async () => {
  const bot = new StudioBot();
  bot.blocks.set('10,70,10', 'oak_planks');
  const result = await studio(bot, FLAGPOLE);
  assert.equal(result.site_refused, true);
  assert.equal(result.site_code, 'occupied');
  assert.deepEqual(hands(bot), []);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'fly'), []);
});

test('a rerun over a finished build places nothing and reports it complete', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  await studio(bot, FLAGPOLE);
  const before = hands(bot).length;
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /20\/20 blocks placed/);
  assert.equal(hands(bot).length, before);
});

test('a server that pulls the flying body back fails the block instead of pretending', { timeout: 30000 }, async () => {
  const bot = new StudioBot();
  bot.rubberBand = true;
  bot.entity.position = new Vec3(30.5, 64, 30.5);
  const result = await studio(bot, FLAGPOLE);
  assert.equal(result.site_refused, true);
  assert.deepEqual(hands(bot), []);
});

test('a refused creative inventory request is reported, not worked around', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  bot.creativeRefused = true;
  const result = await studio(bot, FLAGPOLE);
  assert.equal(result.site_refused, true);
  assert.match(result.result, /creative inventory/);
  assert.deepEqual(commands(bot), []);
});

for (const [label, options, botOptions] of [
  ['the studio flag is off', { flight: null }, {}],
  ['the character is in survival', {}, { gameMode: 'survival' }],
]) {
  test(`no flight and no creative stock when ${label}`, { timeout: 20000 }, async () => {
    const bot = new StudioBot(botOptions);
    const result = await studio(bot, FLAGPOLE, options);
    assert.deepEqual(bot.trace.filter(e => ['fly', 'creative_stock'].includes(e.kind)), []);
    assert.doesNotMatch(result.result || '', /20\/20/);
    assert.deepEqual(commands(bot), []);
  });
}

test('unknown section names are refused with the list of real ones', async () => {
  const bot = new StudioBot();
  const result = await studio(bot, { ...FLAGPOLE, section: 'spire' });
  assert.match(result.result, /has no section "spire"/);
  assert.deepEqual(hands(bot), []);
});

test('planFlight goes around a wall instead of through it', () => {
  const bot = new StudioBot();
  for (let y = 64; y < 70; y++) for (let z = -3; z <= 3; z++) bot.blocks.set(`3,${y},${z}`, 'stone');
  const from = new Vec3(0.5, 64, 0.5), to = new Vec3(6.5, 64, 0.5);
  assert.equal(segmentClear(bot, from, to), false);
  const route = planFlight(bot, from, to);
  assert.ok(route && route.length === 3);
  let at = from;
  for (const waypoint of route) { assert.ok(segmentClear(bot, at, waypoint)); at = waypoint; }
  assert.deepEqual(at, to);
});

test('orderForHandPlacement builds outward from support and reports floating cells', () => {
  const solid = (x, y) => y < 0;
  // A beam listed far-end first: the far end only becomes placeable after its neighbours.
  const beam = [[3, 2, 0], [2, 2, 0], [1, 2, 0], [0, 0, 0], [0, 1, 0], [0, 2, 0]];
  const { ordered, floating } = orderForHandPlacement(beam, solid);
  assert.deepEqual(ordered.map(c => c.join()), ['0,0,0', '0,1,0', '0,2,0', '1,2,0', '2,2,0', '3,2,0']);
  assert.deepEqual(floating, []);
  const island = orderForHandPlacement([[0, 0, 0], [5, 5, 5]], solid);
  assert.deepEqual(island.floating, [[5, 5, 5]]);
});

test('a sectioned studio build records section build_id and resumes only remaining blocks', { timeout: 20000 }, async () => {
  const origin = { x: 40, y: 64, z: 40 };
  const stateFile = buildStateFileForId(`flagpole__pole-${origin.x}-${origin.y}-${origin.z}`);
  await rm(stateFile, { force: true });
  try {
    const bot = new StudioBot();
    let placedCount = 0;
    const origPlaceBlock = bot.placeBlock.bind(bot);
    bot.placeBlock = async (reference, face) => {
      placedCount++;
      if (placedCount > 5) return;
      await origPlaceBlock(reference, face);
    };
    const partial = await studio(bot, { name: 'flagpole', section: 'pole', ...origin, record_state: true, resume: true });
    assert.equal(partial.site_refused, true);
    const saved = await loadBuildState(stateFile);
    assert.equal(saved?.build_id, `flagpole__pole-${origin.x}-${origin.y}-${origin.z}`);
    assert.equal(saved?.completed.length, 5);

    bot.placeBlock = origPlaceBlock;
    bot.trace = [];
    const resumed = await studio(bot, { name: 'flagpole', section: 'pole', ...origin, record_state: true, resume: true });
    assert.match(resumed.result, /17\/17 blocks placed/);
    assert.equal(hands(bot).length, 12);
  } finally {
    await rm(stateFile, { force: true });
  }
});

test('hop timeout cancels the in-flight flyTo and tries the next hover candidate', { timeout: 10000 }, async () => {
  const bot = new StudioBot();
  let calls = 0;
  let cancelledHop = null;
  const origFlyTo = bot.creative.flyTo.bind(bot.creative);
  bot.creative.flyTo = destination => {
    calls++;
    if (calls === 1) {
      return new Promise(resolve => {
        bot.once('move', () => {
          cancelledHop = destination.clone();
          resolve();
        });
      });
    }
    return origFlyTo(destination);
  };
  const outcome = await flyToPhysicalPlacement(bot, new Vec3(10, 75, 10), { hopTimeoutMs: 30 });
  assert.equal(outcome.ok, true);
  assert.ok(calls >= 2);
  assert.deepEqual(cancelledHop, new Vec3(0.5, 64, 0.5));
});

test('a hung flyTo that outlives cancel grace does not brick subsequent flight attempts', { timeout: 10000 }, async () => {
  const bot = new StudioBot();
  let calls = 0;
  const origFlyTo = bot.creative.flyTo.bind(bot.creative);
  bot.creative.flyTo = destination => {
    calls++;
    if (calls === 1) return new Promise(() => {}); // ignores move and never resolves
    return origFlyTo(destination);
  };
  const outcome = await flyToPhysicalPlacement(bot, new Vec3(10, 75, 10), { hopTimeoutMs: 20 });
  assert.equal(outcome.ok, true);
  assert.ok(calls >= 2);
});

test('standalone place_near_player clears creative studio stock after placing', { timeout: 10000 }, async () => {
  const bot = new StudioBot();
  bot.players.Adalynn = { entity: { position: new Vec3(2.5, 64, 0.5) } };
  const env = { HERMESCRAFT_PHYSICAL_BUILDS: '1', HERMESCRAFT_STUDIO_FLIGHT: '1' };
  const prior = Object.keys(env).map(k => process.env[k]);
  Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
  try {
    const actions = registerHighLevelSkills({}, () => bot);
    const res = await actions.place_near_player({ player: 'Adalynn', item: 'smooth_quartz' });
    assert.match(res.result, /Placed smooth_quartz/);
    assert.deepEqual(bot.inventory.items(), []);
  } finally {
    Object.keys(env).forEach((k, i) => { if (prior[i] == null) delete process.env[k]; else process.env[k] = prior[i]; });
  }
});

test('pre-place recheck occupation during hold counts as an actor wait, not a placement attempt', { timeout: 20000 }, async () => {
  const bot = new StudioBot();
  let holds = 0;
  bot.waitForTicks = async () => {
    holds++;
    // Enter the first target cell during the pre-place hold for 4 placeOne calls
    // (exceeding STUDIO_PLACE_ATTEMPTS=3), clearing before the next approach.
    if (holds <= 16 && holds % 4 === 0) {
      bot.players.Steve = { entity: { position: new Vec3(10.5, 64, 10.5) } };
    }
  };
  const origStartFlying = bot.creative.startFlying.bind(bot.creative);
  bot.creative.startFlying = () => {
    delete bot.players.Steve;
    return origStartFlying();
  };
  const result = await studio(bot, FLAGPOLE);
  assert.match(result.result, /20\/20 blocks placed/);
  assert.equal(holds > 16, true);
});
