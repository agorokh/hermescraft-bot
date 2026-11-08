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
    'build a house w/ a door',
  ]) {
    assert.equal(status(body), 'supported', body);
  }
});

// Review of PR #25: ordinary descriptive requests must not be refused.
test('descriptive modifiers, sizes, possessives and relative clauses stay supported', () => {
  for (const body of [
    'build a log cabin', 'build a modern house', 'build a haunted house', 'build a candy house',
    'build a wishing well', 'build a medieval castle', 'build a princess castle',
    'build a lookout tower', 'build an even bigger tower', 'build a two story house',
    'build a five story tower', 'build a 3x3 tower', 'build a 10x10 house',
    "build a wizard's tower", 'build a wizards tower', 'build a tower of wizards',
    'build a castle with towers', 'build a tower thats 10 blocks high', 'build a tower that is tall',
    'build a castle made of ice', 'build a house made of stone', 'build a house i can sleep in',
    'build a house we can live in', 'build a well with water',
  ]) {
    assert.equal(status(body), 'supported', body);
  }
});

test('structures and parts the library does not contain are unsupported', () => {
  for (const [body, reason] of [
    ['build me a pirate ship', 'not_in_library'],
    ['build me a statue of a cat', 'not_in_library'],
    ['lets build the eiffel tower', 'named:eiffel'],
    ['Rosie design a castle with a moat', 'feature:moat'],
    ['build me a house boat', 'trailing:boat'],
    ['build a tower bridge', 'trailing:bridge'],
    ['build a hotel with a pool', 'feature:pool'],
    ['build a garden with a fountain', 'feature:fountain'],
  ]) {
    const c = buildRequestContract(body);
    assert.equal(c.status, 'unsupported', body);
    assert.equal(c.reason, reason, body);
  }
});

// Review of PR #25: punctuation, coordination, comparison and a second verb
// must not smuggle an unsupported part past the check.
test('every object of every build verb is checked', () => {
  for (const body of [
    'build a castle, with a moat', 'build a castle (with a moat)', 'build a castle - with a moat',
    'build a castle w/ a moat', 'build a castle w a moat', 'build a castle with moat',
    'build a castle and a moat', 'build a castle and also a moat', 'build a castle plus a moat',
    'build a house and a pirate ship', 'build a house then a pirate ship',
    'build a house. build a pirate ship', 'build a house build a pirate ship',
    'build me a tower like the eiffel tower',
  ]) {
    assert.equal(status(body), 'unsupported', body);
  }
});

// Review of PR #25 round 3: the named structure is the resolver's reading of the
// whole object, never of the whole sentence.
test('schematic is resolved from the whole object, not the head alone or the sentence', () => {
  for (const [body, schematic] of [
    ['build a house of ice', 'ice_castle'],
    ['build a tower of wizards', 'wizard_tower'],
    ['build a castle made of ice', 'ice_castle'],
    ['build a wizard tower', 'wizard_tower'],
    ['build a garden near the hotel', 'garden'],
    ['build a garden in front of the observatory', 'garden'],
    ['build a small house for me here', 'small_house'],
  ]) {
    const c = buildRequestContract(body);
    assert.equal(c.status, 'supported', body);
    assert.equal(c.schematic, schematic, body);
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
    "you can't build a pirate ship",
    'i love when we build stuff together',
    'build a uhh',
    'build another',
    'build 10 tall pls',
    'build it here',
    'i love building towers',
    'how do you build a rocket',
    'do you know how to build a house',
    'stop! build me a rocket',
    'build a house nvm',
  ]) {
    assert.equal(status(body), 'none', body);
  }
  assert.equal(status('make it bright', { nlpIntent: 'build_tower' }), 'none');
  assert.equal(status('make a tall thingy', { nlpIntent: 'build_tower' }), 'none');
});

test('stop and survival intents are never overridden', () => {
  assert.equal(status('stop, build a pirate ship', { nlpIntent: 'stop' }), 'none');
  assert.equal(status('build a wall its night', { nlpIntent: 'build_shelter_for_night' }), 'none');
  assert.equal(status('build a wheat farm', { nlpIntent: 'farm_food' }), 'none');
});

test('framed marks a request to the companion, not narration', () => {
  assert.equal(buildRequestContract('can you build a pirate ship').framed, true);
  assert.equal(buildRequestContract('lets build the eiffel tower').framed, true);
  assert.equal(buildRequestContract('rosie build me a pirate ship').framed, true);
  assert.equal(buildRequestContract('my brother wants to build a pirate ship').framed, false);
  assert.equal(buildRequestContract('i wanna see you build a house later').framed, false);
});

test('the companion name may trail the object', () => {
  assert.equal(status('build me a house rosie'), 'supported');
  assert.equal(status('build me a house pip', { names: ['Pip'] }), 'supported');
});

test('refusal names the request and offers what the library can build', () => {
  const moat = unsupportedBuildReply(buildRequestContract('Rosie design a castle with a moat'));
  assert.equal(moat, "I can't build a castle with a moat yet. I can build a small tower, though.");
  const eiffel = unsupportedBuildReply(buildRequestContract('lets build the eiffel tower'));
  assert.equal(eiffel, "I can't build an eiffel tower yet. I can build a small tower, though.");
  const ship = unsupportedBuildReply(buildRequestContract('build me a pirate ship'));
  assert.match(ship, /^I can't build a pirate ship yet\. I can build a house, treehouse, tower/);
  assert.ok(ship.length < 256, 'fits one Minecraft chat line');
});

test('malformed input does not throw', () => {
  for (const body of [null, undefined, 42, {}, 'build', 'build ((((', 'build with with of of']) {
    assert.doesNotThrow(() => buildRequestContract(body, { names: [undefined, null, 5] }));
  }
});
