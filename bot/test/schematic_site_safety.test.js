import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHighLevelSkills } from '../lib/skills.js';
import { tryRoute as routeRegex } from '../lib/intent_router.js';
import { tryRoute as routeNlp } from '../lib/intent_router_nlp.js';
import { readFile } from 'node:fs/promises';
import { actionOutcomeFailed, publicActionResult } from '../lib/action_outcome.js';
import { validateSchematicSite } from '../lib/schematic_site.js';

const air = () => ({ name: 'air', boundingBox: 'empty' });
const ground = () => ({ name: 'grass_block', boundingBox: 'block' });

class WorldBot extends EventEmitter {
  constructor(terrain) {
    super();
    this.terrain = terrain;
    this.blocks = new Map();
    this.commands = [];
    this.username = 'Rosie';
    this.entity = { position: { x: 0, y: 64, z: 0 } };
    this.players = { Arsenyzzz: { entity: { position: { x: 0, y: 64, z: 0 }, username: 'Arsenyzzz' } } };
    this.inventory = { items: () => [] };
  }
  blockAt(p) {
    const placed = this.blocks.get(`${p.x},${p.y},${p.z}`);
    return placed ? { name: placed, boundingBox: 'block' } : this.terrain(p);
  }
  chat(command) {
    this.commands.push(command);
    const m = command.match(/^\/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/);
    if (!m) return;
    this.blocks.set(`${m[1]},${m[2]},${m[3]}`, m[4].replace(/^minecraft:/, ''));
    queueMicrotask(() => this.emit('message', { toString: () => `Changed the block at ${m[1]}, ${m[2]}, ${m[3]}` }, 'system'));
  }
}

async function build(bot, body) {
  const prior = process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
  const fallback = process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
  process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = '1';
  process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = '1';
  try {
    return await registerHighLevelSkills({}, () => bot).build_schematic(body);
  } finally {
    if (prior == null) delete process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH;
    else process.env.HERMESCRAFT_TRUST_SETBLOCK_AUTH = prior;
    if (fallback == null) delete process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK;
    else process.env.HERMESCRAFT_ALLOW_SETBLOCK_CHAT_FALLBACK = fallback;
  }
}

test('explicit well refuses an island-edge footprint with unsupported columns before any command', async () => {
  const bot = new WorldBot(p => p.y <= 63 && p.x === 10 ? ground() : air());
  const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10 });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('explicit ordinary build cannot enclose a player or character standing in the footprint', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : air());
  const result = await build(bot, { name: 'well', x: 0, y: 64, z: 0 });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('automatic well finds a fully supported nearby alternative instead of building over void', async () => {
  const bot = new WorldBot(p => p.y <= 63 && p.x >= -5 && p.x <= -1 && p.z >= -2 && p.z <= 2 ? ground() : air());
  const result = await build(bot, { name: 'well', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 } });
  assert.match(result.result, /Built schematic "well"/);
  const schematic = bot.commands.filter(c => /cobblestone|water/.test(c));
  assert.equal(schematic.length, 25);
  assert.ok(schematic.every(c => { const [, x,, z] = c.split(' '); return Number(x) >= -5 && Number(x) <= -1 && Number(z) >= -2 && Number(z) <= 2; }));
});

test('automatic build refuses when no supported footprint fits, rather than falling back', async () => {
  const bot = new WorldBot(() => air());
  const result = await build(bot, { name: 'campfire_spot', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 } });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('automatic requests cannot bypass site safety by adding skip_foundation', async () => {
  const bot = new WorldBot(() => air());
  const result = await build(bot, { name: 'well', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 }, skip_foundation: true });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('site preflight bounds foundation demand instead of approving a later skipped foundation', () => {
  const blockAt = (_x, y) => y <= 63 ? ground() : air();
  const site = validateSchematicSite({ blockAt, footprint: [17, 17], height: 2,
    origin: { x: 0, y: 80, z: 0 } });
  assert.equal(site.ok, false);
  assert.equal(site.code, 'foundation_size');
  const bounded = validateSchematicSite({ blockAt, footprint: [16, 16], height: 2,
    origin: { x: 0, y: 80, z: 0 } });
  assert.equal(bounded.ok, true);
});

test('foundation planning keeps an automatically checked site below a distant roof', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : (p.y === 74 ? { name: 'cobblestone', boundingBox: 'block' } : air()));
  const result = await build(bot, { name: 'well', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 } });
  assert.match(result.result, /Built schematic "well" at -?\d+,64,-?\d+/);
  assert.ok(bot.commands.every(c => Number(c.split(' ')[2]) <= 67));
});

test('automatic build does not select the clear roof of an existing cobblestone house', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : (p.y === 67 ? { name: 'cobblestone', boundingBox: 'block' } : air()));
  const result = await build(bot, { name: 'well', x: 2, y: 68, z: 0,
    auto_site: { x: 0, y: 68, z: 0 } });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('explicit ordinary build refuses occupied space instead of raising itself onto the object', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : (p.x === 10 && p.z === 10 && p.y === 65 ? { name: 'oak_planks', boundingBox: 'block' } : air()));
  const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10 });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('unknown or unloaded cells cannot qualify as clear space', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : null);
  const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10 });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('both routers carry the original player anchor for automatic library placement', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : air());
  for (const router of [routeRegex, routeNlp]) {
    const route = await router(bot, 'Rosie build a campfire', 'Arsenyzzz');
    assert.equal(route.action, 'build_schematic');
    assert.deepEqual(route.body.auto_site, { x: 0, y: 64, z: 0 });
  }
});

test('automatic placement follows a later here request at the player new position', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : air());
  await routeNlp(bot, 'Rosie build a campfire', 'Arsenyzzz');
  bot.players.Arsenyzzz.entity.position = { x: 20, y: 65, z: 20 };
  const here = await routeNlp(bot, 'over here', 'Arsenyzzz');
  assert.equal(here.nlp_zone, 'anaphora');
  assert.deepEqual(here.body.auto_site, { x: 20, y: 65, z: 20 });
});

test('automatic placement follows a later left request without mutating its original anchor', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : air());
  const first = await routeNlp(bot, 'Rosie build a campfire', 'Arsenyzzz');
  const left = await routeNlp(bot, 'to the left', 'Arsenyzzz');
  assert.deepEqual(left.body.auto_site, { x: 3, y: 64, z: 0 });
  assert.deepEqual(first.body.auto_site, { x: 0, y: 64, z: 0 });
});

test('campfire template puts the fire on supported ground inside its ring', async () => {
  const data = JSON.parse(await readFile(new URL('../schematics/campfire_spot.json', import.meta.url)));
  assert.equal(data.blocks.length, 13);
  assert.deepEqual(data.blocks.find(b => b[3] === 'campfire'), [2, 0, 2, 'campfire']);
});

test('site refusal is a failed action with actionable public feedback', () => {
  const result = { result: 'Couldn\'t find a safe site: unknown ground. Nothing was built.', site_refused: true };
  const failed = actionOutcomeFailed(result);
  assert.equal(failed, true);
  assert.match(publicActionResult('build_schematic', result, { failed }), /clear natural ground/);
});
