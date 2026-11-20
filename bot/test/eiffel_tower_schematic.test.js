// The eiffel_tower design and its section builds (agorokh/hermescraft#592).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { registerHighLevelSkills } from '../lib/skills.js';
import { orderForHandPlacement, segmentClear } from '../lib/studio_flight.js';

const registry = minecraftData('1.21.11');
const { Movements } = pathfinderPkg;
const readJson = name => JSON.parse(readFileSync(new URL(`../schematics/${name}`, import.meta.url), 'utf8'));
const tower = readJson('eiffel_tower.json');
const LEGS = ['leg_ne', 'leg_se', 'leg_sw', 'leg_nw'];
const GROUND_Y = 63;
const ORIGIN = { x: 10, y: 64, z: 10 };

test('the tower is 600 blocks, 30 high, in four 150-block legs that cover it exactly', () => {
  assert.equal(tower.blocks.length, 600);
  assert.equal(tower.height, 30);
  assert.deepEqual(tower.footprint, [16, 16]);
  assert.deepEqual(Object.keys(tower.sections), LEGS);
  assert.deepEqual(LEGS.map(leg => tower.sections[leg].blocks), [[0, 150], [150, 300], [300, 450], [450, 600]]);
  assert.equal(new Set(tower.blocks.map(b => b.slice(0, 3).join())).size, 600, 'no cell is listed twice');
  for (const [x, y, z] of tower.blocks) {
    assert.ok(x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y < 30);
  }
});

test('the index entry matches the design', () => {
  const entry = readJson('INDEX.json').schematics.eiffel_tower;
  const materials = {};
  for (const [, , , block] of tower.blocks) materials[block] = (materials[block] || 0) + 1;
  assert.deepEqual(entry.materials, materials);
  assert.deepEqual(tower.materials, materials);
  assert.deepEqual(entry.footprint, tower.footprint);
  assert.equal(entry.height, tower.height);
  for (const block of Object.keys(materials)) assert.ok(registry.itemsByName[block], `${block} is a real item`);
});

test('every leg stands alone from the ground to the tip, and the legs are mirror images', () => {
  const ground = (x, y) => y < 0;
  const shape = leg => {
    const [start, end] = tower.sections[leg].blocks;
    return tower.blocks.slice(start, end);
  };
  for (const leg of LEGS) {
    const cells = shape(leg);
    const { ordered, floating } = orderForHandPlacement(cells, ground);
    assert.deepEqual(floating, [], `${leg} has no cell that hangs in the air`);
    assert.equal(ordered.length, 150);
    assert.equal(Math.min(...cells.map(c => c[1])), 0);
    assert.equal(Math.max(...cells.map(c => c[1])), 29);
  }
  const local = leg => shape(leg).map(([x, y, z, block]) =>
    [x >= 8 ? x - 8 : 7 - x, y, z >= 8 ? z - 8 : 7 - z, block].join()).sort();
  for (const leg of LEGS.slice(1)) assert.deepEqual(local(leg), local('leg_ne'));
});

class StudioBot extends EventEmitter {
  constructor(username, world, position) {
    super();
    this.registry = registry;
    this.username = username;
    this.game = { gameMode: 'creative' };
    this.entity = { position, velocity: new Vec3(0, 0, 0) };
    this.players = { [username]: { entity: this.entity } };
    this.blocks = world;
    this.trace = [];
    this.quickBarSlot = 0;
    const slots = Array(46).fill(null);
    this.inventory = { id: 0, inventoryStart: 9, inventoryEnd: 45, hotbarStart: 36, selectedItem: null,
      slots, items: () => slots.filter(Boolean) };
    this.creative = {
      flyTo: async destination => {
        if (!segmentClear(this, this.entity.position, destination)) this.flewThroughBlock = true;
        this.entity.position = destination.clone();
      },
      setInventorySlot: async (slot, item) => { if (item) item.slot = slot; slots[slot] = item; },
      startFlying: () => { this.flying = true; },
      stopFlying: () => { this.flying = false; },
    };
    this._client = { write: () => {} };
    this.pathfinder = {
      movements: new Movements(this), goal: null,
      setMovements: value => { this.pathfinder.movements = value; },
      setGoal: goal => { this.pathfinder.goal = goal; },
      goto: async () => { this.walked = true; },
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
    this.trace.push({ kind: 'hand', target, position: this.entity.position.clone(),
      reach: eye.distanceTo(target.offset(.5, .5, .5)) });
    this.blocks.set(`${target.x},${target.y},${target.z}`, this.heldItem.name);
  }
}

async function buildLeg(bot, section) {
  const env = { HERMESCRAFT_PHYSICAL_BUILDS: '1', HERMESCRAFT_STUDIO_FLIGHT: '1' };
  const prior = Object.keys(env).map(k => process.env[k]);
  Object.assign(process.env, env);
  try {
    return await registerHighLevelSkills({}, () => bot).build_schematic({ name: 'eiffel_tower', section, ...ORIGIN });
  } finally {
    Object.keys(env).forEach((k, i) => { if (prior[i] == null) delete process.env[k]; else process.env[k] = prior[i]; });
  }
}

const designCells = new Set(tower.blocks.map(([x, y, z]) => `${ORIGIN.x + x},${ORIGIN.y + y},${ORIGIN.z + z}`));
const hands = bot => bot.trace.filter(e => e.kind === 'hand');

function assertLegBuilt(bot, world, section, result) {
  assert.match(result.result, new RegExp(`150/150 blocks placed via physical placement \\(flight\\), section ${section}`));
  const [start, end] = tower.sections[section].blocks;
  for (const [x, y, z, block] of tower.blocks.slice(start, end)) {
    assert.equal(world.get(`${ORIGIN.x + x},${ORIGIN.y + y},${ORIGIN.z + z}`), block);
  }
  assert.ok(hands(bot).every(e => e.reach <= 4.01), 'every block is placed from within hand reach');
  for (const e of hands(bot)) {
    const p = e.position.floored();
    assert.ok(!designCells.has(`${p.x},${p.y},${p.z}`) && !designCells.has(`${p.x},${p.y + 1},${p.z}`),
      'the body never hovers in a cell the tower still needs');
  }
  assert.notEqual(bot.flewThroughBlock, true);
  assert.notEqual(bot.walked, true);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'chat' && e.text.startsWith('/')), []);
}

