// A character reacts to a child's block, not to its own or another character's
// (agorokh/hermescraft#592: about 45 reaction lines per two-character tower).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { installBarksAndPresence } from '../lib/barks.js';

function setup(t, entities) {
  const prior = process.env.HERMESCRAFT_COMPANION_NAMES;
  process.env.HERMESCRAFT_COMPANION_NAMES = 'Rosie,Steve';
  t.after(() => {
    if (prior == null) delete process.env.HERMESCRAFT_COMPANION_NAMES;
    else process.env.HERMESCRAFT_COMPANION_NAMES = prior;
  });
  const bot = new EventEmitter();
  bot.username = 'Rosie';
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.entities = entities;
  bot.lookAt = async () => {};
  bot.lines = [];
  bot.chat = line => bot.lines.push(line);
  t.after(installBarksAndPresence(bot, { characterName: 'Rosie' }));
  return bot;
}

const air = at => ({ name: 'air', position: at });
const iron = at => ({ name: 'iron_block', position: at });

test('a block the other character places draws no reaction', (t) => {
  const bot = setup(t, {
    1: { type: 'player', username: 'Kid', position: new Vec3(10, 64, 0) },
    2: { type: 'player', username: 'Steve', position: new Vec3(-12, 70, 0) },
  });
  const at = new Vec3(-14, 71, 1); // within Steve's hand reach, far from the child
  bot.emit('blockUpdate', air(at), iron(at));
  assert.deepEqual(bot.lines, []);
});

test('a block the character places itself draws no reaction', (t) => {
  const bot = setup(t, { 1: { type: 'player', username: 'Kid', position: new Vec3(10, 64, 0) } });
  const at = new Vec3(2, 65, 1);
  bot.emit('blockUpdate', air(at), iron(at));
  assert.deepEqual(bot.lines, []);
});

test('a block the child places still draws one', (t) => {
  const bot = setup(t, {
    1: { type: 'player', username: 'Kid', position: new Vec3(10, 64, 0) },
    2: { type: 'player', username: 'Steve', position: new Vec3(-12, 70, 0) },
  });
  const at = new Vec3(11, 64, 1);
  bot.emit('blockUpdate', air(at), iron(at));
  assert.equal(bot.lines.length, 1);
});

test('no idle remark while a studio co-build is under way', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const bot = setup(t, { 1: { type: 'player', username: 'Kid', position: new Vec3(3, 64, 0) } });
  bot._studioPlanActive = true;
  t.mock.timers.tick(15_000);
  assert.deepEqual(bot.lines, []);
  bot._studioPlanActive = false;
  bot._studioPlanNearby = true; // its own legs are done, the other character is still building
  t.mock.timers.tick(15_000);
  assert.deepEqual(bot.lines, []);
  bot._studioPlanNearby = false;
  t.mock.timers.tick(15_000);
  assert.equal(bot.lines.length, 1, 'idle remarks resume afterwards');
});

test('when a child and a character are both in reach, the nearer one owns the block', (t) => {
  const bot = setup(t, {
    1: { type: 'player', username: 'Kid', position: new Vec3(10, 64, 0) },
    2: { type: 'player', username: 'Steve', position: new Vec3(14, 64, 0) },
  });
  const at = new Vec3(11, 64, 0); // 1 from the child, 3 from Steve
  bot.emit('blockUpdate', air(at), iron(at));
  assert.equal(bot.lines.length, 1);
});
