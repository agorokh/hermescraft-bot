// Anaphora / context buffer tests (council round 2 unanimous: Gemini's
// "entity slots" + Mistral's "action FIFO"). Short kid modifier phrases
// amend the last fired skill.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoute } from '../lib/intent_router_nlp.js';

function stubBot(name = 'Rosie') {
  return {
    username: name,
    entity: { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: { Adalynn: { entity: { type: 'player', username: 'Adalynn', position: { x: 0, y: 64, z: 0 } } } },
    entities: {},
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'torch', count: 8 }] },
    blockAt: () => ({ name: 'air' }),
  };
}

test('"higher" after tower bumps height +2', async () => {
  const bot = stubBot();
  const first = await tryRoute(bot, 'build me a tower', 'Adalynn');
  assert.equal(first.action, 'build_tower');
  const initialHeight = first.body.height;
  const higher = await tryRoute(bot, 'higher', 'Adalynn');
  assert.equal(higher.nlp_zone, 'anaphora');
  assert.equal(higher.action, 'build_tower');
  assert.equal(higher.body.height, initialHeight + 2, `expected height ${initialHeight + 2}, got ${higher.body.height}`);
});

test('"taller" after tower bumps height', async () => {
  const bot = stubBot('TallerBot');
  await tryRoute(bot, 'build me a tower 4 tall', 'Adalynn');
  const r = await tryRoute(bot, 'taller please', 'Adalynn');
  assert.equal(r.nlp_zone, 'anaphora');
  assert.equal(r.body.height, 6);
});

test('"shorter" after tower decreases height', async () => {
  const bot = stubBot('ShorterBot');
  await tryRoute(bot, 'build me a 10 tall tower', 'Adalynn');
  const r = await tryRoute(bot, 'shorter', 'Adalynn');
  assert.equal(r.nlp_zone, 'anaphora');
  assert.equal(r.body.height, 8);
});

test('"another one" after any build replays', async () => {
  const bot = stubBot('AnotherBot');
  const first = await tryRoute(bot, 'build me a treehouse here', 'Adalynn');
  assert.equal(first.action, 'build_schematic');
  const dup = await tryRoute(bot, 'another one', 'Adalynn');
  assert.equal(dup.nlp_zone, 'anaphora');
  assert.equal(dup.action, 'build_schematic');
  assert.equal(dup.body.name, first.body.name);
});

test('"to the left" shifts last action x-3', async () => {
  const bot = stubBot('LeftBot');
  const first = await tryRoute(bot, 'build me a tower', 'Adalynn');
  const leftX = first.body.x;
  const r = await tryRoute(bot, 'to the left', 'Adalynn');
  assert.equal(r.nlp_zone, 'anaphora');
  assert.equal(r.body.x, leftX - 3);
});

test('"to the left" twice chains -6 from original', async () => {
  const bot = stubBot('LeftChainBot');
  const first = await tryRoute(bot, 'build me a tower', 'Adalynn');
  const leftX = first.body.x;
  const r1 = await tryRoute(bot, 'to the left', 'Adalynn');
  assert.equal(r1.body.x, leftX - 3);
  const r2 = await tryRoute(bot, 'to the left', 'Adalynn');
  assert.equal(r2.body.x, leftX - 6);
});

test('"over there" re-anchors at sender position', async () => {
  const bot = stubBot('HereBot');
  await tryRoute(bot, 'build me a tower', 'Adalynn');
  const r = await tryRoute(bot, 'here', 'Adalynn');
  assert.equal(r.nlp_zone, 'anaphora');
  // Sender stub is at (0,64,0); tower's relocated x should reflect that
  assert.equal(r.body.x, 0);
});

test('anaphora with no prior skill does not replay via anaphora buffer', async () => {
  const bot = stubBot('NoHistoryBot');
  const r = await tryRoute(bot, 'higher', 'Adalynn');
  assert.notEqual(r.nlp_zone, 'anaphora', `anaphora fired without history: action=${r.action}`);
});

test('"do it again" replays amended height after higher', async () => {
  const bot = stubBot('RepeatHeightBot');
  await tryRoute(bot, 'build me a 5 tall tower', 'Adalynn');
  await tryRoute(bot, 'higher', 'Adalynn');
  const again = await tryRoute(bot, 'do it again', 'Adalynn');
  assert.equal(again.action, 'build_tower');
  assert.equal(again.body.height, 7);
});

test('chain: tower → higher → higher (height + 4)', async () => {
  const bot = stubBot('ChainBot');
  const first = await tryRoute(bot, 'build me a 5 tall tower', 'Adalynn');
  assert.equal(first.body.height, 5);
  const h1 = await tryRoute(bot, 'higher', 'Adalynn');
  assert.equal(h1.body.height, 7);
  const h2 = await tryRoute(bot, 'higher', 'Adalynn');
  assert.equal(h2.body.height, 9, `expected height 9 after two "higher", got ${h2.body.height}`);
});
