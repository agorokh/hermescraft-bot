// Build-request contract rules (hermescraft#501). Router-level behavior for the
// frozen phrases lives in intent_router_nlp_v2.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestContract, unsupportedBuildReply } from '../lib/build_request_contract.js';

const status = (body, opts) => buildRequestContract(body, opts).status;

test('library structures and body capabilities are supported', () => {
  for (const body of [
    'can you build a 5-tall stone tower right here? square base, stack it up please',
    'can you build a small house for me here? cozy little one',
    'design a small flower garden next to me — poppies and dandelions please',
    'can you build a treehouse here? use the oak in your inventory',
    'build a fairy treehouse and name it Aurora',
    'build a fancy castle with battlements',
    'build a house of ice',
    'build me a tower 4 tall',
    'build a 10 blocks high tower',
    'build the tallest tower ever',
    'build a market square at base y 65',
    'build a raised sky bridge',
    'build me a huge fancy hotel right here',
    'build a houseee',
    'build me a treehouse with the oak you have',
    'build a house with windows and a door',
  ]) {
    assert.equal(status(body), 'supported', body);
  }
});

test('structures the library does not contain are unsupported', () => {
  for (const [body, reason] of [
    ['build me a pirate ship', 'not_in_library'],
    ['build me a statue of a cat', 'not_in_library'],
    ['lets build the eiffel tower', 'modifier:eiffel'],
    ['Rosie design a castle with a moat', 'feature:moat'],
    ['build me a house boat', 'trailing:boat'],
    ['build a tower bridge', 'trailing:bridge'],
  ]) {
    const c = buildRequestContract(body);
    assert.equal(c.status, 'unsupported', body);
    assert.equal(c.reason, reason, body);
  }
});

test('"make" is a build verb only when the classifier picked a build intent', () => {
  assert.equal(status('make me a sword'), 'none');
  assert.equal(status('make me a sword', { nlpIntent: 'gather_block' }), 'none');
  assert.equal(status('make a roller coaster', { nlpIntent: 'plant_flowers' }), 'unsupported');
  assert.equal(status('make me a nether portal', { nlpIntent: 'plant_flowers' }), 'unsupported');
  assert.equal(status('make me a watchtower', { nlpIntent: 'build_schematic' }), 'supported');
  assert.equal(status('make flowers', { nlpIntent: 'plant_flowers' }), 'supported');
});

test('sentences that are not build commands are left to the router', () => {
  for (const body of [
    'what did we build yesterday',
    'should we build a sky bridge someday?',
    'dont build a tower',
    'no dont build anything',
    'i love when we build stuff together',
    'build a uhh',
    'build another',
    'build 10 tall pls',
    'build it here',
    'i love building towers',
    'how do you build a rocket',
  ]) {
    assert.equal(status(body), 'none', body);
  }
  assert.equal(status('make it bright', { nlpIntent: 'build_tower' }), 'none');
  assert.equal(status('make a tall thingy', { nlpIntent: 'build_tower' }), 'none');
});

test('survival intents keep their own capability path', () => {
  assert.equal(status('build a wall its night', { nlpIntent: 'build_shelter_for_night' }), 'none');
  assert.equal(status('build a wheat farm', { nlpIntent: 'farm_food' }), 'none');
});

test('the companion name may trail the object', () => {
  assert.equal(status('build me a house rosie'), 'supported');
  assert.equal(status('build me a house pip', { names: ['Pip'] }), 'supported');
});

test('refusal names the request and offers the library', () => {
  const text = unsupportedBuildReply(buildRequestContract('Rosie design a castle with a moat'));
  assert.match(text, /^I can't build a castle with a moat yet\. I can build a house, treehouse, tower/);
  assert.ok(text.length < 256, 'fits one Minecraft chat line');
  const eiffel = unsupportedBuildReply(buildRequestContract('lets build the eiffel tower'));
  assert.match(eiffel, /^I can't build an eiffel tower yet\./);
});
