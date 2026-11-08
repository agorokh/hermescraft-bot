// Regex-router guard for the build-request contract (hermescraft#501).
// server.js passes every regex route through lib/build_request_guard.js, in
// regex-primary mode (HERMES_NLP_PRIMARY=0) and in the NLP-primary fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { guardRegexBuildRoute, routeRegexPrimary } from '../lib/build_request_guard.js';
import { checkBuildRequest } from '../lib/intent_router_nlp.js';
import { tryRoute as tryRouteRegex } from '../lib/intent_router.js';

let n = 0;
function stubBot(senderName = 'Adalynn', opts = {}) {
  const senderEntity = { type: 'player', username: senderName, position: { x: 0, y: 64, z: 0 } };
  return {
    username: opts.bot || `GuardBot${++n}`,
    entity: opts.noEntity ? null : { position: { x: 5, y: 64, z: 5 }, yaw: 0 },
    players: opts.noEntity ? {} : { [senderName]: { entity: senderEntity } },
    entities: opts.noEntity ? {} : { 1: senderEntity },
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }, { name: 'cobblestone', count: 64 }] },
    blockAt: () => ({ name: 'air' }),
  };
}

const guarded = async (bot, body) => guardRegexBuildRoute(bot, body, 'Adalynn', await tryRouteRegex(bot, body, 'Adalynn'));

test('regex build of an unsupported request becomes a handled refusal', async () => {
  const bot = stubBot();
  const raw = await tryRouteRegex(bot, 'lets build the eiffel tower', 'Adalynn');
  assert.equal(raw.action, 'build_tower', 'precondition: the regex router builds the pillar');
  const r = await guarded(bot, 'lets build the eiffel tower');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'chat');
  assert.equal(r.nlp_zone, 'build_unsupported');
});

test('regex build of a different structure is remapped to the one the object names', async () => {
  const bot = stubBot();
  const raw = await tryRouteRegex(bot, 'build a garden near the hotel', 'Adalynn');
  assert.equal(raw.body?.name, 'grand_hotel', 'precondition: the regex router picks the hotel');
  const r = await guarded(bot, 'build a garden near the hotel');
  assert.equal(r.matched, true);
  assert.equal(r.action, 'build_schematic');
  assert.equal(r.body.name, 'garden');
  assert.equal(r.nlp_zone, 'catalog_remap');
});

test('a remap that cannot be anchored is a handled refusal, not a silent drop', async () => {
  const bot = stubBot('Adalynn', { noEntity: true });
  const route = { matched: true, intent_name: 'build_schematic', action: 'build_schematic_advanced', body: { name: 'grand_hotel', x: 0, y: 64, z: 0 } };
  const r = await guardRegexBuildRoute(bot, 'build a garden near the hotel', 'Adalynn', route);
  assert.equal(r.matched, true);
  assert.equal(r.action, 'chat');
  assert.equal(r.nlp_zone, 'build_unsupported');
});

test('matching regex builds and non-build routes pass unchanged', async () => {
  const bot = stubBot();
  const house = await tryRouteRegex(bot, 'build a small house here', 'Adalynn');
  assert.deepEqual(await guardRegexBuildRoute(bot, 'build a small house here', 'Adalynn', house), house);
  const chat = { matched: true, intent_name: 'report_position', action: 'chat', body: { text: 'at 0 64 0' } };
  assert.equal(await guardRegexBuildRoute(bot, 'where are you', 'Adalynn', chat), chat);
  const none = { matched: false };
  assert.equal(await guardRegexBuildRoute(bot, 'hello', 'Adalynn', none), none);
});

test('regex-primary: an unmatched framed unsupported request is refused', async () => {
  const bot = stubBot();
  const r = await routeRegexPrimary(bot, 'build me a pirate ship', 'Adalynn', tryRouteRegex);
  assert.equal(r.matched, true);
  assert.equal(r.nlp_zone, 'build_unsupported');
});

test('regex-primary: narration is not refused', async () => {
  const r = await routeRegexPrimary(stubBot(), 'my brother wants to build a pirate ship', 'Adalynn', tryRouteRegex);
  assert.notEqual(r.nlp_zone, 'build_unsupported');
});

test('regex-primary: a remapped build enters the repeat buffer', async () => {
  const bot = stubBot();
  const r = await routeRegexPrimary(bot, 'build a garden near the hotel', 'Adalynn', tryRouteRegex);
  assert.equal(r.nlp_zone, 'catalog_remap');
  assert.equal(typeof r.skill_id, 'number');
});

test("the sender's name never masks a trailing noun", () => {
  const { contract } = checkBuildRequest(stubBot('Boat'), 'build me a house boat', 'Boat');
  assert.equal(contract.status, 'unsupported');
  assert.equal(contract.reason, 'trailing:boat');
});
