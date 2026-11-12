import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHighLevelSkills } from '../lib/skills.js';
import { tryRoute as routeRegex } from '../lib/intent_router.js';
import { tryRoute as routeNlp } from '../lib/intent_router_nlp.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

for (const actor of ['player', 'character']) {
  test(`raised slope foundation refuses a ${actor} below the build base before any command`, async () => {
    const bot = new WorldBot(p => p.y <= (p.x === 12 ? 67 : 63) ? ground() : air());
    const position = { x: 10.5, y: 64, z: 10.5 };
    if (actor === 'player') bot.players.Arsenyzzz.entity.position = position;
    else bot.entity.position = position;
    const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10 });
    assert.equal(result.site_refused, true);
    assert.match(result.result, /standing in the build space/);
    assert.deepEqual(bot.commands, []);
  });
}

test('fixed-base recheck excludes the foundation slab, including an entity crossing its edge', () => {
  const params = { blockAt: (x, y) => y <= (x === 12 ? 67 : 63) ? ground() : air(),
    footprint: [3, 3], height: 4, origin: { x: 10, y: 68, z: 10 } };
  for (const position of [{ x: 10.5, y: 64, z: 10.5 }, { x: 9.8, y: 64, z: 10.5 }]) {
    const site = validateSchematicSite({ ...params, occupied: [position] });
    assert.equal(site.code, 'occupied_player');
  }
  assert.equal(validateSchematicSite({ ...params, occupied: [{ x: 9.5, y: 64, z: 10.5 }] }).ok, true);
  assert.equal(validateSchematicSite({ ...params, occupied: [{ x: 10.5, y: 62, z: 10.5 }] }).ok, true);
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

test('automatic placement raises above a supported natural slope and fills its low side', async () => {
  const bot = new WorldBot(p => p.x >= 10 && p.x <= 12 && p.z >= 10 && p.z <= 12
    && p.y <= 63 + (p.x - 10) * 2 ? ground() : air());
  const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10,
    auto_site: { x: 8, y: 64, z: 11 } });
  assert.match(result.result, /Built schematic "well" at 10,68,10/);
  assert.ok(bot.commands.some(c => /^\/setblock 10 64 10 /.test(c)));
});

test('an elevated fixed-base build can support itself through water onto natural ground', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground()
    : p.y <= 65 ? { name: 'water', boundingBox: 'empty' } : air());
  const result = await build(bot, { name: 'well', x: 10, y: 66, z: 10, respect_explicit_base_y: true });
  assert.match(result.result, /Built schematic "well" at 10,66,10/);
  assert.ok(bot.commands.some(c => /^\/setblock 10 64 10 /.test(c)));
});

test('water in build space and lava beneath it remain unsafe', () => {
  const watery = (_x, y) => y <= 63 ? ground() : y <= 65 ? { name: 'water', boundingBox: 'empty' } : air();
  const params = { footprint: [3, 3], height: 4, origin: { x: 10, y: 64, z: 10 } };
  assert.equal(validateSchematicSite({ ...params, blockAt: watery }).code, 'occupied');
  const lava = (_x, y) => y <= 63 ? ground() : y <= 65 ? { name: 'lava', boundingBox: 'empty' } : air();
  assert.equal(validateSchematicSite({ ...params, origin: { x: 10, y: 66, z: 10 }, blockAt: lava }).code, 'occupied_ground');
});

test('an unloaded automatic site reports waiting for chunks rather than demanding more ground', async () => {
  const bot = new WorldBot(() => null);
  const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10,
    auto_site: { x: 8, y: 64, z: 11 } });
  assert.equal(result.site_code, 'unknown');
  assert.match(publicActionResult('build_schematic', result, { failed: true }), /loaded.*closer/i);
  assert.deepEqual(bot.commands, []);
});

test('occupied-player refusal exposes the actual step-aside recovery', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground() : air());
  const result = await build(bot, { name: 'well', x: 0, y: 64, z: 0 });
  assert.equal(result.site_code, 'occupied_player');
  assert.match(publicActionResult('build_schematic', result, { failed: true }), /step aside/i);
  assert.deepEqual(bot.commands, []);
});

