import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { registerHighLevelSkills } from '../lib/skills.js';

const registry = minecraftData('1.21.11');
const { Movements } = pathfinderPkg;

class PhysicalBot extends EventEmitter {
  constructor() {
    super();
    this.registry = registry;
    this.username = 'Rosie';
    this.entity = { position: new Vec3(0.5, 64, 0.5) };
    this.players = { Arsenyzzz: { entity: { position: new Vec3(0.5, 64, -4.5) } } };
    this.blocks = new Map();
    this.trace = [];
    this.stock = new Map([['cobblestone', 8], ['oak_log', 4], ['campfire', 1]]);
    this.inventory = { items: () => [...this.stock].filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count })) };
    this.pathfinder = {
      movements: new Movements(this), goal: null,
      setMovements: value => { this.pathfinder.movements = value; },
      setGoal: goal => { this.pathfinder.goal = goal; this.trace.push({ kind: 'setGoal', goal }); },
      goto: async goal => {
        this.pathfinder.goal = goal;
        this.trace.push({ kind: 'walk', goal, policy: this.pathfinder.movements, owned: !!this._schematicBuildActive,
          from: this.entity.position.clone() });
        await this.onWalk?.(goal);
        if (!this.falseArrival) this.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
        this.pathfinder.goal = null;
      },
    };
    this.originalMovements = this.pathfinder.movements;
  }
  blockAt(p) {
    const name = this.blocks.get(`${p.x},${p.y},${p.z}`) || (p.y <= 63 ? 'stone' : 'air');
    return { name, type: registry.blocksByName[name]?.id, position: p.clone(),
      boundingBox: name === 'air' || name === 'campfire' ? 'empty' : 'block',
      getProperties: () => ({}) };
  }
  chat(text) {
    this.trace.push({ kind: 'chat', text });
    const m = text.match(/^\/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/);
    if (m) {
      this.blocks.set(`${m[1]},${m[2]},${m[3]}`, m[4].replace(/^minecraft:/, ''));
      queueMicrotask(() => this.emit('message', { toString: () => `Changed the block at ${m[1]}, ${m[2]}, ${m[3]}` }, 'system'));
    }
  }
  async equip(item) { this.heldItem = item; this.trace.push({ kind: 'equip', item: item.name }); }
  async lookAt(position) { this.trace.push({ kind: 'look', position }); }
  async waitForTicks() {}
  clearControlStates() { this.trace.push({ kind: 'clearControls' }); }
  async placeBlock(reference, face) {
    const target = reference.position.plus(face);
    this.trace.push({ kind: 'hand', target, position: this.entity.position.clone(), item: this.heldItem?.name });
    if (!this.wrongReadback) this.blocks.set(`${target.x},${target.y},${target.z}`, this.heldItem.name);
    this.stock.set(this.heldItem.name, this.stock.get(this.heldItem.name) - 1);
  }
}

async function physical(bot, action = 'build_schematic', body = { name: 'campfire_spot', x: 10, y: 64, z: 10 }) {
  const keys = ['HERMESCRAFT_PHYSICAL_BUILDS', 'HERMESCRAFT_TRUST_SETBLOCK_AUTH', 'HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK'];
  const prior = keys.map(k => process.env[k]);
  keys.forEach(k => { process.env[k] = '1'; });
  try {
    return await registerHighLevelSkills({}, () => bot)[action](body);
  } finally {
    keys.forEach((key, i) => { if (prior[i] == null) delete process.env[key]; else process.env[key] = prior[i]; });
  }
}

function soleLivePatchBot() {
  const bot = new PhysicalBot();
  bot.entity.position = new Vec3(3989.5, 85, 4006.5);
  // Mineflayer lists the bot itself among players as well as bot.entity.
  bot.players.Rosie = { entity: bot.entity };
  bot.players.Steve = { entity: { position: new Vec3(3989.5, 85, 4011.5) } };
  bot.players.Arsenyzzz.entity.position = new Vec3(3993.7, 85, 4009.0198);
  const read = bot.blockAt.bind(bot);
  bot.blockAt = position => {
    const value = read(position);
    if (bot.blocks.has(`${position.x},${position.y},${position.z}`)) return value;
    const supported = position.y === 84 && position.x >= 3988 && position.x <= 3992
      && position.z >= 4006 && position.z <= 4010;
    return { ...value, name: supported ? 'stone' : 'air',
      type: registry.blocksByName[supported ? 'stone' : 'air'].id,
      boundingBox: supported ? 'block' : 'empty' };
  };
  return bot;
}

function livePatchRequest(bot) {
  return { name: 'campfire_spot', x: 3995, y: 85, z: 4009,
    auto_site: bot.players.Arsenyzzz.entity.position };
}

