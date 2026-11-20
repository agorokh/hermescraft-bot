// `mc cancel` during a studio co-build (agorokh/hermescraft#592).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cancelBackgroundTask, STUDIO_KEEPS_GOING } from '../lib/task_cancel.js';

function body() {
  const goals = [];
  return { goals, _stopGeneration: 4, _actionEpoch: 9, interrupt_code: false, digStops: 0,
    pathfinder: { setGoal: g => goals.push(g) }, stopDigging() { this.digStops++; } };
}

test('outside a co-build, cancel stops the body as before', () => {
  const bot = body();
  const task = { status: 'running' };
  assert.equal(cancelBackgroundTask(bot, task, false), 'Task cancelled.');
  assert.equal(bot._stopGeneration, 5);
  assert.equal(bot._actionEpoch, 10);
  assert.equal(bot.interrupt_code, true);
  assert.deepEqual(bot.goals, [null]);
  assert.equal(bot.digStops, 1);
  assert.equal(task.status, 'cancelled');
});

test('during a co-build, a brain cancelling its own task interrupts it but leaves the co-build running', () => {
  const bot = body();
  const task = { status: 'running', action: 'bg_goto' };
  const result = cancelBackgroundTask(bot, task, true);
  assert.equal(task.status, 'cancelled');
  assert.deepEqual(bot.goals, [null], 'a walk loses its goal');
  assert.equal(bot.digStops, 1, 'digging stops');
  assert.equal(bot._actionEpoch, 10, 'epoch-bound loops (fishing, farming) end');
  assert.equal(bot.interrupt_code, true);
  assert.equal(bot._stopGeneration, 4, 'the co-build sees no stop');
  assert.ok(result.endsWith(STUDIO_KEEPS_GOING));
});

test('during a co-build, cancel never touches the co-build\'s own task', () => {
  const bot = body();
  const task = { status: 'running', action: 'studio_build' };
  const result = cancelBackgroundTask(bot, task, true);
  assert.equal(task.status, 'running', 'the task slot stays taken, so no second task can start beside it');
  assert.deepEqual(bot.goals, []);
  assert.equal(bot._stopGeneration, 4);
  assert.equal(bot._actionEpoch, 9);
  assert.match(result, /^Nothing cancelled: the running task is the studio build\./);
});

test('during a co-build with nothing running, cancel stops nothing and says how to end it', () => {
  const bot = body();
  const done = { status: 'done' };
  const result = cancelBackgroundTask(bot, done, true);
  assert.equal(done.status, 'done');
  assert.equal(bot._stopGeneration, 4);
  assert.match(result, /^No background task to cancel\. .*mc stop ends it/);
  assert.match(cancelBackgroundTask(bot, null, true), /^No background task to cancel/);
});

test('the server routes /task/cancel through the helper and asks whether this body is in a co-build', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("if (path === '/task/cancel')");
  const handler = server.slice(start, server.indexOf('\n      }', start));
  assert.match(handler, /_studio_owner === b && Boolean\(_studio\?\.isActive\?\.\(\)\)/);
  assert.match(handler, /cancelBackgroundTask\(b, currentTask, studioActive\)/);
  assert.doesNotMatch(handler, /_stopGeneration/);
});