test('structure refusal exposes a different-site recovery without suggesting missing ground', async () => {
  const bot = new WorldBot(p => p.y <= 63 ? ground()
    : p.x === 10 && p.z === 10 && p.y === 65 ? { name: 'oak_planks', boundingBox: 'block' } : air());
  const result = await build(bot, { name: 'well', x: 10, y: 64, z: 10 });
  assert.equal(result.site_code, 'occupied_ground');
  assert.match(publicActionResult('build_schematic', result, { failed: true }), /structure.*another spot/i);
  assert.deepEqual(bot.commands, []);
});

test('automatic build refuses when no supported footprint fits, rather than falling back', async () => {
  const bot = new WorldBot(() => air());
  const result = await build(bot, { name: 'campfire_spot', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 } });
  assert.match(result.result, /couldn't find a safe/i);
  assert.deepEqual(bot.commands, []);
});

test('a requested campfire can use clear island ground twelve blocks from a crowded player area', async () => {
  const bot = new WorldBot(p => p.y === 63 && p.x >= 10 && p.x <= 14
    && p.z >= -2 && p.z <= 2 ? ground() : air());
  const result = await build(bot, { name: 'campfire_spot', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 } });
  assert.match(result.result, /Built schematic "campfire_spot" at 10,64,-2/);
  assert.equal(bot.blocks.size, 13);
  assert.ok([...bot.blocks.keys()].every(key => {
    const [x, y, z] = key.split(',').map(Number);
    return x >= 10 && x <= 14 && y === 64 && z >= -2 && z <= 2;
  }));
});

test('automatic campfire search still refuses a clear site beyond the nearby island limit', async () => {
  const bot = new WorldBot(p => p.y === 63 && p.x >= 17 && p.x <= 21
    && p.z >= -2 && p.z <= 2 ? ground() : air());
  const result = await build(bot, { name: 'campfire_spot', x: 2, y: 64, z: 0,
    auto_site: { x: 0, y: 64, z: 0 } });
  assert.equal(result.site_refused, true);
  assert.deepEqual(bot.commands, []);
});

test('the saved crowded starter island supports two requested campfires without changing existing blocks', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/starter_island_campfire.json', import.meta.url)));
  const definitions = createRequire(import.meta.url)('minecraft-data')('1.21.11').blocksByName;
  const cells = new Map();
  for (const [y, z, startX, endX, palette] of fixture.runs) {
    for (let x = startX; x <= endX; x++) cells.set(`${x},${y},${z}`, palette);
  }
  const terrain = p => {
    const b = fixture.bounds;
    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY
      || p.z < b.minZ || p.z > b.maxZ) return null;
    const palette = cells.get(`${p.x},${p.y},${p.z}`) ?? 0;
    if (palette < 0) return null;
    const name = fixture.names[palette];
    return { name, boundingBox: definitions[name]?.boundingBox ?? 'unknown' };
  };
  const bot = new WorldBot(terrain);
  bot.entity.position = fixture.rosie;
  bot.players.Arsenyzzz.entity.position = fixture.anchor;
  bot.players.Steve = { entity: { position: fixture.steve, username: 'Steve' } };
  const request = { name: 'campfire_spot', x: 4002, y: 87, z: 4002, auto_site: fixture.anchor };
  const first = await build(bot, request);
  assert.match(first.result, /Built schematic "campfire_spot" at 3988,85,4000/);
  assert.equal(bot.blocks.size, 13);
  const firstBlocks = new Map(bot.blocks);
  const second = await build(bot, request);
  assert.match(second.result, /Built schematic "campfire_spot" at 3988,85,4005/);
  assert.equal(bot.blocks.size, 26);
  for (const [key, name] of firstBlocks) assert.equal(bot.blocks.get(key), name);
  for (const key of bot.blocks.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    assert.equal(terrain({ x, y, z }).name, 'air', `existing island cell changed: ${key}`);
    assert.equal(terrain({ x, y: y - 1, z }).name, 'stone');
  }
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

test('no-room site refusal is a failed action with actionable public feedback', () => {
  const result = { result: 'Couldn\'t find a safe site. Nothing was built.', site_refused: true, site_code: 'no_room' };
  const failed = actionOutcomeFailed(result);
  assert.equal(failed, true);
  assert.match(publicActionResult('build_schematic', result, { failed }), /clear natural ground/);
});