for (const buddyCorner of [false, true]) {
  test(`the sole5x5 live patch accepts a physical builder's initial corner${buddyCorner ? ' and a buddy in unused space' : ''}`, async () => {
    const bot = soleLivePatchBot();
    if (buddyCorner) bot.players.Steve.entity.position = new Vec3(3988.5, 85, 4006.5);
    const result = await physical(bot, 'build_schematic', livePatchRequest(bot));
    assert.match(result.result, /Built schematic "campfire_spot" at 3988,85,4006.*13\/13 blocks placed.*physical/);
    assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 13);
    assert.equal(bot.trace.filter(e => e.kind === 'walk').length, 13);
    assert.equal(bot.trace.filter(e => e.kind === 'chat' && e.text.startsWith('/')).length, 0);
  });
}

for (const [label, position] of [
  ['inside a real target', new Vec3(3989.5, 85, 4007.5)],
  ['overhanging a real target from an unused cell', new Vec3(3989.8, 85, 4006.5)],
  ['standing one block above a real target', new Vec3(3990.5, 86, 4008.5)],
]) {
  test(`the sole5x5 physical site refuses a buddy ${label}`, async () => {
    const bot = soleLivePatchBot();
    bot.players.Steve.entity.position = position;
    const result = await physical(bot, 'build_schematic', livePatchRequest(bot));
    assert.equal(result.site_refused, true);
    assert.deepEqual(bot.trace.filter(e => ['walk', 'hand'].includes(e.kind)), []);
    assert.equal(bot.blocks.size, 0);
  });
}

test('physical household build walks and uses its equipped hand for all13 cells even when op', { timeout: 20000 }, async () => {
  const bot = new PhysicalBot();
  const result = await physical(bot);
  assert.equal(bot.trace.filter(e => e.kind === 'chat' && e.text.startsWith('/')).length, 0,
    'physical mode must never probe or place with a remote command');
  assert.match(result.result, /13\/13 blocks placed.*physical/i);
  const hands = bot.trace.filter(e => e.kind === 'hand');
  const walks = bot.trace.filter(e => e.kind === 'walk');
  assert.equal(hands.length, 13);
  assert.equal(walks.length, 13);
  for (const [i, hand] of hands.entries()) {
    assert.ok(hand.position.distanceTo(walks[i].from) > .5, `cell${i} needs an actual walk`);
    assert.ok(hand.position.distanceTo(hand.target.offset(.5, 0, .5)) <= 3, `cell${i} must be nearby`);
    assert.equal(walks[i].policy.canDig, false);
    assert.equal(walks[i].policy.allow1by1towers, false);
    assert.equal(walks[i].policy.allowParkour, false);
    assert.deepEqual(walks[i].policy.scafoldingBlocks, []);
    assert.equal(walks[i].policy.exclusionAreasPlace[0]({}), 100);
    assert.equal(walks[i].policy.exclusionAreasStep.at(-1)({ position: new Vec3(0, 64, -5) }), 100);
    assert.ok(walks[i].policy.blocksToAvoid.has(registry.blocksByName.campfire.id));
  }
  assert.equal(hands.at(-1).item, 'campfire', 'finish the fire after every walk around the ring/seats');
  assert.equal([...bot.stock.values()].reduce((a, b) => a + b, 0), 0);
  assert.equal(bot.pathfinder.movements, bot.originalMovements);
  assert.equal(bot._schematicBuildActive, false);
});

test('physical Foreman does not exempt op inventory or send an auth probe', async () => {
  const bot = new PhysicalBot();
  bot.stock.delete('campfire');
  const result = await physical(bot, 'plan_advanced_build');
  assert.match(result.result, /Foreman rejected.*campfire/i);
  assert.equal(bot.trace.filter(e => e.kind === 'chat').length, 0);
});

for (const floor of ['stone', 'oak_planks']) test(`direct place-beside-player obeys physical policy on ${floor}`, async () => {
  const bot = new PhysicalBot();
  const blockAt = bot.blockAt.bind(bot);
  bot.blockAt = p => p.y === 63 ? { ...blockAt(p), name: floor, type: registry.blocksByName[floor].id } : blockAt(p);
  const keys = ['HERMESCRAFT_PHYSICAL_BUILDS', 'HERMESCRAFT_TRUST_SETBLOCK_AUTH', 'HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK'];
  const prior = keys.map(k => process.env[k]);
  keys.forEach(k => { process.env[k] = '1'; });
  try {
    const result = await registerHighLevelSkills({}, () => bot).place_near_player({ player: 'Arsenyzzz', item: 'cobblestone' });
    assert.match(result.result, /placed/i);
    assert.equal(bot.trace.filter(e => e.kind === 'chat' && e.text.startsWith('/')).length, 0);
    assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 1);
    assert.equal(bot.stock.get('cobblestone'), 7);
    assert.ok(bot.trace.filter(e => e.kind === 'walk').every(e => e.policy.canDig === false && e.owned),
      'even the preliminary approach must be owned and read-only');
    assert.equal(bot.pathfinder.movements, bot.originalMovements);
  } finally {
    keys.forEach((key, i) => { if (prior[i] == null) delete process.env[key]; else process.env[key] = prior[i]; });
  }
});

