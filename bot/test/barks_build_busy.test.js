import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { installBarksAndPresence } from '../lib/barks.js';

test('proximity gaze leaves physical placement aim alone until the build finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const bot = new EventEmitter();
  const looks = [];
  bot.username = 'Rosie';
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.entities = { 1: { type: 'player', username: 'KidOne', position: new Vec3(3, 64, 0) } };
  bot.lookAt = async (position) => { looks.push(position); };
  bot.chat = () => {};
  bot._schematicBuildActive = true;
  const down = installBarksAndPresence(bot);
  try {
    t.mock.timers.tick(2000);
    await Promise.resolve();
    assert.deepEqual(looks, [], 'the gaze timer cannot replace the block placement aim');
    bot._schematicBuildActive = false;
    t.mock.timers.tick(2000);
    await Promise.resolve();
    assert.deepEqual(looks, [new Vec3(3, 65.6, 0)], 'normal player gaze resumes after the build');
  } finally { down(); }
});