test('one character builds one 150-block leg to 30 high by hand', { timeout: 120000 }, async () => {
  const world = new Map();
  const bot = new StudioBot('Rosie', world, new Vec3(30.5, 64, 4.5));
  const result = await buildLeg(bot, 'leg_ne');
  assertLegBuilt(bot, world, 'leg_ne', result);
  assert.equal(hands(bot).length, 150);
  assert.equal(world.size, 150, 'nothing outside the leg was placed');
  assert.equal(Math.max(...hands(bot).map(e => e.target.y)), ORIGIN.y + 29);
  assert.deepEqual(bot.trace.filter(e => e.kind === 'chat').map(e => e.text), ["I'm building the north-east leg by hand."]);
});

test('the four legs go up one after another into a whole 600-block tower', { timeout: 300000 }, async () => {
  const world = new Map();
  const rosie = new StudioBot('Rosie', world, new Vec3(30.5, 64, 4.5));
  const steve = new StudioBot('Steve', world, new Vec3(4.5, 64, 30.5));
  for (const [bot, section] of [[rosie, 'leg_ne'], [steve, 'leg_sw'], [rosie, 'leg_se'], [steve, 'leg_nw']]) {
    const before = hands(bot).length;
    const result = await buildLeg(bot, section);
    assertLegBuilt(bot, world, section, result);
    assert.equal(hands(bot).length - before, 150);
  }
  assert.equal(world.size, 600);
  for (const [x, y, z, block] of tower.blocks) {
    assert.equal(world.get(`${ORIGIN.x + x},${ORIGIN.y + y},${ORIGIN.z + z}`), block);
  }
  assert.deepEqual(rosie.trace.filter(e => e.kind === 'chat').map(e => e.text),
    ["I'm building the north-east leg by hand.", "I'm building the south-east leg by hand."]);
  assert.deepEqual(steve.trace.filter(e => e.kind === 'chat').map(e => e.text),
    ["I'm building the south-west leg by hand.", "I'm building the north-west leg by hand."]);
});

test('the whole design is never built in one go: the legs a child takes stay hers', { timeout: 30000 }, async () => {
  const env = { HERMESCRAFT_PHYSICAL_BUILDS: '1', HERMESCRAFT_STUDIO_FLIGHT: '1' };
  const prior = Object.keys(env).map(k => process.env[k]);
  Object.assign(process.env, env);
  try {
    const world = new Map();
    const rosie = new StudioBot('Rosie', world, new Vec3(30.5, 64, 4.5));
    const skills = registerHighLevelSkills({}, () => rosie);
    for (const call of [skills.build_schematic, skills.build_schematic_advanced]) {
      const result = await call({ name: 'eiffel_tower', ...ORIGIN });
      assert.equal(result.site_refused, true);
      assert.match(result.result, /^The Eiffel Tower is built together with the player, one part at a time/);
    }
    assert.equal(world.size, 0, 'nothing placed');
    assert.deepEqual(hands(rosie), []);
    assert.deepEqual(rosie.trace.filter(e => e.kind === 'chat'), []);
  } finally {
    Object.keys(env).forEach((k, i) => { if (prior[i] == null) delete process.env[k]; else process.env[k] = prior[i]; });
  }
});