test('a physical build with missing materials refuses before walking or mutation', async () => {
  const bot = new PhysicalBot();
  bot.stock.delete('campfire');
  const result = await physical(bot);
  assert.match(result.result, /missing.*campfire|campfire.*missing/i);
  assert.deepEqual(bot.trace.filter(e => ['walk', 'hand', 'chat'].includes(e.kind)), []);
});

for (const arrival of ['unreachable', 'false arrival', 'stopped']) {
  test(`physical ${arrival} never falls back to a remote command or hand packet`, async () => {
    const bot = new PhysicalBot();
    if (arrival === 'unreachable') bot.onWalk = async () => { throw new Error('No path to the goal'); };
    if (arrival === 'false arrival') bot.falseArrival = true;
    if (arrival === 'stopped') bot.onWalk = async () => { bot._stopGeneration = 1; };
    const result = await physical(bot);
    assert.doesNotMatch(result.result, /Built schematic/);
    assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 0);
    assert.equal(bot.trace.filter(e => e.kind === 'chat' && e.text.startsWith('/')).length, 0);
    assert.equal(bot.pathfinder.movements, bot.originalMovements);
    assert.equal(bot._schematicBuildActive, false);
  });
}

test('a player entering the second cell during the walk stops at1/13 without replacing them', async () => {
  const bot = new PhysicalBot();
  let count = 0;
  bot.onWalk = async () => {
    if (++count === 2) bot.players.Arsenyzzz.entity.position = new Vec3(11.5, 64, 11.5);
  };
  const result = await physical(bot);
  assert.match(result.result, /after 1\/13/);
  assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 1);
  assert.equal(bot.blocks.has('11,64,11'), false);
  assert.equal(bot.pathfinder.movements, bot.originalMovements);
});

test('hand placement with unchanged world readback is not counted and stops the build', async () => {
  const bot = new PhysicalBot();
  bot.wrongReadback = true;
  const result = await physical(bot);
  assert.doesNotMatch(result.result, /Built schematic/);
  assert.match(result.result, /0\/13/);
  assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 1);
  assert.equal(bot.pathfinder.movements, bot.originalMovements);
});

test('a never-settling path is cancelled on its bounded deadline before policy restoration', { timeout: 12000 }, async () => {
  const bot = new PhysicalBot();
  bot.pathfinder.goto = goal => {
    bot.pathfinder.goal = goal;
    return new Promise(() => {});
  };
  const result = await physical(bot);
  assert.match(result.result, /timed out/);
  assert.equal(bot.pathfinder.goal, null);
  assert.ok(bot.trace.some(e => e.kind === 'clearControls'));
  assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 0);
  assert.equal(bot.pathfinder.movements, bot.originalMovements);
});

test('a stop that installs another action goal does not clear that replacement goal', async () => {
  const bot = new PhysicalBot();
  const replacement = { x: -10, y: 64, z: -10 };
  bot.pathfinder.goto = async () => {
    bot.pathfinder.goal = replacement;
    bot._stopGeneration = 1;
  };
  await physical(bot);
  assert.equal(bot.pathfinder.goal, replacement);
  assert.equal(bot.trace.filter(e => e.kind === 'clearControls').length, 0);
});

test('a manual block arriving during the visible equip pause is preserved', async () => {
  const bot = new PhysicalBot();
  bot.waitForTicks = async () => { bot.blocks.set('10,64,12', 'gold_block'); };
  const result = await physical(bot);
  assert.match(result.result, /0\/13/);
  assert.equal(bot.blocks.get('10,64,12'), 'gold_block');
  assert.equal(bot.trace.filter(e => e.kind === 'hand').length, 0);
});

test('physical build owns the hand over auto-eating and restores the original enabled state', async () => {
  const bot = new PhysicalBot();
  let enabled = true;
  bot.autoEat = {
    get enabled() { return enabled; },
    get isEating() { return false; },
    disableAuto() { enabled = false; },
    enableAuto() { enabled = true; },
  };
  const place = bot.placeBlock.bind(bot);
  bot.placeBlock = async (...args) => { assert.equal(enabled, false); await place(...args); };
  const result = await physical(bot);
  assert.match(result.result, /13\/13 blocks placed/);
  assert.equal(enabled, true);
});
